#!/usr/bin/env bash
# 拉取工程用 VRM 资产（不进 git：体积 + 许可）
#
# 用法:
#   bash tools/fetch-assets.sh          # 只拉缺失或哈希不符的
#   bash tools/fetch-assets.sh --force  # 强制重下
set -euo pipefail
cd "$(dirname "$0")/.."

FORCE="${1:-}"

# 资产表：目标路径|URL|sha256
# sample.vrm = VRM 1.0 官方样例 Seed-san（VirtualCast, Inc. / VRM Public License 1.0，creditNotation: required）
ASSETS=(
  "web/public/avatars/sample.vrm|https://raw.githubusercontent.com/vrm-c/vrm-specification/master/samples/Seed-san/vrm/Seed-san.vrm|624d0d554bc205bbdc33e22a68a2c3c20edebb3e573011ead8878a65e5329b23"
)

fail=0
for row in "${ASSETS[@]}"; do
  IFS='|' read -r dest url want <<<"$row"
  mkdir -p "$(dirname "$dest")"

  if [ "$FORCE" != "--force" ] && [ -f "$dest" ]; then
    got="$(sha256sum "$dest" | cut -d' ' -f1)"
    if [ "$got" = "$want" ]; then
      echo "SKIP  $dest (哈希已一致)"
      continue
    fi
    echo "STALE $dest (哈希不符，重下)"
  fi

  echo "GET   $dest"
  curl -fL --retry 3 --retry-delay 2 -o "$dest" "$url"

  got="$(sha256sum "$dest" | cut -d' ' -f1)"
  if [ "$got" = "$want" ]; then
    echo "OK    $dest  sha256=$got"
  else
    echo "FAIL  $dest  期望 $want" >&2
    echo "              实际 $got" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "有资产哈希不匹配。若上游样例已更新，需同步更新本脚本与 assets/vrm/*.manifest.json。" >&2
  exit 1
fi

echo ""
echo "全部资产就位。"
