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
