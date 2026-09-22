#!/usr/bin/env bash
# dev-browser.sh — tools/dev-browser.ps1 的 bash 薄封装（方便在 git bash / MINGW64 里用）
#
#   bash tools/dev-browser.sh status     # 看进程数 + CPU + 端口
#   bash tools/dev-browser.sh down       # 清理 headless chrome（整棵进程树）
#   bash tools/dev-browser.sh up         # 先清后开，只开 1 个实例
#   bash tools/dev-browser.sh cpu        # 只看 CPU
#
# 规矩：**重开前必须先 down**，用完立刻 down。绝不让两个实例叠着跑。
set -euo pipefail
cd "$(dirname "$0")/.."
exec powershell -NoProfile -ExecutionPolicy Bypass -File tools/dev-browser.ps1 "$@"
