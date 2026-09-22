#!/usr/bin/env node
// 拉取工程用 VRM 资产。
//
// 为什么用 Node 而不是 shell：Node 是这个项目本来就有的硬前置，bash/curl 不是
// （Windows 上没装 Git Bash 就跑不了 shell 版）。且 Node 自带跨平台 sha256 与 fetch。
//
// 为什么带镜像：官方样例在 raw.githubusercontent.com，国内网络经常连不上（ETIMEDOUT）。
// 镜像必须与官方**字节完全一致**才被接受——sha256 校验不过就继续试下一个，绝不静默降级。
//
// 用法:
//   node tools/fetch-assets.mjs            # 只拉缺失或哈希不符的
//   node tools/fetch-assets.mjs --force    # 强制重下
//   node tools/fetch-assets.mjs --json     # 机器可读结果
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_SAN_SHA = '624d0d554bc205bbdc33e22a68a2c3c20edebb3e573011ead8878a65e5329b23';

/**
 * 资产表。每个资产可配多个 URL，按顺序尝试，第一个 sha256 校验通过的即采用。
 * 新增镜像时务必先手工确认其内容与官方**字节一致**，否则会把损坏资产引进仓库。
 */
const ASSETS = [
  {
    name: 'sample.vrm',
    dest: 'web/public/avatars/sample.vrm',
    sha256: SEED_SAN_SHA,
    // Seed-san（VRM 1.0 官方样例，VirtualCast, Inc. / VRM Public License 1.0，creditNotation: required）
    urls: [
      'https://raw.githubusercontent.com/vrm-c/vrm-specification/master/samples/Seed-san/vrm/Seed-san.vrm',
      'https://cdn.jsdelivr.net/gh/vrm-c/vrm-specification@master/samples/Seed-san/vrm/Seed-san.vrm',
    ],
  },
];

const args = process.argv.slice(2);
const force = args.includes('--force');
const asJson = args.includes('--json');
const log = asJson ? () => {} : (...a) => console.log(...a);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const hashOfFile = (p) => sha256(readFileSync(p));

async function downloadOne(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 先写临时文件再原子替换，避免中断留下半个文件被当成"已就位"
  const tmp = `${dest}.part`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
  return sha256(buf);
}

async function ensureAsset(asset) {
  const dest = resolve(ROOT, asset.dest);
  mkdirSync(dirname(dest), { recursive: true });

  if (!force && existsSync(dest)) {
    const got = hashOfFile(dest);
    if (got === asset.sha256) {
      log(`SKIP  ${asset.dest}  (哈希已一致)`);
      return { name: asset.name, status: 'skipped', sha256: got };
    }
    log(`STALE ${asset.dest}  (哈希不符，重下)`);
  }

  const failures = [];
  for (const url of asset.urls) {
    const host = new URL(url).host;
    log(`GET   ${asset.dest}  ← ${host}`);
    try {
      const got = await downloadOne(url, dest);
      if (got !== asset.sha256) {
        failures.push(`${host}: 内容校验失败（期望 ${asset.sha256.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`);
        log(`      ✗ ${host} 内容校验失败，试下一个镜像`);
        rmSync(dest, { force: true });
        continue;
      }
      log(`      ✓ ${host}  sha256=${got}`);
      return { name: asset.name, status: 'downloaded', via: host, sha256: got };
    } catch (e) {
      const msg = e?.cause?.code ? `${e.cause.code}` : (e?.message ?? String(e));
      failures.push(`${host}: ${msg}`);
      log(`      ✗ ${host} 失败：${msg}`);
    }
  }

  const err = new Error(
    `资产 ${asset.name} 的所有镜像都失败了：\n  ` +
      failures.join('\n  ') +
      '\n\n排查建议：\n' +
      '  1) 若报 ETIMEDOUT 且目标是 198.18.x.x 之类地址，多半是代理/VPN 的 TUN 模式劫持了 DNS\n' +
      '     → 关掉代理，或把 raw.githubusercontent.com / cdn.jsdelivr.net 加进直连规则\n' +
      '  2) 也可能是公司网络限制；可挂代理后重试：https_proxy=http://127.0.0.1:7890 node tools/fetch-assets.mjs',
  );
  err.name = 'AssetFetchError';
  throw err;
}

const results = [];
let failed = false;
for (const asset of ASSETS) {
  try {
    results.push(await ensureAsset(asset));
  } catch (e) {
    failed = true;
    if (!asJson) console.error(`\n${e.message}`);
    results.push({ name: asset.name, status: 'failed', error: e.message });
  }
}

if (asJson) console.log(JSON.stringify({ results, ok: !failed }, null, 2));
else if (!failed) console.log('\n全部资产就位。');

process.exit(failed ? 1 : 0);
