#!/bin/bash
# start-desktop.command — macOS 版一键拉起脚本（等价 start-desktop.bat）
# 双击运行（Finder）或 `open start-desktop.command`：
#   1. 探测前后端服务（5173 Vite / 3000 后端），已就绪则跳过启动
#   2. 未就绪则后台拉起 `npm run dev:all`，日志追加到 /tmp/ckqclaw-dev.log
#   3. 服务就绪后启动 Electron 桌面端，连接 Vite 热更新（5173）
# 停止：桌面端 Cmd+Q；后端 `make stop` + `lsof -ti:5173 -sTCP:LISTEN | xargs kill`

set -u
cd "$(dirname "$0")" || exit 1

DEV_LOG=/tmp/ckqclaw-dev.log

services_up() {
  curl -s -o /dev/null -m 2 http://127.0.0.1:5173 &&
    curl -s -o /dev/null -m 2 http://127.0.0.1:3000
}

if services_up; then
  echo "[ckqclaw] services already running, skip backend start"
else
  echo "[ckqclaw] starting backend + Vite (background, log: $DEV_LOG)..."
  nohup npm run dev:all >>"$DEV_LOG" 2>&1 &
fi

# 等待服务就绪（最长约 2 分钟；bat 版无上限，这里加超时防止死循环）
tries=0
until services_up; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "[ckqclaw] services did not come up in time; see $DEV_LOG"
    exit 1
  fi
  sleep 2
done

echo "[ckqclaw] services ready, launching desktop..."
export CKQCLAW_RENDERER_URL=http://127.0.0.1:5173
exec npm run desktop:dev
