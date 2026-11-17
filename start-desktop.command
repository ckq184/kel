#!/bin/bash
# start-desktop.command — macOS 版一键拉起脚本（等价 start-desktop.bat）
# 双击运行（Finder）或 `open start-desktop.command`：
#   1. 探测前后端服务（5173 Vite / 3000 后端），已就绪且属于本仓则跳过启动；
#      被其他仓库（如 Personnal-agent-main）占用则明确报错退出，不静默连错页面
#   2. 未就绪则后台拉起 `npm run dev:all`，日志追加到 /tmp/ckqclaw-dev.log
#   3. 服务就绪后启动 Electron 桌面端，连接 Vite 热更新（5173）
# 停止：桌面端 Cmd+Q；后端 `make stop` + `lsof -ti:5173 -sTCP:LISTEN | xargs kill`

set -u
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR" || exit 1

DEV_LOG=/tmp/ckqclaw-dev.log

services_up() {
  curl -s -o /dev/null -m 2 http://127.0.0.1:5173 &&
    curl -s -o /dev/null -m 2 http://127.0.0.1:3000
}

# 端口监听进程是否属于本仓（命令行含本仓绝对路径）
port_owned_by_repo() {
  local port="$1" pid
  pid="$(lsof -ti:"$port" -sTCP:LISTEN 2>/dev/null | head -n1)"
  [ -z "$pid" ] && return 1
  ps -o command= -p "$pid" 2>/dev/null | grep -qF "$REPO_DIR"
}

if services_up; then
  if port_owned_by_repo 3000 && port_owned_by_repo 5173; then
    echo "[ckqclaw] services already running (this repo), skip backend start"
  else
    echo "[ckqclaw] ERROR: 3000/5173 已被其他仓库/进程占用（例如 Personnal-agent-main），" >&2
    echo "  桌面端若继续会加载到错误页面。请先停掉占用端口的服务后重试：" >&2
    echo "  lsof -ti:3000 -sTCP:LISTEN | xargs kill; lsof -ti:5173 -sTCP:LISTEN | xargs kill" >&2
    exit 1
  fi
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
