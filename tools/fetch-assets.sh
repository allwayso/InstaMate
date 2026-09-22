#!/usr/bin/env bash
# 薄封装：真正的实现在 fetch-assets.mjs（Node 跨平台，不依赖 bash/curl）
set -euo pipefail
cd "$(dirname "$0")/.."
exec node tools/fetch-assets.mjs "$@"
