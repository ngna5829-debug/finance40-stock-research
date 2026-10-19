#!/bin/zsh
set -eu
TASK_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$TASK_DIR"
TASK_PYTHON="/Users/huang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
if [[ ! -x "$TASK_PYTHON" ]]; then TASK_PYTHON="$(command -v python3)"; fi
if "$TASK_PYTHON" launch_check.py; then
  open "http://127.0.0.1:8775/index.html"
  exit 0
else
  TASK_CHECK_STATUS=$?
  if [[ "$TASK_CHECK_STATUS" -eq 2 ]]; then exit 2; fi
fi
print "正在启动V5；自动采集美股市值前100普通股/ADR。"
print "保持电脑及窗口运行；Control+C停止。密钥仅从既有本机环境读取。"
"$TASK_PYTHON" bridge.py --port 8775 --open
