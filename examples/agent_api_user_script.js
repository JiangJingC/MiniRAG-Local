// ==UserScript==
// @name         AgentAPI Web integration
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Integrate AgentAPI into any website
// @author       Assistant
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function() {
    'use strict';

    // 1. 创建 UI 容器
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.bottom = '20px';
    container.style.right = '20px';
    container.style.zIndex = '9999';
    container.style.width = '350px';
    container.style.height = '500px';
    container.style.backgroundColor = '#fff';
    container.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';
    container.style.borderRadius = '8px';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.overflow = 'hidden';
    container.style.border = '1px solid #ccc';

    // 2. 创建 Header
    const header = document.createElement('div');
    header.style.padding = '10px';
    header.style.backgroundColor = '#007bff';
    header.style.color = '#fff';
    header.style.fontWeight = 'bold';
    header.innerText = 'AgentAPI Chat';
    container.appendChild(header);

    // 3. 创建消息显示区
    const msgList = document.createElement('div');
    msgList.style.flex = '1';
    msgList.style.overflowY = 'auto';
    msgList.style.padding = '10px';
    msgList.style.fontSize = '14px';
    container.appendChild(msgList);

    // 4. 创建输入区
    const inputArea = document.createElement('div');
    inputArea.style.display = 'flex';
    inputArea.style.padding = '10px';
    inputArea.style.borderTop = '1px solid #eee';

    const input = document.createElement('input');
    input.style.flex = '1';
    input.style.padding = '5px';
    input.placeholder = 'Ask me anything...';
    inputArea.appendChild(input);

    const btn = document.createElement('button');
    btn.innerText = 'Send';
    btn.style.marginLeft = '5px';
    btn.onclick = sendMessage;
    inputArea.appendChild(btn);

    container.appendChild(inputArea);
    document.body.appendChild(container);

    const API_BASE = 'http://localhost:3284';

    function addMessage(role, content) {
        const m = document.createElement('div');
        m.style.marginBottom = '8px';
        m.style.color = role === 'user' ? '#333' : '#007bff';
        m.innerText = (role === 'user' ? 'You: ' : 'Agent: ') + content;
        msgList.appendChild(m);
        msgList.scrollTop = msgList.scrollHeight;
    }

    async function sendMessage() {
        const content = input.value.trim();
        if (!content) return;
        
        addMessage('user', content);
        input.value = '';

        GM_xmlhttpRequest({
            method: "POST",
            url: `${API_BASE}/message`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ content, type: "user" }),
            onload: function(res) {
                pollResponse();
            }
        });
    }

    function pollResponse() {
        const interval = setInterval(() => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `${API_BASE}/messages`,
                onload: function(res) {
                    const data = JSON.parse(res.responseText);
                    const lastMsg = data.messages[data.messages.length - 1];
                    if (lastMsg && lastMsg.role === 'agent') {
                        // 检查状态是否稳定
                        GM_xmlhttpRequest({
                            method: "GET",
                            url: `${API_BASE}/status`,
                            onload: function(sRes) {
                                const sData = JSON.parse(sRes.responseText);
                                if (sData.status === 'stable') {
                                    addMessage('agent', lastMsg.content);
                                    clearInterval(interval);
                                }
                            }
                        });
                    }
                }
            });
        }, 1000);
    }
})();
