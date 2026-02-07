// ==UserScript==
// @name         Koal Issue Helper - MiniRAG
// @namespace    http://tampermonkey.net/
// @version      1.0.0
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
    const DEBUG = true; // 设置为 true 开启调试日志，false 关闭
    const API_BASE = 'http://localhost:8000/v1/chat/completions';
    
    // 状态管理
    const state = {
        optimize: { loading: false, result: null },
        technical: { loading: false, result: null },
        tests: { loading: false, result: null },
        impact: { loading: false, result: null }
    };
    
    // 调试日志函数
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
            animation: pulse 1.5s ease-in-out infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }
        .minirag-btn.has-result {
            background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
            position: relative;
        }
        .minirag-btn.has-result::after {
            content: '●';
            position: absolute;
            top: -5px;
            right: -5px;
            width: 12px;
            height: 12px;
            background: #10b981;
            border-radius: 50%;
            border: 2px solid white;
            animation: blink 2s ease-in-out infinite;
        }
        @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
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
            max-width: 700px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        }
        .minirag-modal-header {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 16px;
            color: #333;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .minirag-close {
            cursor: pointer;
            font-size: 24px;
            color: #999;
            line-height: 1;
        }
        .minirag-close:hover {
            color: #333;
        }
        .minirag-response {
            background: #f7f9fc;
            border-radius: 8px;
            padding: 16px;
            margin-top: 12px;
            line-height: 2;
            color: #333;
            font-size: 14px;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .minirag-loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            color: #667eea;
        }
        .minirag-spinner {
            border: 3px solid #f3f3f3;
            border-top: 3px solid #667eea;
            border-radius: 50%;
            width: 30px;
            height: 30px;
            animation: spin 1s linear infinite;
            margin-right: 12px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .minirag-error {
            color: #e53e3e;
            background: #fff5f5;
            border-left: 4px solid #e53e3e;
            padding: 12px;
            border-radius: 4px;
            margin-top: 12px;
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
    `;

    // ========== 注入样式 ==========
    const styleSheet = document.createElement('style');
    styleSheet.textContent = styles;
    document.head.appendChild(styleSheet);

    // ========== 工具函数 ==========
    
    // 获取当前页面的 Issue 内容
    function getIssueContent() {
        // 尝试多种选择器，适配不同的页面结构
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

    // 获取 Issue 标题
    function getIssueTitle() {
        let title = '';
        
        // 1. 获取主标题（如：设计文档 #261446）
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
        
        // 2. 获取副标题（如：[设计]适配乐研硬件机型）
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

    // 获取 Issue Notes（说明/讨论）
    function getIssueNotes() {
        const notes = [];
        
        // 查找所有符合条件的 journal 条目
        const journals = document.querySelectorAll('.journal.has-notes, .journal.has-details');
        
        debugLog('找到 journal 条目数量:', journals.length);
        
        journals.forEach((journal, index) => {
            // 提取说明内容
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

    // 调用 OpenAI 标准接口
    async function callMiniRAG(prompt) {
        debugLog('===== 发送请求 =====');
        debugLog('API 地址:', API_BASE);
        debugLog('Prompt 内容:', prompt);
        
        return new Promise((resolve, reject) => {
            const requestData = {
                model: 'minirag-local',
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.7
            };
            
            debugLog('请求体:', JSON.stringify(requestData, null, 2));
            
            GM_xmlhttpRequest({
                method: 'POST',
                url: API_BASE,
                headers: {
                    'Content-Type': 'application/json'
                },
                data: JSON.stringify(requestData),
                timeout: 300000, // 5分钟超时（300秒 = 300000毫秒），与 proxy 保持一致
                anonymous: true, // 防止浏览器干扰
                synchronous: false, // 明确异步模式
                onload: function(response) {
                    debugLog('===== 收到响应 =====');
                    debugLog('响应状态:', response.status);
                    debugLog('响应原文:', response.responseText);
                    
                    try {
                        const data = JSON.parse(response.responseText);
                        debugLog('解析后的数据:', data);
                        
                        if (data.choices && data.choices.length > 0) {
                            let content = data.choices[0].message.content;
                            debugLog('AI 原始回复:', content);
                            
                            // 清理 Gemini 底部信息
                            content = content.replace(/\d+\s+GEMINI\.md\s+file.*$/gm, '');
                            content = content.replace(/\d+\s+MCP\s+servers.*$/gm, '');
                            content = content.replace(/\d+\s+skills.*$/gm, '');
                            content = content.trim();
                            
                            debugLog('清理后的回复:', content);
                            resolve(content);
                        } else {
                            const error = new Error('无效的响应格式');
                            debugLog('错误:', error);
                            reject(error);
                        }
                    } catch (e) {
                        debugLog('解析错误:', e);
                        reject(e);
                    }
                },
                onerror: function(error) {
                    debugLog('网络错误:', error);
                    // 检查是否是 background shutdown
                    if (error && error.error === 'background shutdown') {
                        reject(new Error('请求被浏览器中断（标签页进入后台），请保持标签页激活状态'));
                    } else {
                        reject(new Error('网络请求失败，请确保 MiniRAG 服务正在运行'));
                    }
                },
                onabort: function() {
                    debugLog('请求被中止');
                    reject(new Error('请求被中止，请重试'));
                },
                ontimeout: function() {
                    debugLog('请求超时（5分钟）');
                    reject(new Error('请求超时（已等待5分钟），请检查 MiniRAG 服务状态或减少内容长度'));
                }
            });
        });
    }

    // 创建确认对话框
    function showConfirm(message) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'minirag-modal';
            modal.innerHTML = `
                <div class="minirag-modal-content" style="max-width: 450px;">
                    <div class="minirag-modal-header">
                        <span>⚠️ 确认操作</span>
                    </div>
                    <div style="padding: 20px 0; font-size: 15px; color: #333;">
                        ${message}
                    </div>
                    <div style="padding: 12px; background: #fff3cd; border-radius: 6px; margin: 10px 0; font-size: 13px; color: #856404;">
                        <strong>⚠️ 重要提示：</strong>请在 AI 处理完成前保持此标签页激活状态，切换标签页可能导致请求中断。
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

    // 创建模态框（可关闭，带结束会话按钮）
    function createModal(title, content, stateKey = null, canClose = true) {
        const modal = document.createElement('div');
        modal.className = 'minirag-modal';
        
        const endSessionBtn = stateKey ? `
            <button class="minirag-end-session" style="padding: 6px 12px; background: #ef4444; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; margin-left: 10px;">结束会话</button>
        ` : '';
        
        const closeBtn = canClose ? `<span class="minirag-close">×</span>` : '';
        
        modal.innerHTML = `
            <div class="minirag-modal-content">
                <div class="minirag-modal-header">
                    <span>${title}</span>
                    <div>
                        ${endSessionBtn}
                        ${closeBtn}
                    </div>
                </div>
                <div class="minirag-response">${content}</div>
            </div>
        `;
        
        if (canClose) {
            const closeBtnEl = modal.querySelector('.minirag-close');
            if (closeBtnEl) {
                closeBtnEl.onclick = () => modal.remove();
            }
            
            // 只有可关闭的弹框才允许点击外部关闭
            modal.onclick = (e) => {
                if (e.target === modal) modal.remove();
            };
        }
        
        if (stateKey) {
            const endBtn = modal.querySelector('.minirag-end-session');
            if (endBtn) {
                endBtn.onclick = async () => {
                    const confirmed = await showConfirm('确定要结束当前会话吗？结束后将清除当前结果。');
                    if (confirmed) {
                        state[stateKey].result = null;
                        state[stateKey].loading = false;
                        updateButtonState(stateKey);
                        modal.remove();
                    }
                };
            }
        }
        
        document.body.appendChild(modal);
        return modal;
    }

    // 显示加载状态（不可关闭）
    function showLoading(title) {
        const modal = createModal(title, `
            <div class="minirag-loading">
                <div class="minirag-spinner"></div>
                <div style="text-align: center;">
                    <div style="margin-bottom: 8px; font-size: 15px; font-weight: 500;">AI 正在思考中...</div>
                    <div style="font-size: 13px; color: #999;">请保持标签页激活，切换可能导致中断</div>
                </div>
            </div>
        `, null, false);  // canClose = false，加载中不允许关闭
        return modal;
    }

    // 更新按钮状态
    function updateButtonState(stateKey) {
        const btnId = {
            'optimize': 'minirag-optimize',
            'technical': 'minirag-technical',
            'tests': 'minirag-tests',
            'impact': 'minirag-impact'
        }[stateKey];
        
        const btn = document.getElementById(btnId);
        if (!btn) return;
        
        btn.classList.remove('loading', 'has-result');
        
        if (state[stateKey].loading) {
            btn.classList.add('loading');
            btn.disabled = true;
        } else if (state[stateKey].result) {
            btn.classList.add('has-result');
            btn.disabled = false;
        } else {
            btn.disabled = false;
        }
    }

    // ========== 核心功能 ==========

    // 1. 优化 Issue
    async function optimizeIssue() {
        // 🔒 防止重复点击 - 立即检查并锁定
        if (state.optimize.loading) {
            createModal('⚠️ 提示', '优化任务正在进行中，请稍候...请勿重复点击。');
            return;
        }
        
        // 如果有缓存结果，直接显示
        if (state.optimize.result) {
            createModal('✨ 优化结果', state.optimize.result, 'optimize');
            return;
        }
        
        // 确认操作
        const confirmed = await showConfirm('确定要对当前 Issue 进行优化吗？');
        if (!confirmed) return;
        
        // 🔒 再次检查（防止确认期间状态变化）
        if (state.optimize.loading) {
            createModal('⚠️ 提示', '优化任务正在进行中，请稍候...');
            return;
        }
        
        const title = getIssueTitle();
        const content = getIssueContent();
        const notes = getIssueNotes();
        
        if (!content && !title) {
            createModal('❌ 错误', '未找到 Issue 内容，请确认当前页面是否为 Issue 页面');
            return;
        }

        // 🔒 立即设置 loading 状态并更新 UI
        state.optimize.loading = true;
        updateButtonState('optimize');
        
        const loadingModal = showLoading('🚀 优化 Issue');
        
        const prompt = `请帮我优化以下 Issue：

标题：
${title}

内容：
${content}${notes}

要求：
1. 优化语言表达，使其更专业清晰
2. 补充必要的技术细节
3. 调整格式，使其易于阅读
4. 保持原意不变
5. 如果有说明/讨论记录，也要考虑进去

请使用 Markdown 格式返回，必须包含标题层级（如 ## 标题、### 子标题等），直接返回优化后的完整内容。不需要调用redmine mcp进行更新issue`;

        try {
            const response = await callMiniRAG(prompt);
            state.optimize.result = response;
            state.optimize.loading = false;
            updateButtonState('optimize');
            loadingModal.remove();
            createModal('✨ 优化结果', response, 'optimize');
        } catch (error) {
            state.optimize.loading = false;
            updateButtonState('optimize');
            loadingModal.remove();
            createModal('❌ 错误', `<div class="minirag-error">${error.message}</div>`);
        }
    }

    // 2. 添加技术说明
    async function addTechnicalDetails() {
        // 🔒 防止重复点击
        if (state.technical.loading) {
            createModal('⚠️ 提示', '技术说明生成任务正在进行中，请稍候...请勿重复点击。');
            return;
        }
        
        if (state.technical.result) {
            createModal('📋 技术说明', state.technical.result, 'technical');
            return;
        }
        
        const confirmed = await showConfirm('确定要生成技术说明吗？');
        if (!confirmed) return;
        
        // 🔒 再次检查
        if (state.technical.loading) {
            createModal('⚠️ 提示', '技术说明生成任务正在进行中，请稍候...');
            return;
        }
        
        const title = getIssueTitle();
        const content = getIssueContent();
        const notes = getIssueNotes();
        
        if (!content && !title) {
            createModal('❌ 错误', '未找到 Issue 内容');
            return;
        }

        // 🔒 立即锁定
        state.technical.loading = true;
        updateButtonState('technical');
        
        const loadingModal = showLoading('📝 生成技术说明');
        
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

请使用 Markdown 格式返回，必须包含标题层级（如 ## 标题、### 子标题等）。`;

        try {
            const response = await callMiniRAG(prompt);
            state.technical.result = response;
            state.technical.loading = false;
            updateButtonState('technical');
            loadingModal.remove();
            createModal('📋 技术说明', response, 'technical');
        } catch (error) {
            state.technical.loading = false;
            updateButtonState('technical');
            loadingModal.remove();
            createModal('❌ 错误', `<div class="minirag-error">${error.message}</div>`);
        }
    }

    // 3. 生成测试用例
    async function generateTestCases() {
        // 🔒 防止重复点击
        if (state.tests.loading) {
            createModal('⚠️ 提示', '测试用例生成任务正在进行中，请稍候...请勿重复点击。');
            return;
        }
        
        if (state.tests.result) {
            createModal('✅ 测试用例', state.tests.result, 'tests');
            return;
        }
        
        const confirmed = await showConfirm('确定要生成测试用例吗？');
        if (!confirmed) return;
        
        // 🔒 再次检查
        if (state.tests.loading) {
            createModal('⚠️ 提示', '测试用例生成任务正在进行中，请稍候...');
            return;
        }
        
        const title = getIssueTitle();
        const content = getIssueContent();
        const notes = getIssueNotes();
        
        if (!content && !title) {
            createModal('❌ 错误', '未找到 Issue 内容');
            return;
        }

        // 🔒 立即锁定
        state.tests.loading = true;
        updateButtonState('tests');
        
        const loadingModal = showLoading('🧪 生成测试用例');
        
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

请使用 Markdown 表格格式返回测试用例，表格列包含：测试场景、前置条件、测试步骤、预期结果。必须包含标题层级（如 ## 测试用例）。`;

        try {
            const response = await callMiniRAG(prompt);
            state.tests.result = response;
            state.tests.loading = false;
            updateButtonState('tests');
            loadingModal.remove();
            createModal('✅ 测试用例', response, 'tests');
        } catch (error) {
            state.tests.loading = false;
            updateButtonState('tests');
            loadingModal.remove();
            createModal('❌ 错误', `<div class="minirag-error">${error.message}</div>`);
        }
    }

    // 4. 波及分析
    async function impactAnalysis() {
        // 🔒 防止重复点击
        if (state.impact.loading) {
            createModal('⚠️ 提示', '波及分析任务正在进行中，请稍候...请勿重复点击。');
            return;
        }
        
        if (state.impact.result) {
            createModal('🔍 波及分析', state.impact.result, 'impact');
            return;
        }
        
        const confirmed = await showConfirm('确定要进行波及分析吗？');
        if (!confirmed) return;
        
        // 🔒 再次检查
        if (state.impact.loading) {
            createModal('⚠️ 提示', '波及分析任务正在进行中，请稍候...');
            return;
        }
        
        const title = getIssueTitle();
        const content = getIssueContent();
        const notes = getIssueNotes();
        
        if (!content && !title) {
            createModal('❌ 错误', '未找到 Issue 内容');
            return;
        }

        // 🔒 立即锁定
        state.impact.loading = true;
        updateButtonState('impact');
        
        const loadingModal = showLoading('🔍 波及分析');
        
        const prompt = `基于以下 Issue，请进行详细的波及分析：

标题：
${title}

内容：
${content}${notes}

要求：
1. **请优先使用当前文档库中的信息进行检索分析**，查找相关的模块、组件、接口文档
2. 分析这个 Issue 可能影响的功能模块
3. 列出可能涉及的代码模块和依赖关系
4. 说明对现有功能的潜在影响
5. 提供测试建议和风险评估
6. 如果文档库中有相关的架构文档、接口文档或模块说明，请引用并关联分析
7. 如果有说明/讨论记录，也要结合分析

请使用 Markdown 格式返回，必须包含标题层级（如 ## 波及分析、### 影响模块等），方便测试团队评估和测试。`;

        try {
            const response = await callMiniRAG(prompt);
            state.impact.result = response;
            state.impact.loading = false;
            updateButtonState('impact');
            loadingModal.remove();
            createModal('🔍 波及分析', response, 'impact');
        } catch (error) {
            state.impact.loading = false;
            updateButtonState('impact');
            loadingModal.remove();
            createModal('❌ 错误', `<div class="minirag-error">${error.message}</div>`);
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
        `;
        
        document.body.appendChild(toolbar);
        
        // 绑定事件
        document.getElementById('minirag-optimize').onclick = optimizeIssue;
        document.getElementById('minirag-technical').onclick = addTechnicalDetails;
        document.getElementById('minirag-tests').onclick = generateTestCases;
        document.getElementById('minirag-impact').onclick = impactAnalysis;
    }

    // ========== 初始化 ==========
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createToolbar);
    } else {
        createToolbar();
    }

    console.log('🎋 Koal Issue Helper - MiniRAG 已加载');
    if (DEBUG) {
        console.log('[MiniRAG] 调试模式已开启，可在控制台查看详细日志');
    }
})();
