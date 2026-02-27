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

const THINKING_MSG = process.env.DINGTALK_THINKING_MSG || '🤔 正在查询知识库，请稍候...';

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

// ── Quoted message extraction ─────────────────────────────────────────────────

/**
 * Extract text from a quoted/reply message and return a readable prefix.
 * Mirrors the approach in openclaw-channel-dingtalk/src/message-utils.ts.
 *
 * Returns a string like '[引用消息: "..."]\n\n' or '' if nothing extractable.
 */
function extractQuotedPrefix(msg) {
    const textField = msg.text;

    if (!textField?.isReplyMsg) return '';

    // Path 1: repliedMsg has inline content (user quoted a plain-text message)
    const repliedMsg = textField?.repliedMsg;
    if (repliedMsg) {
        const content = repliedMsg?.content;

        // Plain text
        if (content?.text) {
            const quoteText = content.text.trim();
            if (quoteText) return `[引用消息: "${quoteText}"]\n\n`;
        }

        // Rich text array (text/emoji/picture/@mention)
        if (content?.richText && Array.isArray(content.richText)) {
            const parts = [];
            for (const part of content.richText) {
                if (part.msgType === 'text' && part.content) {
                    parts.push(part.content);
                } else if (part.msgType === 'emoji' || part.type === 'emoji') {
                    parts.push(part.content || '[表情]');
                } else if (part.msgType === 'picture' || part.type === 'picture') {
                    parts.push('[图片]');
                } else if (part.msgType === 'at' || part.type === 'at') {
                    parts.push(`@${part.content || part.atName || '某人'}`);
                } else if (part.text) {
                    parts.push(part.text);
                }
            }
            const quoteText = parts.join('').trim();
            if (quoteText) return `[引用消息: "${quoteText}"]\n\n`;
        }
    }

    // Path 2: only originalMsgId available (e.g. bot markdown reply — DingTalk
    // marks these as "unknownMsgType" with no content field). No usable text,
    // return empty so the user's follow-up question is sent without a noisy prefix.
    return '';
}

// ── Message handler ───────────────────────────────────────────────────────────

async function handleMessage(res) {
    const { data } = res;

    let msg;
    try {
        msg = JSON.parse(data);
    } catch {
        return { status: 'SUCCESS', message: '' };
    }

    // sessionWebhook is in the message payload, not stream headers
    const sessionWebhook = msg.sessionWebhook;
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
    const userInput = text.content.replace(/^@\S+\s*/, '').trim();

    // Extract quoted message prefix (if this is a reply/quote message)
    const quotedPrefix = extractQuotedPrefix(msg);

    // If user quoted a message but typed nothing after @, prompt them
    if (!userInput && !quotedPrefix) return { status: 'SUCCESS', message: '' };
    if (!userInput && quotedPrefix) {
        await replyText(sessionWebhook, '请在 @ 后面写上你的问题').catch(() => {});
        return { status: 'SUCCESS', message: '' };
    }

    // Build final question: quoted context + user input
    const question = quotedPrefix + userInput;

    // Send thinking indicator
    await replyText(sessionWebhook, THINKING_MSG).catch(() => {});

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

client.registerCallbackListener(TOPIC_ROBOT, handleMessage).connect();

console.log('DingTalk bot started. Listening for group messages...');
console.log('Configured groups:', Object.keys(RAG_GROUPS).length);
