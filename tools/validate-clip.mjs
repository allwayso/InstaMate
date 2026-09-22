#!/usr/bin/env node
// clip v1 校验器 —— 把 docs/Collaborate.md §九.2 的规则可执行化。
//
// 用法:
//   node tools/validate-clip.mjs web/public/clips/wave.json
//   node tools/validate-clip.mjs web/public/clips/wave.json --json
//   node tools/validate-clip.mjs web/public/clips/wave.json --target assets/vrm/companion.manifest.json
//   node tools/validate-clip.mjs --fixtures tests/fixtures
//
// 退出码: 0 = 通过 / 1 = 存在 ERROR / 2 = 文件不可解析
//
// 骨骼表来源: web/lib/human-bones-vrm1.json —— 与 web/lib/contracts.ts 同一份，禁止复制第二份。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 与 web/lib/contracts.ts 的 CLIP_V1 / RIG_PROFILE 保持同步（改一处必须改两处，故把数值写在常量里集中管理） */
const SPEC = {
  schemaVersion: 1,
  rigProfile: 'vrm-normalized-v1',
  space: 'normalized-local',
  rotationMode: 'absolute',
  quaternionOrder: 'xyzw',
  rootMotion: 'locked',
  durationTolerance: 1e-6,
  quaternionNormTolerance: 1e-3,
  /** v1 禁止出现的顶层字段（根位移 / 骨骼缩放 / 表情轨道 / 弹簧骨轨道） */
  forbiddenKeys: [
    'translations',
    'positions',
    'rootTranslation',
    'scales',
    'expressions',
    'morphTargets',
    'blendShapes',
    'springBones',
    'springBoneTracks',
  ],
};

const BONES = new Set(JSON.parse(readFileSync(resolve(HERE, '../web/lib/human-bones-vrm1.json'), 'utf8')));

const LEVEL = { ERROR: 'ERROR', WARN: 'WARN' };

function validate(clip, opts = {}) {
  const { targetBones = null, file = '(inline)' } = opts;
  const issues = [];
  const add = (level, rule, msg, extra = {}) => issues.push({ level, rule, msg, ...extra });

  if (clip === null || typeof clip !== 'object' || Array.isArray(clip)) {
    add(LEVEL.ERROR, 'R0 根结构', '顶层必须是一个 JSON 对象');
    return { file, name: null, issues };
  }

  // ---- R1 schema 版本 ------------------------------------------------------
  if (clip.schemaVersion !== SPEC.schemaVersion) {
    add(LEVEL.ERROR, 'R1 schemaVersion', `必须是 ${SPEC.schemaVersion}，实际 ${JSON.stringify(clip.schemaVersion)}`);
  }

  // ---- R2 rigProfile ------------------------------------------------------
  if (clip.rigProfile !== SPEC.rigProfile) {
    add(LEVEL.ERROR, 'R2 rigProfile', `必须是 "${SPEC.rigProfile}"，实际 ${JSON.stringify(clip.rigProfile)}`);
  }

  // ---- 其它枚举字段 -------------------------------------------------------
  for (const [key, want] of [
    ['space', SPEC.space],
    ['rotationMode', SPEC.rotationMode],
    ['quaternionOrder', SPEC.quaternionOrder],
  ]) {
    if (clip[key] !== want) {
      add(LEVEL.ERROR, `R2 ${key}`, `必须是 "${want}"，实际 ${JSON.stringify(clip[key])}`);
    }
  }

  // ---- R3 fps / frameCount -----------------------------------------------
  const { fps, frameCount } = clip;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
    add(LEVEL.ERROR, 'R3 fps', `fps 必须 > 0 的有限数字，实际 ${JSON.stringify(fps)}`);
  }
  if (typeof frameCount !== 'number' || !Number.isInteger(frameCount) || frameCount < 2) {
    add(LEVEL.ERROR, 'R3 frameCount', `frameCount 必须是 >= 2 的整数，实际 ${JSON.stringify(frameCount)}`);
  }

  // ---- R4 时长 -----------------------------------------------------------
  if (Number.isFinite(fps) && fps > 0 && Number.isInteger(frameCount) && frameCount >= 2) {
    const expect = (frameCount - 1) / fps;
    if (typeof clip.duration !== 'number' || !Number.isFinite(clip.duration)) {
      add(LEVEL.ERROR, 'R4 duration', `duration 必须是有限数字，实际 ${JSON.stringify(clip.duration)}`);
    } else if (Math.abs(clip.duration - expect) > SPEC.durationTolerance) {
      add(
        LEVEL.ERROR,
        'R4 duration',
        `duration 必须等于 (frameCount-1)/fps = ${expect}（容差 ${SPEC.durationTolerance}），实际 ${clip.duration}，差 ${Math.abs(clip.duration - expect)}`,
      );
    }
  }

  // ---- R12 v1 禁令（先查结构，能让后面的报告更干净） -----------------------
  if (clip.rootMotion !== SPEC.rootMotion) {
    add(LEVEL.ERROR, 'R12 rootMotion', `必须是 "${SPEC.rootMotion}"（v1 禁止根位移），实际 ${JSON.stringify(clip.rootMotion)}`);
  }
  for (const k of SPEC.forbiddenKeys) {
    if (k in clip) add(LEVEL.ERROR, 'R12 禁止字段', `v1 禁止出现顶层字段 "${k}"（根位移/缩放/表情/弹簧骨轨道）`);
  }
  const knownKeys = new Set([
    'schemaVersion', 'rigProfile', 'name', 'space', 'rotationMode', 'quaternionOrder',
    'fps', 'frameCount', 'duration', 'loop', 'rootMotion', 'mask', 'bones',
  ]);
  for (const k of Object.keys(clip)) {
    if (!knownKeys.has(k)) add(LEVEL.WARN, 'R12 未知字段', `顶层出现未定义字段 "${k}"，可能是拼写错误`);
  }

  // ---- bones / mask（R5 R6 R7 R8 R9 R10 R11） ----------------------------
  const bones = clip.bones;
  const tracks = [];
  if (bones === null || typeof bones !== 'object' || Array.isArray(bones)) {
    add(LEVEL.ERROR, 'R5 bones', 'bones 必须是对象 { 骨骼名: [四元数, ...] }');
    return { file, name: clip.name ?? null, issues };
  }
  const trackNames = Object.keys(bones);
  if (trackNames.length === 0) add(LEVEL.ERROR, 'R5 bones', 'bones 不能为空');

  for (const name of trackNames) {
    const track = bones[name];
    if (!Array.isArray(track)) {
      add(LEVEL.ERROR, 'R5 轨道类型', `"${name}" 的轨道必须是数组`);
      continue;
    }
    if (!BONES.has(name)) {
      add(LEVEL.ERROR, 'R9 骨骼名', `"${name}" 不在 VRM 1.0 人形骨骼表中`);
    }
    if (targetBones && !targetBones.has(name)) {
      add(LEVEL.ERROR, 'R9 目标缺失骨骼', `目标资产没有 "${name}"，不能驱动（拒绝该动作）`);
    }

    let needRenorm = false;
    let signFlips = 0;
    let maxNormErr = 0;

    for (let i = 0; i < track.length; i++) {
      const q = track[i];
      if (!Array.isArray(q) || q.length !== 4) {
        add(LEVEL.ERROR, 'R6 四元数结构', `"${name}" 第 ${i} 帧不是 4 元组：${JSON.stringify(q)}`);
        continue;
      }
      if (!q.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        add(LEVEL.ERROR, 'R6 非有限数字', `"${name}" 第 ${i} 帧含 NaN/Infinity/非数字：${JSON.stringify(q)}`);
        continue;
      }
      const norm = Math.hypot(q[0], q[1], q[2], q[3]);
      if (norm === 0) {
        add(LEVEL.ERROR, 'R7 零长度四元数', `"${name}" 第 ${i} 帧模长为 0，无法规范化`);
        continue;
      }
      const err = Math.abs(norm - 1);
      maxNormErr = Math.max(maxNormErr, err);
      if (err > SPEC.quaternionNormTolerance) {
        add(
          LEVEL.ERROR,
          'R7 非单位四元数',
          `"${name}" 第 ${i} 帧模长 ${norm}，偏差 ${err} 超过容差 ${SPEC.quaternionNormTolerance}`,
        );
      } else if (err > 0) {
        needRenorm = true;
      }
    }

    // ---- R5 轨道长度 ------------------------------------------------------
    if (Number.isInteger(frameCount) && track.length !== frameCount) {
      add(
        LEVEL.ERROR,
        'R5 轨道长度',
        `"${name}" 有 ${track.length} 帧，应为 frameCount = ${frameCount}`,
      );
    }

    // ---- R10 符号跳变 -----------------------------------------------------
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1];
      const b = track[i];
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) continue;
      const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
      if (dot < 0) signFlips++;
    }
    if (signFlips > 0) {
      add(
        LEVEL.WARN,
        'R10 符号跳变',
        `"${name}" 有 ${signFlips}/${Math.max(0, track.length - 1)} 处相邻帧点积 < 0，采样时需翻转符号走最短路径 slerp`,
      );
    }

    // ---- R11 循环接缝 -----------------------------------------------------
    if (clip.loop === true && track.length >= 2) {
      const first = track[0];
      const last = track[track.length - 1];
      if (Array.isArray(first) && Array.isArray(last) && first.length === 4 && last.length === 4) {
        const seam = 1 - Math.abs(first[0] * last[0] + first[1] * last[1] + first[2] * last[2] + first[3] * last[3]);
        if (seam > 1e-3) {
          add(LEVEL.WARN, 'R11 循环接缝', `"${name}" 首尾姿态不完全一致（夹角量度 ${seam.toFixed(6)}），循环时会跳变`);
        }
      }
    }

    tracks.push({ name, frames: track.length, needRenorm, signFlips, maxNormErr });
  }

  // ---- R8 mask 与轨道集合一致 --------------------------------------------
  if (!Array.isArray(clip.mask)) {
    add(LEVEL.ERROR, 'R8 mask', 'mask 必须是字符串数组');
  } else {
    const maskSet = new Set(clip.mask);
    const trackSet = new Set(trackNames);
    const onlyInMask = [...maskSet].filter((m) => !trackSet.has(m));
    const onlyInTracks = [...trackSet].filter((t) => !maskSet.has(t));
    if (onlyInMask.length || onlyInTracks.length) {
      add(
        LEVEL.ERROR,
        'R8 mask 不一致',
        `mask 与轨道名集合必须一致。仅出现在 mask：${onlyInMask.join(', ') || '无'}；仅出现在轨道：${onlyInTracks.join(', ') || '无'}`,
      );
    }
    const dup = clip.mask.length !== maskSet.size;
    if (dup) add(LEVEL.WARN, 'R8 mask 重复项', 'mask 里有重复的骨骼名');
  }

  // ---- 信息性提示 --------------------------------------------------------
  if (Number.isInteger(frameCount) && frameCount >= 2 && Number.isFinite(fps) && fps > 0) {
    const lastFrameTime = (frameCount - 1) / fps;
    if (clip.length !== undefined) void clip.length;
    if (trackNames.length > 0) {
      const withNeedRenorm = tracks.filter((t) => t.needRenorm);
      if (withNeedRenorm.length > 0) {
        add(
          LEVEL.WARN,
          'R7 需再规范化',
          `${withNeedRenorm.length} 条轨道存在模长偏差 > 0 但 <= ${SPEC.quaternionNormTolerance} 的帧，加载时可再规范化：${withNeedRenorm.map((t) => t.name).join(', ')}`,
        );
      }
    }
    if (clip.loop === true && clip.duration !== undefined) {
      void lastFrameTime;
    }
  }

  return { file, name: clip.name ?? null, issues, tracks };
}

function report(result) {
  const errors = result.issues.filter((i) => i.level === LEVEL.ERROR);
  const warns = result.issues.filter((i) => i.level === LEVEL.WARN);
  const tag = errors.length ? 'FAIL' : 'PASS';
  console.log(`${tag}  ${result.file}${result.name ? `  (${result.name})` : ''}`);
  for (const i of result.issues) {
    console.log(`      [${i.level}] ${i.rule}: ${i.msg}`);
  }
  if (!result.issues.length) console.log('      ✓ §九.2 十二条规则全部通过');
  else console.log(`      ${errors.length} 个 ERROR / ${warns.length} 个 WARN`);
  return errors.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const fixturesIdx = argv.indexOf('--fixtures');
const targetIdx = argv.indexOf('--target');
const targetPath = targetIdx >= 0 ? argv[targetIdx + 1] : null;
/** 位置参数 = 既不是选项本身、也不是选项的值 */
const optionValueIdx = new Set(
  [fixturesIdx, targetIdx].filter((i) => i >= 0).map((i) => i + 1),
);
const positional = argv.filter(
  (a, i) => !a.startsWith('--') && !optionValueIdx.has(i),
);

/** 从 manifest 推出目标资产实际拥有的骨骼集合 */
function loadTargetBones(manifestPath) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const missing = new Set(m?.rig?.missingBones ?? []);
  const present = new Set([...BONES].filter((b) => !missing.has(b)));
  return present;
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
  let failed = 0;
  let unexpected = 0;
  for (const f of entries) {
    const full = join(abs, f);
    const wantFail = basename(f).startsWith('bad-');
    let result;
    try {
      result = validate(JSON.parse(readFileSync(full, 'utf8')), { file: f, targetBones });
    } catch (e) {
      result = { file: f, name: null, issues: [{ level: LEVEL.ERROR, rule: 'R0 解析', msg: e.message }] };
    }
    const errors = result.issues.filter((i) => i.level === LEVEL.ERROR).length;
    const gotFail = errors > 0;
    const ok = gotFail === wantFail;
    if (!ok) unexpected++;
    if (gotFail) failed++;
    rows.push({ file: f, expect: wantFail ? '拒绝' : '通过', got: gotFail ? '拒绝' : '通过', errors, ok, issues: result.issues });
  }

  if (asJson) {
    console.log(JSON.stringify({ rows, unexpected }, null, 2));
  } else {
    console.log(`${'fixture'.padEnd(34)}${'期望'.padEnd(8)}${'实际'.padEnd(8)}ERROR  结果`);
    console.log('-'.repeat(76));
    for (const r of rows) {
      console.log(
        `${r.file.padEnd(34)}${r.expect.padEnd(8)}${r.got.padEnd(8)}${String(r.errors).padEnd(8)}${r.ok ? '✓' : '✗ 不符合预期'}`,
      );
    }
    console.log('-'.repeat(76));
    console.log(`共 ${rows.length} 个 fixture：${rows.filter((r) => r.ok).length} 个符合预期，${unexpected} 个不符合预期`);
    for (const r of rows.filter((r) => !r.ok)) {
      console.log(`\n—— ${r.file} 详情 ——`);
      report(r);
    }
    if (unexpected === 0) {
      console.log('\n✓ 6 个坏 fixture 全部被拒、合法 fixture 通过');
    }
  }
  process.exit(unexpected === 0 ? 0 : 1);
}

const file = positional[0];
if (!file) {
  console.error('用法: node tools/validate-clip.mjs <clip.json> [--json] [--target <manifest.json>]');
  console.error('      node tools/validate-clip.mjs --fixtures <dir>');
  process.exit(2);
}

let clip;
try {
  clip = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`${file}: 不是合法 JSON —— ${e.message}`);
  process.exit(2);
}

const result = validate(clip, { file, targetBones });
if (asJson) console.log(JSON.stringify(result, null, 2));
else report(result);
process.exit(result.issues.some((i) => i.level === LEVEL.ERROR) ? 1 : 0);
