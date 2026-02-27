const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseEnvLine } = require('./env-utils');
const { cleanTuiOutput } = require('./text-utils');

// 极简 .env 加载
function loadEnv() {
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach(line => {
      const parsed = parseEnvLine(line);
      if (parsed !== null) {
        process.env[parsed.key] = parsed.value;
      }
    });
  }
}

loadEnv();

const AGENT_API_URL = process.env.AGENT_API_URL || 'http://localhost:3284';
const PORT = process.env.PORT || 8000;

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const openaiReq = JSON.parse(body);
        const userMsg = openaiReq.messages.find(m => m.role === 'user')?.content;

        if (!userMsg) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'No user message found' }));
          return;
        }

        // 1. 获取发送前的消息列表，记录最后一条消息的 ID
        const beforeMsgRes = await fetch(`${AGENT_API_URL}/messages`);
        const beforeData = await beforeMsgRes.json();
        const lastMsgIdBefore = beforeData.messages.length > 0 
          ? beforeData.messages[beforeData.messages.length - 1].id 
          : -1;

        // 2. Send to agentapi
        const postRes = await fetch(`${AGENT_API_URL}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: userMsg, type: 'user' })
        });

        if (!postRes.ok) {
          const error = await postRes.text();
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'agentapi error: ' + error }));
          return;
        }

        // 3. Poll for response - 等待新的 agent 消息
        let finalResponse = '';
        let attempts = 0;
        const maxAttempts = 300; // 5分钟超时（300秒，每秒轮询一次）
        
        while (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 1000));
          
          // 获取最新消息列表
          const msgRes = await fetch(`${AGENT_API_URL}/messages`);
          const data = await msgRes.json();
          const messages = data.messages;
          
          // 找到最后一条消息
          const lastMsg = messages[messages.length - 1];
          
          // 检查是否有新的 agent 消息（ID 大于发送前的最后一条，且角色是 agent）
          if (lastMsg && lastMsg.role === 'agent' && lastMsg.id > lastMsgIdBefore) {
            // 检查状态是否已经稳定
            const statusRes = await fetch(`${AGENT_API_URL}/status`);
            const statusData = await statusRes.json();
            
            if (statusData.status === 'stable') {
              finalResponse = lastMsg.content;
              break;
            }
            // 如果还在运行中，继续等待
          }
          
          attempts++;
        }

        if (!finalResponse) {
          res.writeHead(504);
          res.end(JSON.stringify({ error: 'Timeout waiting for agent response (5 minutes)' }));
          return;
        }

        // --- 清理 TUI 杂质 ---
        const cleanedResponse = cleanTuiOutput(finalResponse);

        const openaiRes = {
          id: 'chatcmpl-' + Math.random().toString(36).substring(7),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: openaiReq.model || 'minirag-local',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: cleanedResponse
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
          }
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(openaiRes));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`OpenAI Proxy running on http://localhost:${PORT}`);
});
