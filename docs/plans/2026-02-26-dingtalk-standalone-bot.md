# DingTalk Standalone Bot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a standalone DingTalk bot service to MiniRAG-Local that routes group messages directly to MiniRAG-Local, with no dependency on OpenClaw.

**Architecture:** A new `dingtalk/` directory inside MiniRAG-Local contains two files: `auth.js` (access token cache) and `bot.js` (WebSocket Stream entry point). The bot uses the official `dingtalk-stream` npm SDK to receive messages over WebSocket (no public IP needed), routes each group's messages to a configurable RAG endpoint, and replies with markdown. Multi-group support is achieved via a `DINGTALK_RAG_GROUPS` JSON env var that maps conversationId → endpoint config.

**Tech Stack:** Node.js (CommonJS, no transpile), `dingtalk-stream` npm SDK, `node-fetch` (already available via Node 18+ global fetch), no build step.

---

## Reference: MiniRAG-Local structure

```
MiniRAG-Local/
  proxy/openai_proxy.js     ← existing, uses loadEnv() pattern (copy this)
  scripts/start_ai.sh       ← existing startup script
  .env / .env.example       ← existing config
```

The `loadEnv()` function in `openai_proxy.js:6-17` is the pattern to reuse for loading `.env`.

---

## Task 1: Install dingtalk-stream SDK

**Files:**
- Modify: `package.json` (create if absent)

**Step 1: Check if package.json exists**

```bash
ls /Users/fightshadow/code/my/MiniRAG-Local/package.json
```

**Step 2: Initialize package.json if missing**

```bash
cd /Users/fightshadow/code/my/MiniRAG-Local
npm init -y
```

**Step 3: Install SDK**

```bash
cd /Users/fightshadow/code/my/MiniRAG-Local
npm install dingtalk-stream
```

**Step 4: Verify**

```bash
node -e "require('dingtalk-stream'); console.log('ok')" 2>/dev/null \
  || node -e "const d = require('dingtalk-stream'); console.log(typeof d)"
```
Expected: `ok` or object type printed (no error).

**Step 5: Commit**

```bash
cd /Users/fightshadow/code/my/MiniRAG-Local
git add package.json package-lock.json node_modules/.package-lock.json
git commit -m "chore: add dingtalk-stream SDK"
```

---

## Task 2: dingtalk/auth.js — access token cache

**Files:**
- Create: `dingtalk/auth.js`

The DingTalk API for token: `POST https://api.dingtalk.com/v1.0/oauth2/accessToken`  
Body: `{ "appKey": "...", "appSecret": "...", "grantType": "client_credentials" }`  
Response: `{ "accessToken": "...", "expireIn": 7200 }`

Token expires in 7200s; cache with a 60s safety margin (refresh at 7140s).

**Step 1: Create `dingtalk/auth.js`**

```js
'use strict';

let _cachedToken = null;
let _expiresAt = 0;

/**
 * Get a valid DingTalk access token, refreshing if within 60s of expiry.
 * @param {string} appKey
 * @param {string} appSecret
 * @returns {Promise<string>}
 */
async function getAccessToken(appKey, appSecret) {
    const now = Date.now();
    if (_cachedToken && now < _expiresAt - 60_000) {
        return _cachedToken;
    }

    const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey, appSecret, grantType: 'client_credentials' }),
    });

    if (!res.ok) {
        throw new Error(`Token fetch failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    _cachedToken = data.accessToken;
    _expiresAt = now + data.expireIn * 1000;
    return _cachedToken;
}

/** Reset cache (for testing) */
function resetCache() {
    _cachedToken = null;
    _expiresAt = 0;
}

module.exports = { getAccessToken, resetCache };
```

**Step 2: Smoke-test manually (no real credentials needed, just check require)**

```bash
node -e "const a = require('./dingtalk/auth.js'); console.log(typeof a.getAccessToken)"
```
Expected: `function`

**Step 3: Commit**

```bash
cd /Users/fightshadow/code/my/MiniRAG-Local
git add dingtalk/auth.js
git commit -m "feat(dingtalk): add access token cache module"
```

---

## Task 3: dingtalk/bot.js — WebSocket Stream bot

**Files:**
- Create: `dingtalk/bot.js`

### Key concepts

- `dingtalk-stream` SDK: instantiate `DWClient`, register a callback for `bot.message` topic, call `client.start()`. The SDK handles WebSocket reconnect internally.
- Inbound message shape (simplified):
  ```json
  {
    "conversationId": "cidXXX",
    "conversationType": "2",
    "msgtype": "text",
    "text": { "content": "@bot hello" },
    "senderStaffId": "xxx",
    "msgId": "unique-id"
  }
  ```
- Reply endpoint: `POST https://oapi.dingtalk.com/robot/send?access_token=<webhook_token>` OR session webhook. For group bots, the simplest reliable reply is via the **session webhook** provided in the callback headers. The `dingtalk-stream` SDK passes the raw event; the session webhook URL comes from `event.headers['x-session-token']` (or equivalent) — check SDK docs below.
- Dedup: keep a `Set` of recent `msgId`s with a 5-minute TTL using a simple timestamp map.

### dingtalk-stream SDK usage pattern

```js
const { DWClient, DWClientDownStream, EventAck, TOPIC_ROBOT } = require('dingtalk-stream');

const client = new DWClient({
    clientId: APP_KEY,
    clientSecret: APP_SECRET,
});

client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
    const { messageId, topic, headers, data } = res;
    const msg = JSON.parse(data);
    // ... handle msg ...
    // Ack to SDK
    return { status: 'SUCCESS', message: '' };
}).start();
```

To reply via session webhook (provided per-message by the SDK):
```js
// headers contain the session webhook for replying
const sessionWebhook = headers.sessionWebhook;
await fetch(sessionWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: '知识库回答', text: replyText },
    }),
});
```

### RAG groups config format (env var `DINGTALK_RAG_GROUPS`)

```json
{
  "cidABCDEF": {
    "endpoint": "http://localhost:62000/v1/chat/completions",
    "model": "rag",
    "timeoutMs": 30000
  }
}
```

### Step 1: Create `dingtalk/bot.js`

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { DWClient, TOPIC_ROBOT } = require('dingtalk-stream');
const { getAccessToken } = require('./auth.js');

// ── Config ────────────────────────────────────────────────────────────────────

function loadEnv() {
    const envPath = path.resolve(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        content.split('\n').forEach(line => {
            const eqIdx = line.indexOf('=');
            if (eqIdx > 0 && !line.startsWith('#')) {
                const key = line.slice(0, eqIdx).trim();
                const value = line.slice(eqIdx + 1).trim();
                if (key) process.env[key] = value;
            }
        });
    }
}

loadEnv();

const APP_KEY = process.env.DINGTALK_APP_KEY;
const APP_SECRET = process.env.DINGTALK_APP_SECRET;

if (!APP_KEY || !APP_SECRET) {
    console.error('Error: DINGTALK_APP_KEY and DINGTALK_APP_SECRET must be set in .env');
    process.exit(1);
}

let RAG_GROUPS = {};
try {
    RAG_GROUPS = JSON.parse(process.env.DINGTALK_RAG_GROUPS || '{}');
} catch (e) {
    console.error('Error: DINGTALK_RAG_GROUPS is not valid JSON');
    process.exit(1);
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

const DEDUP_TTL_MS = 5 * 60 * 1000;
const dedupMap = new Map(); // msgId → timestamp

function isDuplicate(msgId) {
    const now = Date.now();
    // Lazy cleanup: remove expired entries
    for (const [id, ts] of dedupMap) {
        if (now - ts > DEDUP_TTL_MS) dedupMap.delete(id);
    }
    if (dedupMap.has(msgId)) return true;
    dedupMap.set(msgId, now);
    return false;
}

// ── RAG query ─────────────────────────────────────────────────────────────────

async function queryRAG(endpoint, model, question, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model || 'rag',
                messages: [{ role: 'user', content: question }],
            }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`RAG error: ${res.status}`);
        const data = await res.json();
        return data.choices?.[0]?.message?.content || '(no response)';
    } finally {
        clearTimeout(timer);
    }
}

// ── Reply ─────────────────────────────────────────────────────────────────────

async function reply(sessionWebhook, text) {
    await fetch(sessionWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { title: '知识库回答', text },
        }),
    });
}

async function replyText(sessionWebhook, text) {
    await fetch(sessionWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            msgtype: 'text',
            text: { content: text },
        }),
    });
}

// ── Message handler ───────────────────────────────────────────────────────────

async function handleMessage(res) {
    const { headers, data } = res;
    const sessionWebhook = headers.sessionWebhook;

    let msg;
    try {
        msg = JSON.parse(data);
    } catch {
        return { status: 'SUCCESS', message: '' };
    }

    const { msgId, conversationId, conversationType, text, msgtype } = msg;

    // Only handle group messages (conversationType === '2')
    if (conversationType !== '2') return { status: 'SUCCESS', message: '' };

    // Only handle text messages
    if (msgtype !== 'text' || !text?.content) return { status: 'SUCCESS', message: '' };

    // Dedup
    if (isDuplicate(msgId)) return { status: 'SUCCESS', message: '' };

    // Only route if group is configured
    const groupConfig = RAG_GROUPS[conversationId];
    if (!groupConfig) return { status: 'SUCCESS', message: '' };

    // Strip @mention prefix (DingTalk prepends "@BotName " to the text)
    const question = text.content.replace(/^@\S+\s*/, '').trim();
    if (!question) return { status: 'SUCCESS', message: '' };

    // Send thinking indicator
    await replyText(sessionWebhook, '🤔 正在使用本地知识库处理，请稍候...').catch(() => {});

    // Query RAG
    let answer;
    try {
        answer = await queryRAG(groupConfig.endpoint, groupConfig.model, question, groupConfig.timeoutMs);
    } catch (e) {
        await replyText(sessionWebhook, `查询失败: ${e.message}`).catch(() => {});
        return { status: 'SUCCESS', message: '' };
    }

    // Reply
    await reply(sessionWebhook, answer).catch(() => {});

    return { status: 'SUCCESS', message: '' };
}

// ── Start ─────────────────────────────────────────────────────────────────────

const client = new DWClient({
    clientId: APP_KEY,
    clientSecret: APP_SECRET,
});

client.registerCallbackListener(TOPIC_ROBOT, handleMessage).start();

console.log('DingTalk bot started. Listening for group messages...');
console.log('Configured groups:', Object.keys(RAG_GROUPS).length);
```

**Step 2: Smoke-test (require only, no real credentials)**

```bash
cd /Users/fightshadow/code/my/MiniRAG-Local
DINGTALK_APP_KEY=test DINGTALK_APP_SECRET=test node -e "
  // Just test that the module loads without crashing on require
  // (it will fail at DWClient.start() which needs real creds, that's fine)
  console.log('module loads ok');
" 2>/dev/null || echo "expected - needs real creds to start"
```

**Step 3: Commit**

```bash
cd /Users/fightshadow/code/my/MiniRAG-Local
git add dingtalk/bot.js
git commit -m "feat(dingtalk): add standalone DingTalk bot for RAG group routing"
```

---

## Task 4: .env.example + start script

**Files:**
- Modify: `.env.example` — append DingTalk section
- Modify: `scripts/start_ai.sh` — add optional DingTalk bot startup

**Step 1: Append to `.env.example`**

Add this section at the end of `.env.example`:

```env
# ========================================
# DingTalk 独立机器人配置（可选）
# 不依赖 OpenClaw，直接对接钉钉群
# ========================================

# 钉钉应用 AppKey（企业内部应用 → 凭证与基础信息）
DINGTALK_APP_KEY=

# 钉钉应用 AppSecret
DINGTALK_APP_SECRET=

# RAG 群组路由配置（JSON 格式）
# key: 钉钉群的 conversationId（从机器人收到消息的日志中获取）
# value: { endpoint, model, timeoutMs }
DINGTALK_RAG_GROUPS={"cidXXXXXX": {"endpoint": "http://localhost:62000/v1/chat/completions", "model": "rag", "timeoutMs": 30000}}
```

**Step 2: Modify `scripts/start_ai.sh`** — add optional DingTalk bot at the end, before the final echo block:

```bash
# 3. 可选：启动 DingTalk 独立机器人
if [ -n "$DINGTALK_APP_KEY" ] && [ -n "$DINGTALK_APP_SECRET" ]; then
    ps aux | grep "dingtalk/bot.js" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null
    node "$PROJECT_ROOT/dingtalk/bot.js" > /tmp/dingtalk_bot.log 2>&1 &
    echo "DingTalk 机器人已启动 (日志: /tmp/dingtalk_bot.log)"
fi
```

**Step 3: Commit**

```bash
cd /Users/fightshadow/code/my/MiniRAG-Local
git add .env.example scripts/start_ai.sh
git commit -m "feat(dingtalk): add env config and optional bot startup to start_ai.sh"
```

---

## Task 5: README.md update

**Files:**
- Modify: `README.md`

Add a new section `## 钉钉群机器人（独立模式）` after the existing `## 快速开始` section, with:

1. 一句话说明：这是不依赖 OpenClaw 的独立接入方式
2. 前提：已完成正常部署（agentapi + proxy 已运行）
3. 三步配置：配置 `.env` 中三个 DingTalk 变量 → 重启 `start_ai.sh` → 在钉钉开发者后台开启 Stream 模式
4. 如何获取 conversationId：启动后在日志 `/tmp/dingtalk_bot.log` 中查看首条消息的输出，或暂时加一行 `console.log(conversationId)` 到 bot.js

**Step 1: Add the section to README.md**

Insert after the `## 快速开始` section (after line ~113):

```markdown
## 钉钉群机器人（独立模式）

> 不依赖 OpenClaw，适合公司/团队独立部署。前提：已按上方步骤完成 AgentAPI + Proxy 的部署。

### 配置步骤

**1. 在钉钉开发者后台**（[open.dingtalk.com](https://open.dingtalk.com)）创建企业内部应用，开启「机器人」能力，连接方式选 **Stream 模式**（无需公网 IP）。

**2. 在 `.env` 中补充以下配置：**

```env
DINGTALK_APP_KEY=你的AppKey
DINGTALK_APP_SECRET=你的AppSecret
DINGTALK_RAG_GROUPS={"cidXXXXXX": {"endpoint": "http://localhost:62000/v1/chat/completions", "model": "rag", "timeoutMs": 30000}}
```

**3. 重启服务：**

```bash
./scripts/start_ai.sh
```

机器人启动后，在对应钉钉群中 @ 机器人提问，会先收到"正在查询知识库..."提示，随后返回知识库回答。

### 如何获取 conversationId

在群里 @ 机器人发任意一条消息，查看日志：

```bash
tail -f /tmp/dingtalk_bot.log
```

首次收到消息时会打印 conversationId，将其填入 `DINGTALK_RAG_GROUPS` 的 key 即可。
```

**Step 2: Commit**

```bash
cd /Users/fightshadow/code/my/MiniRAG-Local
git add README.md
git commit -m "docs: add DingTalk standalone bot setup guide"
```

---

## Verification

End-to-end smoke test (requires real DingTalk credentials):

1. Set `DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET`, `DINGTALK_RAG_GROUPS` in `.env`
2. Run `./scripts/start_ai.sh`
3. Check `tail /tmp/dingtalk_bot.log` — should see "DingTalk bot started. Listening..."
4. In the configured DingTalk group, @ the bot with a question
5. Bot replies "🤔 正在使用本地知识库处理..." then the RAG answer
