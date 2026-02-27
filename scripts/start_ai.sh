#!/bin/bash

# 确保 Homebrew 工具链在 PATH 中（非交互 shell 可能缺失）
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# 获取脚本所在目录的父目录 (即项目根目录)
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 加载 .env 变量
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    # shellcheck source=/dev/null
    source "$PROJECT_ROOT/.env"
    set +a
fi

# 确定要使用的 Agent 类型
# 优先级: 命令行参数 > 环境变量 AGENT > .env 中的 DEFAULT_AGENT > 默认为 claude
AGENT_TYPE="${1:-${AGENT:-${DEFAULT_AGENT:-claude}}}"

# 根据类型设置二进制路径和参数
# CLAUDE_ARGS / GEMINI_ARGS 可在 .env 中覆盖，留空则使用下方默认值
case "$AGENT_TYPE" in
    claude)
        BINARY_PATH="$CLAUDE_BINARY"
        read -ra AGENT_ARGS <<< "${CLAUDE_ARGS:---dangerously-skip-permissions}"
        ;;
    gemini)
        BINARY_PATH="$GEMINI_BINARY"
        read -ra AGENT_ARGS <<< "${GEMINI_ARGS:---yolo --include-directories $WORKSPACE_PATH}"
        ;;
    *)
        echo "错误: 不支持的 Agent 类型 '$AGENT_TYPE' (支持: claude, gemini)"
        exit 1
        ;;
esac

# 检查必要变量
if [ -z "$WORKSPACE_PATH" ] || [ -z "$AGENT_API_BINARY" ] || [ -z "$BINARY_PATH" ]; then
    echo "错误: 请确保 .env 文件中配置了 WORKSPACE_PATH, AGENT_API_BINARY 以及对应的 ${AGENT_TYPE^^}_BINARY"
    exit 1
fi

# 设置 agentapi 端口 (默认 3284)
AGENT_API_PORT="${AGENT_API_PORT:-61000}"

echo "正在以 $AGENT_TYPE 模式启动 MiniRAG-Local..."

# 1. 启动 agentapi
ps aux | grep agentapi | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null
cd "$WORKSPACE_PATH"
"$AGENT_API_BINARY" server --port="$AGENT_API_PORT" --type="$AGENT_TYPE" -- "$BINARY_PATH" "${AGENT_ARGS[@]}" > /tmp/agentapi.log 2>&1 &

# 2. 启动 OpenAI 兼容层
ps aux | grep openai_proxy.js | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null
node "$PROJECT_ROOT/proxy/openai_proxy.js" > /tmp/openai_proxy.log 2>&1 &

# 3. 可选：启动 DingTalk 独立机器人
if [ -n "$DINGTALK_APP_KEY" ] && [ -n "$DINGTALK_APP_SECRET" ]; then
    ps aux | grep "dingtalk/bot.js" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null
    node "$PROJECT_ROOT/dingtalk/bot.js" > /tmp/dingtalk_bot.log 2>&1 &
    echo "DingTalk 机器人已启动 (日志: /tmp/dingtalk_bot.log)"
fi

echo "服务已就绪！"
echo "Agent 类型: $AGENT_TYPE"
echo "AgentAPI 端口: $AGENT_API_PORT"
echo "OpenAI 接口地址: http://localhost:${PORT:-62000}/v1/chat/completions"
echo "工作目录: $WORKSPACE_PATH"
