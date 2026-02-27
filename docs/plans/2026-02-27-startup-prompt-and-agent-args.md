# Startup Prompt & Agent Args Externalization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a configurable `STARTUP_PROMPT` env var that is sent to the AI agent once on startup, and externalize Claude/Gemini CLI args (`CLAUDE_ARGS`, `GEMINI_ARGS`) from hardcoded values in `start_ai.sh` to `.env`.

**Architecture:** All changes are confined to `scripts/start_ai.sh` and `.env.example`. No proxy or bot code is touched. `start_ai.sh` reads `CLAUDE_ARGS`/`GEMINI_ARGS` from env (with safe defaults), and after agentapi is ready, posts `STARTUP_PROMPT` via curl to `$AGENT_API_URL/message`, then waits for the agent to finish processing before declaring the service ready.

**Tech Stack:** Bash, curl, agentapi REST API (`/status`, `/message`)

---

### Task 1: Externalize agent CLI args to `.env.example`

**Files:**
- Modify: `.env.example`

**Step 1: Add the new variables to `.env.example`**

Open `.env.example` and append the following section after the existing AI Agent section:

```bash
# Claude CLI 额外参数（传递给 claude 命令）
# 默认: --dangerously-skip-permissions
# 可添加: --model claude-opus-4-5 等
CLAUDE_ARGS=--dangerously-skip-permissions

# Gemini CLI 额外参数（传递给 gemini 命令）
# 默认: --yolo --include-directories <WORKSPACE_PATH>
# 注意: $WORKSPACE_PATH 会在 shell 中自动展开
GEMINI_ARGS=--yolo --include-directories /path/to/workspace

# ========================================
# 启动提示词配置
# ========================================

# agentapi 就绪后自动发送一次给 AI Agent，用于规范行为
# 留空则不发送
# 示例: 你是一个知识库助手，请保持回答简洁准确，不超过500字
STARTUP_PROMPT=
```

**Step 2: Verify the file looks correct**

Run: `cat /Users/fightshadow/code/my/MiniRAG-Local/.env.example | tail -30`
Expected: new variables visible at the end

**Step 3: Commit**

```bash
git add .env.example
git commit -m "feat: add CLAUDE_ARGS, GEMINI_ARGS, STARTUP_PROMPT to .env.example"
```

---

### Task 2: Use `CLAUDE_ARGS` / `GEMINI_ARGS` in `start_ai.sh`

**Files:**
- Modify: `scripts/start_ai.sh:22-35`

**Step 1: Replace hardcoded AGENT_ARGS with env-backed defaults**

Current code (lines 22-35):
```bash
case "$AGENT_TYPE" in
    claude)
        BINARY_PATH="$CLAUDE_BINARY"
        AGENT_ARGS="--dangerously-skip-permissions"
        ;;
    gemini)
        BINARY_PATH="$GEMINI_BINARY"
        AGENT_ARGS="--yolo --include-directories $WORKSPACE_PATH"
        ;;
    *)
        echo "错误: 不支持的 Agent 类型 '$AGENT_TYPE' (支持: claude, gemini)"
        exit 1
        ;;
esac
```

Replace with:
```bash
case "$AGENT_TYPE" in
    claude)
        BINARY_PATH="$CLAUDE_BINARY"
        AGENT_ARGS="${CLAUDE_ARGS:---dangerously-skip-permissions}"
        ;;
    gemini)
        BINARY_PATH="$GEMINI_BINARY"
        AGENT_ARGS="${GEMINI_ARGS:---yolo --include-directories $WORKSPACE_PATH}"
        ;;
    *)
        echo "错误: 不支持的 Agent 类型 '$AGENT_TYPE' (支持: claude, gemini)"
        exit 1
        ;;
esac
```

**Step 2: Verify diff is correct**

Run: `git diff scripts/start_ai.sh`
Expected: only the two `AGENT_ARGS=` lines changed, fallback defaults match old hardcoded values

**Step 3: Commit**

```bash
git add scripts/start_ai.sh
git commit -m "feat: read CLAUDE_ARGS/GEMINI_ARGS from env with hardcoded defaults"
```

---

### Task 3: Add startup prompt logic to `start_ai.sh`

**Files:**
- Modify: `scripts/start_ai.sh` (after agentapi start block, before proxy start)

**Step 1: Add a helper function to wait for agentapi**

After the `echo "正在以 $AGENT_TYPE 模式启动 MiniRAG-Local..."` line and before `# 1. 启动 agentapi`, add a helper function:

```bash
# ── 等待 agentapi 就绪 ──────────────────────────────────────────────────────
wait_for_stable() {
    local url="${AGENT_API_URL:-http://localhost:${AGENT_API_PORT:-61000}}"
    local max_attempts="${1:-30}"
    for i in $(seq 1 "$max_attempts"); do
        local status
        status=$(curl -s "$url/status" 2>/dev/null | grep -o '"stable"' || true)
        if [ -n "$status" ]; then
            return 0
        fi
        sleep 1
    done
    return 1
}
```

**Step 2: After agentapi start block, add startup prompt block**

Currently block `# 1. 启动 agentapi` ends at:
```bash
"$AGENT_API_BINARY" server --port="$AGENT_API_PORT" --type="$AGENT_TYPE" -- "$BINARY_PATH" $AGENT_ARGS > /tmp/agentapi.log 2>&1 &
```

After that line, add:

```bash
# 1b. 发送 Startup Prompt（如果配置了）
if [ -n "$STARTUP_PROMPT" ]; then
    echo "等待 agentapi 就绪以发送 startup prompt..."
    if wait_for_stable 30; then
        local api_url="${AGENT_API_URL:-http://localhost:${AGENT_API_PORT:-61000}}"
        curl -s -X POST "$api_url/message" \
            -H 'Content-Type: application/json' \
            -d "{\"content\": $(printf '%s' "$STARTUP_PROMPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'), \"type\": \"user\"}" \
            > /dev/null
        echo "Startup prompt 已发送，等待 AI 处理完毕..."
        wait_for_stable 60
        echo "AI 初始化完成。"
    else
        echo "警告: agentapi 在 30 秒内未就绪，跳过 startup prompt"
    fi
fi
```

> Note: `python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'` safely JSON-encodes the prompt string (handles quotes, newlines, special characters).

**Step 3: Smoke test manually**

Set `STARTUP_PROMPT=` (empty) in `.env` and run:
```bash
./scripts/stop_ai.sh && ./scripts/start_ai.sh claude
```
Expected: no "等待 agentapi" output, service starts as before.

Then set `STARTUP_PROMPT=你好，请记住你是知识库助手` in `.env` and restart.
Expected: output shows "等待 agentapi 就绪以发送 startup prompt..." → "AI 初始化完成."

**Step 4: Commit**

```bash
git add scripts/start_ai.sh
git commit -m "feat: send STARTUP_PROMPT to agentapi on startup"
```

---

### Task 4: Final verification

**Step 1: Run full startup with both features active**

```bash
# In .env, set:
# CLAUDE_ARGS=--dangerously-skip-permissions
# STARTUP_PROMPT=你是一个知识库助手，请保持回答简洁准确。

./scripts/stop_ai.sh && ./scripts/start_ai.sh claude
```

Expected output (in order):
```
正在以 claude 模式启动 MiniRAG-Local...
等待 agentapi 就绪以发送 startup prompt...
Startup prompt 已发送，等待 AI 处理完毕...
AI 初始化完成。
DingTalk 机器人已启动 (日志: /tmp/dingtalk_bot.log)
服务已就绪！
...
```

**Step 2: Verify CLAUDE_ARGS is used**

```bash
ps aux | grep agentapi
```
Expected: agentapi process line contains `--dangerously-skip-permissions`

**Step 3: Verify with empty STARTUP_PROMPT**

Comment out / empty `STARTUP_PROMPT=` in `.env`, restart.
Expected: startup completes without waiting, no "等待 agentapi" output.
