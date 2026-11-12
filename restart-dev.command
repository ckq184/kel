#!/bin/bash
# restart-dev.command — 一键重启 CKQClaw 开发环境（后端 3000 + Vite 5173 + 桌面端）
# 用法：Finder 双击，或终端执行 ./restart-dev.command
# 全部服务后台运行，脚本结束即可关闭终端窗口，不影响服务。
# 日志：/tmp/ckqclaw-dev.log（前后端）、/tmp/ckqclaw-desktop.log（桌面端）

set -u
cd "$(dirname "$0")" || exit 1

DEV_LOG=/tmp/ckqclaw-dev.log
DESKTOP_LOG=/tmp/ckqclaw-desktop.log

echo "[ckqclaw] stopping old services..."
lsof -ti:3000 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null
lsof -ti:5173 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null
pkill -f "Personnal-agent-main/node_modules/electron" 2>/dev/null
pkill -f "tsx src/index.ts" 2>/dev/null

# 等端口释放（最多 10 秒）
for _ in $(seq 1 10); do
  if ! lsof -ti:3000 -sTCP:LISTEN >/dev/null 2>&1 &&
    ! lsof -ti:5173 -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
echo "[ckqclaw] old services stopped, ports freed"

echo "[ckqclaw] starting backend + Vite (log: $DEV_LOG)..."
nohup npm run dev:all >>"$DEV_LOG" 2>&1 &

# 等后端健康（最多 40 秒）
tries=0
until curl -s -m 2 http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"status":"healthy"'; do
  tries=$((tries + 1))
  if [ "$tries" -ge 20 ]; then
    echo "[ckqclaw] backend did not become healthy in time; see $DEV_LOG"
    exit 1
  fi
  sleep 2
done
echo "[ckqclaw] backend healthy (3000)"

echo "[ckqclaw] starting desktop (log: $DESKTOP_LOG)..."
CKQCLAW_RENDERER_URL=http://127.0.0.1:5173 nohup npm run desktop:dev >>"$DESKTOP_LOG" 2>&1 &

# 等桌面端进程出现（最多 20 秒）
tries=0
sleep 2
until pgrep -f "Personnal-agent-main/node_modules/electron/dist" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 10 ]; then
    echo "[ckqclaw] desktop did not start in time; see $DESKTOP_LOG"
    exit 1
  fi
  sleep 2
done

echo "[ckqclaw] restart complete:"
echo "  backend : http://localhost:3000  ✅"
echo "  vite    : http://localhost:5173  ✅"
echo "  desktop : running                ✅"
echo "  logs    : tail -f $DEV_LOG"
echo "            tail -f $DESKTOP_LOG"
