const http = require('http');
const fs = require('fs');
const path = require('path');

// 极简 .env 加载
function loadEnv() {
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach(line => {
      const [key, value] = line.split('=');
      if (key && value) {
        process.env[key.trim()] = value.trim();
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

        // 1. Send to agentapi
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

        // 2. Poll for response
        let finalResponse = '';
        let attempts = 0;
        const maxAttempts = 30; // 30 seconds timeout
        
        while (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 1000));
          const msgRes = await fetch(`${AGENT_API_URL}/messages`);
          const data = await msgRes.json();
          const messages = data.messages;
          
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.role === 'agent' && lastMsg.id > 0) {
            const statusRes = await fetch(`${AGENT_API_URL}/status`);
            const statusData = await statusRes.json();
            if (statusData.status === 'stable') {
                finalResponse = lastMsg.content;
                break;
            }
          }
          attempts++;
        }

        if (!finalResponse) {
          res.writeHead(504);
          res.end(JSON.stringify({ error: 'Timeout waiting for agent response' }));
          return;
        }

        // --- 清理 TUI 杂质 ---
        let cleanedResponse = finalResponse
          // 1. 移除特定的 TUI 符号
          .replace(/[⏺⎿…▀▄░░✦]/g, '')
          // 2. 移除常见的制表符/边框字符 (┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ ─ │)
          .replace(/[┌┐└┘├┤┬┴┼─│]/g, '')
          // 3. 移除思考状态提示 (如 "thought for 1s", "Search(pattern: ...)")
          .replace(/.*thought for \d+s.*/g, '')
          .replace(/.*Search\(pattern:.*\).*/g, '')
          .replace(/.*Bash\(.*\).*/g, '')
          .replace(/.*Read\(.*\).*/g, '')
          .replace(/.*Type your message or @path\/to\/file.*/g, '')
          .replace(/.*Press 'i' for INSERT mode.*/g, '')
          // 4. 处理多余的空格和空行
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .join('\n');

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
