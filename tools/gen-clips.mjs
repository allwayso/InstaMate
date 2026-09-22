#!/usr/bin/env node
// 程序化动作生成器 —— 产出符合 clip v1 契约的 JSON 文件。
//
// 设计约束（docs/Collaborate.md 与 G1 计划）：
// - 不接收 VRM 实例；不依赖任何具体资产的节点名、骨长或网格。
//   只用 VRM 1.0 的**标准人形骨骼名**与实测轴向约定（web/lib/pose.ts）。
// - 以「关键姿态 + 时间点」描述动作，缓动 + 最短路径 slerp 烘焙为固定帧率文件。
// - 产出后**立即用同一个校验器自检**，不合格就不写盘 —— 避免脏动作进动作库。
// - 首尾均回到基础站姿，峰值留短暂停顿便于人工检查。
//
// 用法:
//   node tools/gen-clips.mjs            # 生成到 web/public/clips/，并刷新 index.json
//   node tools/gen-clips.mjs --check    # 只校验已存在的文件，不重写（CI 用）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mergeCatalog, preserveNonGenerated } from '../web/lib/clip-catalog-merge.ts';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIP_SPEC, validateClip } from '../web/lib/clip-spec.ts';
import {
  BASE_STANDING_POSE,
  keyframeBones,
  rotQ,
  sampleKeyframes,
} from '../web/lib/pose.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'web/public/clips');
const BONES = JSON.parse(readFileSync(join(ROOT, 'web/lib/human-bones-vrm1.json'), 'utf8'));
const FPS = CLIP_SPEC.defaultFps;

// ---------------------------------------------------------------------------
// 动作定义
// ---------------------------------------------------------------------------
// 每个关键帧的 pose 只写「与基础站姿不同」的骨骼；其余骨骼自动回落基础站姿。
// `{}` = 完全的基础站姿（用于首尾与停顿）。

/** 抬臂到约肩高：右侧绕 Z 负向（实测方向），左侧镜像 */
const raisedArm = (side) => ({
  [`${side}UpperArm`]: rotQ('Z', side === 'right' ? 5 : -5),
});
/**
 * 肘部弯曲：绕 Z（参考姿态下的肘屈曲轴），右侧为负、左侧为正。
 * 曾在 Y 轴上做过一版 —— 手会朝相机方向压过去，正面透视缩短几乎看不见，
 * 是看渲染截图才发现的问题。Z 轴在额状面内抬起前臂，正面清晰。
 */
const bentElbow = (side, deg = 90) => ({
  [`${side}LowerArm`]: rotQ('Z', side === 'right' ? -deg : deg),
});

const CLIPS = [
  {
    id: 'raise-right-arm',
    displayName: '右抬手',
    note: '基础站姿 → 右上臂抬至约肩高 → 回位',
    durationSec: 3,
    keys: [
      { t: 0.0, pose: {} },
      { t: 0.3, pose: {} },
      { t: 1.1, pose: raisedArm('right') },
      { t: 1.6, pose: raisedArm('right') }, // 峰值停顿
      { t: 2.6, pose: {} },
      { t: 3.0, pose: {} },
    ],
  },
  {
    id: 'raise-left-arm',
    displayName: '左抬手',
    note: '基础站姿 → 左上臂抬至约肩高 → 回位',
    durationSec: 3,
    keys: [
      { t: 0.0, pose: {} },
      { t: 0.3, pose: {} },
      { t: 1.1, pose: raisedArm('left') },
      { t: 1.6, pose: raisedArm('left') },
      { t: 2.6, pose: {} },
      { t: 3.0, pose: {} },
    ],
  },
  {
    id: 'bend-right-elbow',
    displayName: '右屈肘',
    note: '基础站姿 → 右肘弯曲约 90° → 回位',
    durationSec: 3,
    keys: [
      { t: 0.0, pose: {} },
      { t: 0.3, pose: {} },
      { t: 1.1, pose: bentElbow('right') },
      { t: 1.6, pose: bentElbow('right') },
      { t: 2.6, pose: {} },
      { t: 3.0, pose: {} },
    ],
  },
  {
    id: 'bend-left-elbow',
    displayName: '左屈肘',
    note: '基础站姿 → 左肘弯曲约 90° → 回位',
    durationSec: 3,
    keys: [
      { t: 0.0, pose: {} },
      { t: 0.3, pose: {} },
      { t: 1.1, pose: bentElbow('left') },
      { t: 1.6, pose: bentElbow('left') },
      { t: 2.6, pose: {} },
      { t: 3.0, pose: {} },
    ],
  },
  {
    id: 'turn-head',
    displayName: '转头',
    note: '向角色自身左转约 25° → 回正 → 向自身右转约 25° → 回正',
    durationSec: 4,
    keys: [
      { t: 0.0, pose: {} },
      { t: 0.3, pose: {} },
      { t: 0.9, pose: { head: rotQ('Y', 25) } }, // 自身左
      { t: 1.4, pose: { head: rotQ('Y', 25) } },
      { t: 2.0, pose: {} },
      { t: 2.6, pose: {} },
      { t: 3.2, pose: { head: rotQ('Y', -25) } }, // 自身右
      { t: 3.6, pose: { head: rotQ('Y', -25) } },
      { t: 4.0, pose: {} },
    ],
  },
  {
    id: 'wave-right-hand',
    displayName: '右手挥手',
    note: '抬臂 → 屈肘 → 小幅往复挥动 → 放下',
    durationSec: 4,
    keys: [
      { t: 0.0, pose: {} },
      { t: 0.3, pose: {} },
      { t: 0.9, pose: { ...raisedArm('right'), ...bentElbow('right', 95) } },
      { t: 1.4, pose: { ...raisedArm('right'), ...bentElbow('right', 95) } },
      // 三次小幅往复：绕 Z 在额状面内摆动，正面清晰可见
      { t: 1.7, pose: { ...raisedArm('right'), ...bentElbow('right', 65) } },
      { t: 2.0, pose: { ...raisedArm('right'), ...bentElbow('right', 95) } },
      { t: 2.3, pose: { ...raisedArm('right'), ...bentElbow('right', 65) } },
      { t: 2.6, pose: { ...raisedArm('right'), ...bentElbow('right', 95) } },
      { t: 2.9, pose: { ...raisedArm('right'), ...bentElbow('right', 65) } },
      { t: 3.2, pose: { ...raisedArm('right'), ...bentElbow('right', 95) } },
      { t: 3.6, pose: {} },
      { t: 4.0, pose: {} },
    ],
  },
];

// ---------------------------------------------------------------------------
// 烘焙
// ---------------------------------------------------------------------------

function bakeClip(def) {
  const frameCount = Math.round(def.durationSec * FPS) + 1;
  const mask = keyframeBones(def.keys);
  const bones = {};
  for (const bone of mask) {
    const track = [];
    for (let f = 0; f < frameCount; f++) {
      const q = sampleKeyframes(def.keys, bone, f / FPS);
      // 写盘前规范化到双精度下的单位长度，避免累计误差触发校验器的 1e-3 容差
      const n = Math.hypot(q[0], q[1], q[2], q[3]);
      track.push([q[0] / n, q[1] / n, q[2] / n, q[3] / n]);
    }
    // 消除相邻帧符号跳变，让采样端无需再判断（仍保留最短路径 slerp 作为兜底）
    for (let f = 1; f < track.length; f++) {
      const a = track[f - 1];
      const b = track[f];
      if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0) {
        track[f] = [-b[0], -b[1], -b[2], -b[3]];
      }
    }
    bones[bone] = track;
  }

  return {
    schemaVersion: CLIP_SPEC.schemaVersion,
    rigProfile: CLIP_SPEC.rigProfile,
    name: def.id,
    space: CLIP_SPEC.space,
    rotationMode: CLIP_SPEC.rotationMode,
    quaternionOrder: CLIP_SPEC.quaternionOrder,
    fps: FPS,
    frameCount,
    duration: (frameCount - 1) / FPS,
    loop: false,
    rootMotion: CLIP_SPEC.rootMotion,
    mask,
    bones,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const checkOnly = process.argv.includes('--check');
const catalog = [];
let failed = 0;

for (const def of CLIPS) {
  const clip = bakeClip(def);
  const result = validateClip(clip, { boneList: BONES, targetBones: null });
  const rel = `web/public/clips/${def.id}.json`;

  if (!result.ok) {
    failed++;
    console.error(`✗ ${def.id} 生成结果未通过校验，**不写盘**：`);
    for (const i of result.issues) console.error(`    [${i.level}] ${i.rule}: ${i.msg}`);
    continue;
  }

  if (!checkOnly) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${def.id}.json`), JSON.stringify(clip, null, 2) + '\n');
  } else if (!existsSync(join(OUT_DIR, `${def.id}.json`))) {
    failed++;
    console.error(`✗ ${rel} 不存在（--check 模式不会生成）`);
    continue;
  }

  const warns = result.warnings;
  console.log(
    `✓ ${def.id.padEnd(18)} ${String(clip.frameCount).padStart(4)} 帧 ${clip.duration.toFixed(3)}s  ` +
      `mask=[${clip.mask.join(', ')}]${warns ? `  (${warns} WARN)` : ''}`,
  );
  for (const i of result.issues) console.log(`    [${i.level}] ${i.rule}: ${i.msg}`);

  catalog.push({
    id: def.id,
    name: def.displayName,
    url: `/clips/${def.id}.json`,
    source: 'generated',
    note: def.note,
    fps: clip.fps,
    duration: clip.duration,
    frameCount: clip.frameCount,
    mask: clip.mask,
  });
}

if (!checkOnly && failed === 0) {
  // ── 目录是**读-改-写**，不是整体重写 ──────────────────────────────────
  //
  // 这个文件同时被两方写：本生成器，以及 G2 的保存 API（录入真人动作时）。
  // 早期实现是整体重写，于是"录完动作再跑一次 gen:clips"会把录的动作从目录里抹掉 ——
  // 文件还在磁盘上，但从目录里消失了，看起来像"动作丢了"。
  // （实测复现过：塞一条 source:mocap 的条目，跑一次本脚本就没了。）
  //
  // 所以：只替换 source === "generated" 的条目，其它来源原样保留，
  // 目录里与本生成器无关的字段也一律不动。
  //
  // 合并规则本身在 web/lib/clip-catalog-merge.ts（纯函数，有单测）。
  const NL = String.fromCharCode(10);
  const indexPath = join(OUT_DIR, "index.json");
  let existing = null;
  let preservedCount = 0;
  if (existsSync(indexPath)) {
    try {
      existing = JSON.parse(readFileSync(indexPath, "utf8"));
    } catch {
      console.error(NL + "✗ 现有 index.json 不是合法 JSON，已中止以免覆盖整个动作库");
      process.exit(1);
    }
    preservedCount = preserveNonGenerated(existing).length;
  }
  const nextIndex = mergeCatalog(existing, catalog);
  writeFileSync(indexPath, JSON.stringify(nextIndex, null, 2) + NL);
  console.log(
    NL +
      "动作目录已写入 web/public/clips/index.json（程序化 " +
      catalog.length +
      " 条" +
      (preservedCount ? "，保留其它来源 " + preservedCount + " 条" : "") +
      "）",
  );
}

// 自检：基础站姿本身不能是参考姿态（normalized identity）
const baseBones = Object.keys(BASE_STANDING_POSE);
if (baseBones.length === 0) {
  console.error('\n✗ 基础站姿为空 —— 参考姿态（identity）等于 T-pose，不能当待机姿态');
  failed++;
}

process.exit(failed === 0 ? 0 : 1);
