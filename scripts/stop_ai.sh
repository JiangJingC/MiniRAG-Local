#!/bin/bash

echo "正在停止 MiniRAG-Local 服务..."

# 停止 agentapi
AGENTAPI_PIDS=$(ps aux | grep agentapi | grep -v grep | awk '{print $2}')
if [ -n "$AGENTAPI_PIDS" ]; then
    echo "停止 agentapi (PIDs: $AGENTAPI_PIDS)"
    echo "$AGENTAPI_PIDS" | xargs kill -9
else
    echo "未发现 agentapi 进程"
fi

# 停止 openai_proxy
PROXY_PIDS=$(ps aux | grep openai_proxy.js | grep -v grep | awk '{print $2}')
if [ -n "$PROXY_PIDS" ]; then
    echo "停止 openai_proxy (PIDs: $PROXY_PIDS)"
    echo "$PROXY_PIDS" | xargs kill -9
else
    echo "未发现 openai_proxy 进程"
fi

# 清理日志（可选）
# rm -f /tmp/agentapi.log /tmp/openai_proxy.log

echo "服务已停止！"
