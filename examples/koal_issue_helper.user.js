// ==UserScript==
// @name         Koal Issue Helper - MiniRAG
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  为 dev.koal.com 提供 AI 辅助优化 issue 和添加说明的功能
// @author       大史
// @match        https://dev.koal.com/*
// @match        http://dev.koal.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ========== 配置 ==========
    const DEBUG = true;
    const API_BASE = 'http://localhost:62000/v1/chat/completions';
    const MAX_CONCURRENT = 1; // 最大并发数
    
    // 队列管理
    const taskQueue = [];
    let activeRequests = 0;
    
    // 状态管理
    const state = {
        optimize: { loading: false, result: null },
        technical: { loading: false, result: null },
        tests: { loading: false, result: null },
        impact: { loading: false, result: null },
        custom: { loading: false, result: null }
    };
    
    function debugLog(message, data) {
        if (DEBUG) {
            console.log(`[MiniRAG Debug] ${message}`, data || '');
        }
    }

    // ========== 样式定义 ==========
    const styles = `
        .minirag-btn {
            margin: 0 5px;
            padding: 8px 16px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.3s ease;
            box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
            position: relative;
        }
        .minirag-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.5);
        }
        .minirag-btn:active {
            transform: translateY(0);
        }
        .minirag-btn:disabled {
            background: #ccc;
            cursor: not-allowed;
            transform: none;
        }
        .minirag-btn.loading {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            cursor: not-allowed;
        }
        .minirag-btn.loading::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 16px;
            height: 16px;
            margin: -8px 0 0 -8px;
            border: 2px solid rgba(255,255,255,0.3);
            border-top-color: white;
            border-radius: 50%;
            animation: spinner 0.8s linear infinite;
        }
        @keyframes spinner {
            to { transform: rotate(360deg); }
        }
        .minirag-modal {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 99999;
            backdrop-filter: blur(4px);
        }
        .minirag-modal-content {
            background: white;
            border-radius: 12px;
            padding: 24px;
            max-width: 500px;
            width: 90%;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        }
        .minirag-modal-header {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 16px;
            color: #333;
        }
        .minirag-response {
            padding: 16px;
            line-height: 1.8;
            color: #333;
            font-size: 14px;
        }
        .minirag-error {
            color: #e53e3e;
            background: #fff5f5;
            border-left: 4px solid #e53e3e;
            padding: 12px;
            border-radius: 4px;
        }
        .minirag-toolbar {
            position: fixed;
            bottom: 20px;
            right: 20px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            z-index: 9999;
        }
        .minirag-input-modal {
            max-width: 600px;
        }
        .minirag-textarea {
            width: 100%;
            min-height: 120px;
            padding: 12px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            font-size: 14px;
            font-family: inherit;
            resize: vertical;
            margin-bottom: 16px;
        }
        .minirag-textarea:focus {
            outline: none;
            border-color: #667eea;
        }
        .minirag-modal-buttons {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
        }
        .minirag-toast {
            position: fixed;
            top: 20px;
            right: 20px;
            background: white;
            border-radius: 8px;
            padding: 16px 20px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            z-index: 99999;
            animation: slideIn 0.3s ease;
            max-width: 400px;
        }
        .minirag-toast.success {
            border-left: 4px solid #10b981;
        }
        .minirag-toast.error {
            border-left: 4px solid #ef4444;
        }
        .minirag-toast.info {
            border-left: 4px solid #3b82f6;
        }
        @keyframes slideIn {
            from {
                transform: translateX(400px);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
    `;

    const styleSheet = document.createElement('style');
    styleSheet.textContent = styles;
    document.head.appendChild(styleSheet);

    // ========== 工具函数 ==========
    
    function getIssueContent() {
        const selectors = [
            '.issue-description',
            '.issue-body',
            '[data-issue-content]',
            '.markdown-body',
            '#issue_description',
            'textarea[name*="description"]'
        ];
        
        for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element) {
                return element.innerText || element.value || '';
            }
        }
        
        return '';
    }

    function getIssueTitle() {
        let title = '';
        
        const mainTitleSelectors = [
            '#content > h2',
            'h2.inline-flex',
            '.issue-title'
        ];
        
        for (const selector of mainTitleSelectors) {
            const element = document.querySelector(selector);
            if (element) {
                title = element.innerText.trim();
                debugLog('找到主标题:', title);
                break;
            }
        }
        
        const subTitleSelectors = [
            '#content > div.issue > div.subject > div > h3',
            '.subject h3',
            'div.subject h3'
        ];
        
        for (const selector of subTitleSelectors) {
            const element = document.querySelector(selector);
            if (element) {
                const subTitle = element.innerText.trim();
                if (subTitle) {
                    title = title ? `${title}\n${subTitle}` : subTitle;
                    debugLog('找到副标题:', subTitle);
                }
                break;
            }
        }
        
        return title;
    }

    function getIssueNotes() {
        const notes = [];
        const journals = document.querySelectorAll('.journal.has-notes, .journal.has-details');
        
        debugLog('找到 journal 条目数量:', journals.length);
        
        journals.forEach((journal, index) => {
            const noteDiv = journal.querySelector('.wiki');
            if (noteDiv) {
                const noteText = noteDiv.innerText.trim();
                if (noteText) {
                    notes.push(noteText);
                    debugLog(`Note #${index + 1}:`, noteText.substring(0, 100) + '...');
                }
            }
        });
        
        if (notes.length > 0) {
            return '\n\n--- 说明/讨论记录 ---\n\n' + notes.join('\n\n---\n\n');
        }
        
        return '';
    }

    // Toast 通知
    function showToast(message, type = 'info', duration = 3000) {
        const toast = document.createElement('div');
        toast.className = `minirag-toast ${type}`;
        toast.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px;">
                <div style="font-size: 20px;">
                    ${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}
                </div>
                <div style="flex: 1;">
                    <div style="font-weight: 600; margin-bottom: 4px; font-size: 14px;">
                        ${type === 'success' ? '成功' : type === 'error' ? '错误' : '提示'}
                    </div>
                    <div style="font-size: 13px; color: #666;">${message}</div>
                </div>
            </div>
        `;
        
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.style.animation = 'slideIn 0.3s ease reverse';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // 并发控制：执行下一个任务
    function processQueue() {
        if (activeRequests >= MAX_CONCURRENT || taskQueue.length === 0) {
            return;
        }
        
        const task = taskQueue.shift();
        activeRequests++;
        
        task().finally(() => {
            activeRequests--;
            processQueue();
        });
    }

    // 调用 API（带并发控制）
    async function callMiniRAG(prompt) {
        return new Promise((resolve, reject) => {
            const executeTask = () => new Promise((taskResolve, taskReject) => {
                debugLog('===== 发送请求 =====');
                debugLog('API 地址:', API_BASE);
                debugLog('Prompt 长度:', prompt.length);
                
                const requestData = {
                    model: 'minirag-local',
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.7
                };
                
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: API_BASE,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify(requestData),
                    timeout: 300000,
                    anonymous: true,
                    synchronous: false,
                    onload: function(response) {
                        debugLog('===== 收到响应 =====');
                        debugLog('响应状态:', response.status);
                        
                        try {
                            const data = JSON.parse(response.responseText);
                            if (data.choices && data.choices.length > 0) {
                                let content = data.choices[0].message.content;
                                content = content.replace(/\d+\s+GEMINI\.md\s+file.*$/gm, '');
                                content = content.replace(/\d+\s+MCP\s+servers.*$/gm, '');
                                content = content.replace(/\d+\s+skills.*$/gm, '');
                                content = content.trim();
                                
                                taskResolve(content);
                                resolve(content);
                            } else {
                                const error = new Error('无效的响应格式');
                                taskReject(error);
                                reject(error);
                            }
                        } catch (e) {
                            taskReject(e);
                            reject(e);
                        }
                    },
                    onerror: function(error) {
                        const err = new Error('网络请求失败，请确保 MiniRAG 服务正在运行');
                        taskReject(err);
                        reject(err);
                    },
                    onabort: function() {
                        const err = new Error('请求被中止');
                        taskReject(err);
                        reject(err);
                    },
                    ontimeout: function() {
                        const err = new Error('请求超时（5分钟）');
                        taskReject(err);
                        reject(err);
                    }
                });
            });
            
            taskQueue.push(executeTask);
            processQueue();
        });
    }

    // 创建确认对话框
    function showConfirm(message) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'minirag-modal';
            modal.innerHTML = `
                <div class="minirag-modal-content">
                    <div class="minirag-modal-header">⚠️ 确认操作</div>
                    <div style="padding: 20px 0; font-size: 15px; color: #333;">
                        ${message}
                    </div>
                    <div style="display: flex; gap: 10px; justify-content: flex-end;">
                        <button class="minirag-confirm-cancel" style="padding: 8px 20px; background: #e2e8f0; border: none; border-radius: 6px; cursor: pointer;">取消</button>
                        <button class="minirag-confirm-ok" style="padding: 8px 20px; background: #667eea; color: white; border: none; border-radius: 6px; cursor: pointer;">确认</button>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modal);
            
            modal.querySelector('.minirag-confirm-cancel').onclick = () => {
                modal.remove();
                resolve(false);
            };
            
            modal.querySelector('.minirag-confirm-ok').onclick = () => {
                modal.remove();
                resolve(true);
            };
            
            modal.onclick = (e) => {
                if (e.target === modal) {
                    modal.remove();
                    resolve(false);
                }
            };
        });
    }

    // 创建输入对话框
    function showPromptInput(title, placeholder) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'minirag-modal';
            modal.innerHTML = `
                <div class="minirag-modal-content minirag-input-modal">
                    <div class="minirag-modal-header">${title}</div>
                    <textarea class="minirag-textarea" placeholder="${placeholder}"></textarea>
                    <div class="minirag-modal-buttons">
                        <button class="minirag-prompt-cancel" style="padding: 8px 20px; background: #e2e8f0; border: none; border-radius: 6px; cursor: pointer;">取消</button>
                        <button class="minirag-prompt-ok" style="padding: 8px 20px; background: #667eea; color: white; border: none; border-radius: 6px; cursor: pointer;">确认</button>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modal);
            
            const textarea = modal.querySelector('.minirag-textarea');
            textarea.focus();
            
            modal.querySelector('.minirag-prompt-cancel').onclick = () => {
                modal.remove();
                resolve(null);
            };
            
            modal.querySelector('.minirag-prompt-ok').onclick = () => {
                const value = textarea.value.trim();
                modal.remove();
                resolve(value || null);
            };
            
            modal.onclick = (e) => {
                if (e.target === modal) {
                    modal.remove();
                    resolve(null);
                }
            };
        });
    }

    // 更新按钮状态
    function updateButtonState(stateKey) {
        const btnId = {
            'optimize': 'minirag-optimize',
            'technical': 'minirag-technical',
            'tests': 'minirag-tests',
            'impact': 'minirag-impact',
            'custom': 'minirag-custom'
        }[stateKey];
        
        const btn = document.getElementById(btnId);
        if (!btn) return;
        
        btn.classList.remove('loading');
        
        if (state[stateKey].loading) {
            btn.classList.add('loading');
            btn.disabled = true;
        } else {
            btn.disabled = false;
        }
    }

    // ========== 核心功能 ==========

    // 1. 优化 Issue
    async function optimizeIssue() {
        if (state.optimize.loading) {
            showToast('优化任务正在进行中...', 'info');
            return;
        }
        
        const confirmed = await showConfirm('确定要对当前 Issue 进行优化吗？<br><small style="color: #666;">操作将在后台执行，完成后会通知您刷新页面</small>');
        if (!confirmed) return;
        
        const title = getIssueTitle();
        const content = getIssueContent();
        
        if (!content && !title) {
            showToast('未找到 Issue 内容', 'error');
            return;
        }

        state.optimize.loading = true;
        updateButtonState('optimize');
        showToast('正在后台优化 Issue...', 'info');
        
        const prompt = `请帮我优化以下 Issue：

标题：
${title}

内容：
${content}

要求：
1. 优化语言表达，使其更专业清晰
2. 补充必要的技术细节
3. 调整格式，使其易于阅读

使用 redmine-issue-optimizer skill直接进行优化这个issue,当你优化issue后,直接回复一个更新成功,其他不用输出。

**注意：响应内容请控制在800字以内。**`;

        try {
            await callMiniRAG(prompt);
            state.optimize.loading = false;
            updateButtonState('optimize');
            showToast('优化完成！请刷新页面查看结果', 'success', 5000);
        } catch (error) {
            state.optimize.loading = false;
            updateButtonState('optimize');
            showToast(error.message, 'error');
        }
    }

    // 2. 添加技术说明
    async function addTechnicalDetails() {
        if (state.technical.loading) {
            showToast('技术说明生成中...', 'info');
            return;
        }
        
        const confirmed = await showConfirm('确定要生成技术说明吗？<br><small style="color: #666;">操作将在后台执行，完成后会通知您刷新页面</small>');
        if (!confirmed) return;
        
        const title = getIssueTitle();
        const content = getIssueContent();
        const notes = getIssueNotes();
        
        if (!content && !title) {
            showToast('未找到 Issue 内容', 'error');
            return;
        }

        state.technical.loading = true;
        updateButtonState('technical');
        showToast('正在后台生成技术说明...', 'info');
        
        const prompt = `基于以下 Issue，请生成详细的技术说明：

标题：
${title}

内容：
${content}${notes}

要求：
1. 分析可能的技术实现方案
2. 列出关键技术点和注意事项
3. 提供代码示例（如适用）
4. 说明潜在风险和解决方案
5. 如果有说明/讨论记录，也要结合分析

请使用 Markdown 格式返回，必须包含标题层级（如 ## 标题、### 子标题等）。
后面直接通过调用redmin mcp更新这个issue,将结果添加issue的说明(note)中.在你更新issue成功后,直接回复一个更新成功,其他不用输出。

**注意：响应内容请控制在800字以内。**`;

        try {
            await callMiniRAG(prompt);
            state.technical.loading = false;
            updateButtonState('technical');
            showToast('技术说明已添加！请刷新页面查看', 'success', 5000);
        } catch (error) {
            state.technical.loading = false;
            updateButtonState('technical');
            showToast(error.message, 'error');
        }
    }

    // 3. 生成测试用例
    async function generateTestCases() {
        if (state.tests.loading) {
            showToast('测试用例生成中...', 'info');
            return;
        }
        
        const confirmed = await showConfirm('确定要生成测试用例吗？<br><small style="color: #666;">操作将在后台执行，完成后会通知您刷新页面</small>');
        if (!confirmed) return;
        
        const title = getIssueTitle();
        const content = getIssueContent();
        const notes = getIssueNotes();
        
        if (!content && !title) {
            showToast('未找到 Issue 内容', 'error');
            return;
        }

        state.tests.loading = true;
        updateButtonState('tests');
        showToast('正在后台生成测试用例...', 'info');
        
        const prompt = `基于以下 Issue，请生成详细的测试用例：

标题：
${title}

内容：
${content}${notes}

要求：
1. 列出主要的测试场景
2. 包含正常流程和异常流程
3. 提供具体的测试步骤和预期结果
4. 考虑边界条件
5. 如果有说明/讨论记录，也要结合分析

请使用 Markdown 表格格式编写测试用例，表格列包含：测试场景、前置条件、测试步骤、预期结果。
后面直接通过调用redmin mcp更新这个issue,将结果添加issue的说明(note)中.在你更新issue成功后,直接回复一个更新成功,其他不用输出。

**注意：响应内容请控制在800字以内。**`;

        try {
            await callMiniRAG(prompt);
            state.tests.loading = false;
            updateButtonState('tests');
            showToast('测试用例已生成！请刷新页面查看', 'success', 5000);
        } catch (error) {
            state.tests.loading = false;
            updateButtonState('tests');
            showToast(error.message, 'error');
        }
    }

    // 4. 波及分析
    async function impactAnalysis() {
        if (state.impact.loading) {
            showToast('波及分析进行中...', 'info');
            return;
        }
        
        const confirmed = await showConfirm('确定要进行波及分析吗？<br><small style="color: #666;">操作将在后台执行，完成后会通知您刷新页面</small>');
        if (!confirmed) return;
        
        const title = getIssueTitle();
        const content = getIssueContent();
        const notes = getIssueNotes();
        
        if (!content && !title) {
            showToast('未找到 Issue 内容', 'error');
            return;
        }

        state.impact.loading = true;
        updateButtonState('impact');
        showToast('正在后台进行波及分析...', 'info');
        
        const prompt = `基于以下 Issue，请进行详细的波及分析：

标题：
${title}

内容：
${content}${notes}

要求：
1. **请优先使用当前文档库中的信息进行检索分析**，查找相关的模块、组件、接口文档
2. 分析这个 Issue 可能影响的功能模块
3. 列出可能涉及的NSAG产品的代码模块
4. 说明对现有功能的潜在影响
5. 提供测试建议和风险评估

请使用 Markdown 格式返回，必须包含标题层级（如 ## 波及分析、### 影响模块等），方便测试团队评估和测试。
后面直接通过调用redmin mcp更新这个issue,将结果添加issue的说明(note)中.在你更新issue成功后,直接回复一个更新成功,其他不用输出。

**注意：响应内容请控制在800字以内。**`;

        try {
            await callMiniRAG(prompt);
            state.impact.loading = false;
            updateButtonState('impact');
            showToast('波及分析完成！请刷新页面查看', 'success', 5000);
        } catch (error) {
            state.impact.loading = false;
            updateButtonState('impact');
            showToast(error.message, 'error');
        }
    }

    // 5. 自定义 Prompt
    async function customPrompt() {
        if (state.custom.loading) {
            showToast('自定义任务进行中...', 'info');
            return;
        }
        
        // 获取当前 issue URL（去除参数）
        const currentUrl = window.location.href.split('?')[0].split('#')[0];
        
        // 弹出输入框
        const userPrompt = await showPromptInput(
            '🎯 自定义 Prompt',
            '请输入您想要对这个 issue 进行的操作...\n例如：帮我分析这个需求的技术难点和工作量评估'
        );
        
        if (!userPrompt) return;
        
        state.custom.loading = true;
        updateButtonState('custom');
        showToast('正在后台执行自定义任务...', 'info');
        
        const prompt = `对于这个 issue: ${currentUrl}

我想要进行一些更新:
${userPrompt}

**注意：响应内容请控制在800字以内。**`;

        try {
            await callMiniRAG(prompt);
            state.custom.loading = false;
            updateButtonState('custom');
            showToast('自定义任务完成！请刷新页面查看', 'success', 5000);
        } catch (error) {
            state.custom.loading = false;
            updateButtonState('custom');
            showToast(error.message, 'error');
        }
    }

    // ========== UI 创建 ==========
    function createToolbar() {
        const toolbar = document.createElement('div');
        toolbar.className = 'minirag-toolbar';
        toolbar.innerHTML = `
            <button class="minirag-btn" id="minirag-optimize">✨ 优化 Issue</button>
            <button class="minirag-btn" id="minirag-technical">📝 添加说明</button>
            <button class="minirag-btn" id="minirag-tests">🧪 生成测试</button>
            <button class="minirag-btn" id="minirag-impact">🔍 波及分析</button>
            <button class="minirag-btn" id="minirag-custom">🎯 自定义</button>
        `;
        
        document.body.appendChild(toolbar);
        
        document.getElementById('minirag-optimize').onclick = optimizeIssue;
        document.getElementById('minirag-technical').onclick = addTechnicalDetails;
        document.getElementById('minirag-tests').onclick = generateTestCases;
        document.getElementById('minirag-impact').onclick = impactAnalysis;
        document.getElementById('minirag-custom').onclick = customPrompt;
    }

    // ========== 初始化 ==========
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createToolbar);
    } else {
        createToolbar();
    }

    console.log('🎋 Koal Issue Helper - MiniRAG v1.2.0 已加载');
    if (DEBUG) {
        console.log('[MiniRAG] 调试模式已开启');
    }
})();
