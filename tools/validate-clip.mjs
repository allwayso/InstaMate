#!/usr/bin/env node
// clip v1 校验器 CLI —— 规则实现在 web/lib/clip-spec.ts，与浏览器共用同一份。
//
// Node 24 支持直接 import .ts（类型擦除），所以这里不需要构建步骤。
// 骨骼表来自 web/lib/human-bones-vrm1.json（与 contracts.ts 同一份，禁止复制第二份）。
//
// 用法:
//   node tools/validate-clip.mjs web/public/clips/wave.json
//   node tools/validate-clip.mjs web/public/clips/wave.json --json
//   node tools/validate-clip.mjs web/public/clips/wave.json --target assets/vrm/companion.manifest.json
//   node tools/validate-clip.mjs --fixtures tests/fixtures
//   node tools/validate-clip.mjs --all web/public/clips
//
// 退出码: 0 = 通过 / 1 = 存在 ERROR / 2 = 文件不可解析
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIP_SPEC, normalizeClipQuaternions, validateClip } from '../web/lib/clip-spec.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BONES = JSON.parse(readFileSync(resolve(HERE, '../web/lib/human-bones-vrm1.json'), 'utf8'));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const fixturesIdx = argv.indexOf('--fixtures');
const allIdx = argv.indexOf('--all');
const targetIdx = argv.indexOf('--target');
const targetPath = targetIdx >= 0 ? argv[targetIdx + 1] : null;

const optionValueIdx = new Set(
  [fixturesIdx, allIdx, targetIdx].filter((i) => i >= 0).map((i) => i + 1),
);
const positional = argv.filter((a, i) => !a.startsWith('--') && !optionValueIdx.has(i));

/** 从 manifest 推出目标资产实际拥有的骨骼集合 */
function loadTargetBones(manifestPath) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const missing = new Set(m?.rig?.missingBones ?? []);
  return BONES.filter((b) => !missing.has(b));
}

let targetBones = null;
if (targetPath) {
  try {
    targetBones = loadTargetBones(targetPath);
  } catch (e) {
    console.error(`无法读取 --target ${targetPath}: ${e.message}`);
    process.exit(2);
  }
}

const runOne = (clip, file) => validateClip(clip, { boneList: BONES, targetBones });

function report(result, file, { quiet = false } = {}) {
  const tag = result.errors ? 'FAIL' : 'PASS';
  if (!quiet || result.errors) {
    console.log(`${tag}  ${file}${result.name ? `  (${result.name})` : ''}`);
    for (const i of result.issues) console.log(`      [${i.level}] ${i.rule}: ${i.msg}`);
    if (!result.issues.length) console.log('      ✓ §九.2 十二条规则全部通过');
    else console.log(`      ${result.errors} 个 ERROR / ${result.warnings} 个 WARN`);
  }
  return result.errors ? 1 : 0;
}

// ---- --fixtures -----------------------------------------------------------
if (fixturesIdx >= 0) {
  const dir = argv[fixturesIdx + 1];
  if (!dir) {
    console.error('用法: node tools/validate-clip.mjs --fixtures <dir>');
    process.exit(2);
  }
  const abs = resolve(dir);
  let entries;
  try {
    entries = readdirSync(abs).filter((f) => f.endsWith('.json') && statSync(join(abs, f)).isFile());
  } catch (e) {
    console.error(`无法读取目录 ${dir}: ${e.message}`);
    process.exit(2);
  }
  entries.sort();

  const rows = [];
  let unexpected = 0;
  for (const f of entries) {
    const full = join(abs, f);
    const wantFail = basename(f).startsWith('bad-');
    let result;
    try {
      result = runOne(JSON.parse(readFileSync(full, 'utf8')), f);
    } catch (e) {
      result = { name: null, issues: [{ level: 'ERROR', rule: 'R0 解析', msg: e.message }], errors: 1, warnings: 0, tracks: [] };
    }
    const gotFail = result.errors > 0;
    const ok = gotFail === wantFail;
    if (!ok) unexpected++;
    rows.push({ file: f, expect: wantFail ? '拒绝' : '通过', got: gotFail ? '拒绝' : '通过', errors: result.errors, ok, result });
  }

  if (asJson) {
    console.log(JSON.stringify({ rows: rows.map(({ result, ...r }) => r), unexpected }, null, 2));
  } else {
    console.log(`${'fixture'.padEnd(34)}${'期望'.padEnd(8)}${'实际'.padEnd(8)}ERROR  结果`);
    console.log('-'.repeat(76));
    for (const r of rows) {
      console.log(`${r.file.padEnd(34)}${r.expect.padEnd(8)}${r.got.padEnd(8)}${String(r.errors).padEnd(8)}${r.ok ? '✓' : '✗ 不符合预期'}`);
    }
    console.log('-'.repeat(76));
    console.log(`共 ${rows.length} 个 fixture：${rows.filter((r) => r.ok).length} 个符合预期，${unexpected} 个不符合预期`);
    for (const r of rows.filter((r) => !r.ok)) {
      console.log(`\n—— ${r.file} 详情 ——`);
      report(r.result, r.file);
    }
    if (unexpected === 0) console.log('\n✓ 坏 fixture 全部被拒、合法 fixture 通过');
  }
  process.exit(unexpected === 0 ? 0 : 1);
}

// ---- --all <dir> ----------------------------------------------------------
if (allIdx >= 0) {
  const dir = argv[allIdx + 1];
  if (!dir) {
    console.error('用法: node tools/validate-clip.mjs --all <dir>');
    process.exit(2);
  }
  const abs = resolve(dir);
  // 动作目录自身（index.json）不是 clip，按约定文件名跳过
  const NOT_A_CLIP = new Set(['index.json']);
  let entries;
  try {
    entries = readdirSync(abs)
      .filter((f) => f.endsWith('.json') && !NOT_A_CLIP.has(f) && statSync(join(abs, f)).isFile())
      .sort();
  } catch (e) {
    console.error(`无法读取目录 ${dir}: ${e.message}`);
    process.exit(2);
  }
  let bad = 0;
  for (const f of entries) {
    let result;
    try {
      const raw = JSON.parse(readFileSync(join(abs, f), 'utf8'));
      const { clip } = normalizeClipQuaternions(raw);
      result = runOne(clip, f);
    } catch (e) {
      result = { name: null, issues: [{ level: 'ERROR', rule: 'R0 解析', msg: e.message }], errors: 1, warnings: 0, tracks: [] };
    }
    bad += report(result, f, { quiet: true });
  }
  console.log(`\n共 ${entries.length} 个文件，${entries.length - bad} 通过 / ${bad} 失败`);
  process.exit(bad === 0 ? 0 : 2);
}

// ---- 单文件 ----------------------------------------------------------------
const file = positional[0];
if (!file) {
  console.error('用法: node tools/validate-clip.mjs <clip.json> [--json] [--target <manifest.json>]');
  console.error('      node tools/validate-clip.mjs --fixtures <dir>');
  console.error('      node tools/validate-clip.mjs --all <dir>');
  process.exit(2);
}

let clip;
try {
  clip = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`${file}: 不是合法 JSON —— ${e.message}`);
  process.exit(2);
}

const normalized = normalizeClipQuaternions(clip);
const result = runOne(normalized.clip, file);
if (asJson) {
  console.log(JSON.stringify({ ...result, normalizedOnLoad: normalized.changed }, null, 2));
} else {
  report(result, file);
  if (normalized.changed) console.log('      （加载时对允许范围内的模长误差做了规范化，原文件未改动）');
}
process.exit(result.errors ? 1 : 0);
