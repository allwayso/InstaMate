#!/usr/bin/env bash
# 构建组队提案 PDF：md -> pandoc html -> postfix 修表格列宽 -> chrome print-to-pdf
# 注意：提案只是比赛提交材料，不是真实实施计划；真实计划看 docs/Collaborate.md
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="docs/赛道一_锁住你的头_组队提案书.md"
OUT="docs/赛道一_锁住你的头_组队提案书.pdf"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"

sed -e 's/\_/_/g' -e 's/\\+/+/g' "$SRC" > .pdfbuild/raw.md
pandoc .pdfbuild/raw.md -f markdown+pipe_tables -t html5 -s \
  -H .pdfbuild/style.html -o .pdfbuild/raw.html
python .pdfbuild/postfix.py
rm -f "$OUT"
"$CHROME" --headless=new --disable-gpu --no-sandbox --no-pdf-header-footer \
  --print-to-pdf="D:\Active-Desktop-Pet\docs\赛道一_锁住你的头_组队提案书.pdf" \
  "file:///D:/Active-Desktop-Pet/.pdfbuild/proposal.html" 2>&1 | grep -i written || true
ls -la "$OUT"
