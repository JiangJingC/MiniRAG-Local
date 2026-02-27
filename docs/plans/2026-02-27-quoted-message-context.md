# Quoted Message Context Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a user quotes the bot's own reply and @-mentions it, include the quoted reply as context in the RAG query so the bot can handle follow-up questions coherently.

**Architecture:** Bot caches its own outgoing markdown replies in an in-memory Map keyed by the DingTalk `msgId` returned in the send response. On inbound messages, if `text.isReplyMsg === true` and `originalMsgId` hits the cache, the cached content is prepended to the user's question before sending to RAG. Cache entries expire after a configurable TTL (default 2 hours) to bound memory usage. All other quote scenarios (user quoting another user's message) fall through to normal handling unchanged.

**Tech Stack:** Node.js CommonJS, `dingtalk-stream` SDK, `fetch` (Node 18+), Vitest for unit tests.

---

### Task 1: Verify sessionWebhook response contains msgId

**Files:**
- Read: `dingtalk/bot.js` (current `reply()` function, already has `[DEBUG:reply-response]` log)

**Step 1: Trigger a normal RAG reply and capture the response log**

Restart bot and send a normal `@` question. Look for the `[DEBUG:reply-response]` line in `/tmp/dingtalk_bot.log`.

Expected response shape (one of):
```json
{"processQueryKey":"...","requestId":"..."}
```
or
```json
{"msgId":"msg...","requestId":"..."}
```

**Step 2: Record the actual field name for msgId in the response**

If the response contains a `msgId` field → we can cache directly from the send response.
If it does NOT → we cannot cache bot replies (plan needs revision before proceeding).

> **STOP HERE** if no msgId in response — report findings before continuing.

---

### Task 2: Extract reply caching logic into `dingtalk/reply-cache.js`

**Files:**
- Create: `dingtalk/reply-cache.js`
- Create: `tests/unit/reply-cache.test.js`

**Step 1: Write the failing test**

```js
// tests/unit/reply-cache.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReplyCache } from '../../dingtalk/reply-cache.js';

describe('ReplyCache', () => {
    let cache;

    beforeEach(() => {
        cache = new ReplyCache({ ttlMs: 1000 });
    });

    it('stores and retrieves a reply by msgId', () => {
        cache.set('msg123', 'Hello world');
        expect(cache.get('msg123')).toBe('Hello world');
    });

    it('returns null for unknown msgId', () => {
        expect(cache.get('msg-unknown')).toBeNull();
    });

    it('returns null for expired entry', async () => {
        cache = new ReplyCache({ ttlMs: 10 });
        cache.set('msg456', 'content');
        await new Promise(r => setTimeout(r, 20));
        expect(cache.get('msg456')).toBeNull();
    });

    it('does not store entry when msgId is falsy', () => {
        cache.set(null, 'content');
        cache.set('', 'content');
        cache.set(undefined, 'content');
        expect(cache.get(null)).toBeNull();
        expect(cache.get('')).toBeNull();
    });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/reply-cache.test.js
```
Expected: FAIL — `reply-cache.js` does not exist.

**Step 3: Implement `dingtalk/reply-cache.js`**

```js
'use strict';

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_MAX_SIZE = 500;

class ReplyCache {
    constructor({ ttlMs = DEFAULT_TTL_MS, maxSize = DEFAULT_MAX_SIZE } = {}) {
        this.ttlMs = ttlMs;
        this.maxSize = maxSize;
        this._map = new Map(); // msgId → { content, expiresAt }
    }

    set(msgId, content) {
        if (!msgId) return;
        // Evict oldest entry if at capacity
        if (this._map.size >= this.maxSize) {
            const firstKey = this._map.keys().next().value;
            this._map.delete(firstKey);
        }
        this._map.set(msgId, {
            content,
            expiresAt: Date.now() + this.ttlMs,
        });
    }

    get(msgId) {
        if (!msgId) return null;
        const entry = this._map.get(msgId);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this._map.delete(msgId);
            return null;
        }
        return entry.content;
    }
}

module.exports = { ReplyCache };
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/reply-cache.test.js
```
Expected: PASS (4 tests).

**Step 5: Commit**

```bash
git add dingtalk/reply-cache.js tests/unit/reply-cache.test.js
git commit -m "feat: add ReplyCache module with TTL and max-size eviction"
```

---

### Task 3: Wire ReplyCache into bot.js — cache outgoing replies

**Files:**
- Modify: `dingtalk/bot.js`

**Step 1: Import ReplyCache at top of bot.js**

After the existing `require` lines, add:
```js
const { ReplyCache } = require('./reply-cache.js');
```

**Step 2: Instantiate cache after config section**

After the `THINKING_MSG` line, add:
```js
const REPLY_CACHE_TTL_MS = parseInt(process.env.DINGTALK_REPLY_CACHE_TTL_MS || '') || (2 * 60 * 60 * 1000);
const replyCache = new ReplyCache({ ttlMs: REPLY_CACHE_TTL_MS });
```

**Step 3: Update `reply()` to return msgId and cache the content**

Replace the current `reply()` function (which already has the debug log) with:

```js
async function reply(sessionWebhook, text) {
    const res = await fetch(sessionWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { title: '知识库回答', text },
        }),
    });
    const data = await res.json().catch(() => ({}));
    return data.msgId || null;
}
```

**Step 4: In `handleMessage`, cache the reply after sending**

Find the "Reply" section at the bottom of `handleMessage` and replace:
```js
    // Reply
    await reply(sessionWebhook, answer).catch(() => {});
```
with:
```js
    // Reply — cache the sent msgId so quoted follow-ups can retrieve context
    const sentMsgId = await reply(sessionWebhook, answer).catch(() => null);
    if (sentMsgId) replyCache.set(sentMsgId, answer);
```

**Step 5: Restart bot, trigger a RAG reply, verify no errors in log**

```bash
kill $(pgrep -f 'node.*bot.js') && /opt/homebrew/bin/node /Users/fightshadow/code/my/MiniRAG-Local/dingtalk/bot.js >> /tmp/dingtalk_bot.log 2>&1 &
tail -20 /tmp/dingtalk_bot.log
```

> **NOTE:** If `reply-response` log shows no `msgId` in the response (discovered in Task 1), the `sentMsgId` will always be null and caching silently does nothing. That's acceptable for now — the quote follow-up feature simply won't work until DingTalk returns a msgId. Confirm actual behavior in log before proceeding.

**Step 6: Commit**

```bash
git add dingtalk/bot.js
git commit -m "feat: wire ReplyCache into bot — cache outgoing reply msgIds"
```

---

### Task 4: Use cached context for quoted follow-up questions

**Files:**
- Modify: `dingtalk/bot.js`

**Step 1: Write a test for the context-building logic**

Extract context building into a pure function first. Add to `tests/unit/reply-cache.test.js`:

```js
import { buildQuotedContext } from '../../dingtalk/reply-cache.js';

describe('buildQuotedContext', () => {
    it('returns question as-is when no cached reply', () => {
        expect(buildQuotedContext(null, '我的问题')).toBe('我的问题');
    });

    it('prepends cached reply when available', () => {
        const result = buildQuotedContext('之前的回答内容', '这个结论的依据是什么');
        expect(result).toBe(
            '[上文回答]\n之前的回答内容\n\n[追问]\n这个结论的依据是什么'
        );
    });

    it('returns question as-is when cachedReply is empty string', () => {
        expect(buildQuotedContext('', '问题')).toBe('问题');
    });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/reply-cache.test.js
```
Expected: FAIL — `buildQuotedContext` not exported.

**Step 3: Add `buildQuotedContext` to `dingtalk/reply-cache.js`**

Append to the file before `module.exports`:
```js
function buildQuotedContext(cachedReply, userQuestion) {
    if (!cachedReply) return userQuestion;
    return `[上文回答]\n${cachedReply}\n\n[追问]\n${userQuestion}`;
}
```

Update `module.exports`:
```js
module.exports = { ReplyCache, buildQuotedContext };
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/reply-cache.test.js
```
Expected: PASS (7 tests).

**Step 5: Update import in bot.js**

```js
const { ReplyCache, buildQuotedContext } = require('./reply-cache.js');
```

**Step 6: Use `buildQuotedContext` in `handleMessage`**

Find the "Strip @mention prefix" section in `handleMessage`. Replace:
```js
    // Strip @mention prefix (DingTalk prepends "@BotName " to the text)
    const question = text.content.replace(/^@\S+\s*/, '').trim();
    if (!question) return { status: 'SUCCESS', message: '' };
```
with:
```js
    // Strip @mention prefix (DingTalk prepends "@BotName " to the text)
    const rawQuestion = text.content.replace(/^@\S+\s*/, '').trim();

    // For quoted replies: look up cached bot reply to provide context
    const isQuotedReply = text.isReplyMsg === true;
    const originalMsgId = msg.originalMsgId || null;
    const cachedReply = isQuotedReply ? replyCache.get(originalMsgId) : null;

    // If quoting bot's reply with no question text, skip silently
    // (user quoted a non-bot message or gave no question — nothing useful to do)
    if (!rawQuestion && !cachedReply) return { status: 'SUCCESS', message: '' };
    if (!rawQuestion) return { status: 'SUCCESS', message: '' };

    const question = buildQuotedContext(cachedReply, rawQuestion);
```

**Step 7: Restart bot and test the full flow**

1. Send a normal `@` question → bot replies
2. Quote that reply → `@` bot with a follow-up question
3. Verify in log that `cachedReply` is non-null and the RAG receives the combined context

**Step 8: Commit**

```bash
git add dingtalk/bot.js dingtalk/reply-cache.js tests/unit/reply-cache.test.js
git commit -m "feat: include cached bot reply as context for quoted follow-up questions"
```

---

### Task 5: Clean up debug logs

**Files:**
- Modify: `dingtalk/bot.js`

**Step 1: Remove all `[DEBUG:*]` lines**

Remove these lines from `bot.js`:
- `console.log('[DEBUG:payload]', JSON.stringify(msg));`
- `console.log('[DEBUG:reply-response]', JSON.stringify(data));` (inside `reply()`)

**Step 2: Restart bot and verify clean log output**

```bash
kill $(pgrep -f 'node.*bot.js') && /opt/homebrew/bin/node /Users/fightshadow/code/my/MiniRAG-Local/dingtalk/bot.js >> /tmp/dingtalk_bot.log 2>&1 &
tail -10 /tmp/dingtalk_bot.log
```
Expected: only `DingTalk bot started`, `Configured groups: N`, `connect success`.

**Step 3: Commit**

```bash
git add dingtalk/bot.js
git commit -m "chore: remove debug payload and reply-response logs"
```

---

## Implementation Status (Updated 2026-02-27)

### Completed — Quoted Message Feature

The original plan above (Tasks 1-5) was **superseded** by a simpler approach:

**Method:** `extractQuotedPrefix()` in `dingtalk/bot.js` — detects `text.isReplyMsg === true` and extracts the quoted message prefix from the payload. No reply caching needed because the approach works with the DingTalk payload structure directly.

**Key discovery:** DingTalk `sessionWebhook` response does NOT return `msgId` (only `{"errcode":0,"errmsg":"ok"}`), making the cache-based approach non-viable. The `extractQuotedPrefix()` approach sidesteps this limitation.

### Completed — Markdown Rendering Fixes

All TUI artifact cleanup and DingTalk markdown normalization is handled in `proxy/text-utils.js`:

| Fix | Description |
|-----|-------------|
| Phase 0a: box-drawing tables → bold list | `┌─┬┐` tables → `**key**: value` format |
| Phase 0c: markdown tables → bold list | GFM `\| col \| col \|` → bold list (DingTalk doesn't support tables) |
| Phase 3b: bullet symbols → `- ` | `•◦‣⁃` → standard markdown list marker |
| Phase 5: leading whitespace strip | Remove TUI 2-space panel indentation |
| THOUGHT_SUFFIX: vt100 variants | Handle `Sautéed/Crunched for Ns` garbled thought markers |
| normalizeRagMarkdown spacing | Correct paragraph spacing without breaking table-derived lines |
| Multi-column empty first cell | Inherit previous row's first cell value for merged cells |
| Code-like line detection | `isCodeLike()` heuristic prevents `normalizeRagMarkdown` from inserting blank lines between consecutive code/command/JSON lines |
| start_ai.sh PATH fix | Add `/opt/homebrew/bin` to PATH for non-interactive shells |

### Known Limitations

- Code blocks from Claude TUI output arrive without ` ``` ` fences. The `isCodeLike()` heuristic prevents them from being split by blank lines, but they won't render as monospace in DingTalk.
- Trailing TUI status fragments (1-2 char like "Rs", "t") are extremely rare but possible when content fills close to the 80-column boundary. The `TRAILING_FRAGMENT` regex covers most cases via the 4+ whitespace gap pattern.
- DingTalk `msgtype: "markdown"` has limited support — no tables, no code fences, no inline code, no horizontal rules.
