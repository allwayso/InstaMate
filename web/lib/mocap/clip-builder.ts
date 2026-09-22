/**
 * 把「已处理的姿态帧序列」烘焙成 ClipFile v1。
 *
 * 处理链条上的位置：
 *
 *   录制缓冲（RecordedFrame[]，时间戳 + 已校准/已回退的姿态）
 *     → 【本文件】裁剪 → 重采样到固定 30fps → 符号连续化 → ClipFile v1
 *     → validateClip（同一个校验器，浏览器与 CLI 共用）
 *     → ClipPlayer 回放
 *
 * 关键决定：
 *   · **不新增格式**。产出就是 G1 冻结的 ClipFile v1，所以 G2 录的动作与程序化动作
 *     走同一个播放器、同一套校验规则。
 *   · **按秒重采样**，不按帧。源帧率会抖（推理速度受机器影响），
 *     重采样到固定 30fps 后动作速度才与机器无关。
 *   · 采样点落在**严格的 1/fps 网格**上（从 inMs 起算），
 *     所以 duration = (frameCount-1)/fps 与采样完全自洽，不是"近似 30fps"。
 *
 * 录制来源与质量不写进 clip —— 那些进 MocapCaptureV1，避免污染冻结格式。
 */
import {
  CLIP_SPEC,
  normalizeClipQuaternions,
  slerpQuat,
  validateClip,
} from '../clip-spec.ts';
import type { ClipFile, QuaternionTuple, ValidationIssue } from '../clip-spec.ts';
import type { Pose, Quat } from '../pose.ts';
import { MOCAP_LIMITS } from './mocap-types.ts';

/** 录制缓冲里的一帧：时间戳 + 该帧最终要写进骨骼的姿态 */
export interface RecordedFrame {
  timestampMs: number;
  pose: Pose;
}

export interface BuildClipOptions {
  /** 动作标识；非空字符串，需符合 clip v1 对 name 的要求 */
  name: string;
  /** 已处理（校准 + 平滑 + 回退）的姿态帧，按时间升序 */
  frames: readonly RecordedFrame[];
  /** 裁剪入点（毫秒，相对录制起点） */
  inMs: number;
  /** 裁剪出点（毫秒，相对录制起点） */
  outMs: number;
  fps?: number;
  loop?: boolean;
  /** 校验用：VRM 1.0 规范骨骼表 */
  boneList?: readonly string[];
  /** 校验用：目标资产实际拥有的骨骼 */
  targetBones?: readonly string[] | null;
}

export interface BuildClipStats {
  /** 输出帧数 */
  frameCount: number;
  fps: number;
  /** 输出时长（秒）= (frameCount-1)/fps */
  duration: number;
  /** 参与重采样的源帧数 */
  sourceFrameCount: number;
  /** 实际裁剪时长（毫秒） */
  trimmedMs: number;
  /** 输出时长与裁剪时长的差（毫秒），最多 0.5/fps */
  durationDriftMs: number;
  /** 被符号连续化改过的帧数 */
  signFlipsFixed: number;
  bones: string[];
}

export interface BuildClipResult {
  ok: boolean;
  clip: ClipFile | null;
  issues: ValidationIssue[];
  stats: BuildClipStats | null;
}

function dot(a: Quat | QuaternionTuple, b: Quat | QuaternionTuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/**
 * 在给定时刻采样姿态。
 *
 * 找夹住 t 的两帧按时间比例 slerp；t 在范围外则取端点（不外推 ——
 * 外推会在裁剪边界造出原视频里不存在的姿态）。
 * 逐骨骼独立采样：某根骨骼只在部分帧里出现过也能处理。
 */
export function samplePoseAt(frames: readonly RecordedFrame[], tMs: number, bones: readonly string[]): Pose {
  const n = frames.length;
  if (n === 0) return {};
  if (tMs <= frames[0].timestampMs) return pickBones(frames[0].pose, bones);
  if (tMs >= frames[n - 1].timestampMs) return pickBones(frames[n - 1].pose, bones);

  // 线性扫描足够：单段录制最多 10 秒、几百帧，且只在烘焙时跑一次
  let hi = 1;
  while (hi < n && frames[hi].timestampMs < tMs) hi++;
  const a = frames[hi - 1];
  const b = frames[hi];
  const span = b.timestampMs - a.timestampMs;
  const t = span <= 0 ? 0 : (tMs - a.timestampMs) / span;

  const out: Pose = {};
  for (const bone of bones) {
    const qa = a.pose[bone];
    const qb = b.pose[bone];
    if (qa && qb) out[bone] = slerpQuat(qa, qb, t) as Quat;
    else if (qa) out[bone] = [...qa] as Quat;
    else if (qb) out[bone] = [...qb] as Quat;
  }
  return out;
}

function pickBones(pose: Pose, bones: readonly string[]): Pose {
  const out: Pose = {};
  for (const b of bones) {
    const q = pose[b];
    if (q) out[b] = [...q] as Quat;
  }
  return out;
}

/** 所有帧里出现过的骨骼并集（保持稳定顺序：按首次出现） */
function unionBones(frames: readonly RecordedFrame[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of frames) {
    for (const b of Object.keys(f.pose)) {
      if (!seen.has(b)) {
        seen.add(b);
        out.push(b);
      }
    }
  }
  return out;
}

/**
 * 符号连续化：让相邻帧的四元数点积为正。
 *
 * 四元数是双覆盖的，q 与 −q 表示同一旋转。不处理的话，同一条轨道里可能突然出现
 * 一个"翻号"的帧，接收方若用线性插值就会穿过原点，表现为该骨骼瞬间抽搐。
 * 我们的采样端走最短路径 slerp 本来能容忍，但**文件本身保持干净**更好：
 * 别的工具（Blender 导入、人肉 diff）不一定这么宽容。
 */
function makeSignContinuous(track: QuaternionTuple[]): number {
  let fixed = 0;
  for (let i = 1; i < track.length; i++) {
    if (dot(track[i - 1], track[i]) < 0) {
      const q = track[i];
      track[i] = [-q[0], -q[1], -q[2], -q[3]];
      fixed++;
    }
  }
  return fixed;
}

/** 把帧里的四元数取到 6 位小数：既压缩体积，又避免浮点噪声让 diff 抖 */
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * 烘焙 clip。
 *
 * 失败时返回 `ok: false` 与具体 issues，**不返回半成品 clip** ——
 * 上层据此保留原状态，不做部分应用。
 */
export function buildClip(opts: BuildClipOptions): BuildClipResult {
  const fps = opts.fps ?? CLIP_SPEC.defaultFps;
  const { frames, inMs, outMs, name } = opts;

  const fail = (rule: string, msg: string): BuildClipResult => ({
    ok: false,
    clip: null,
    issues: [{ level: 'ERROR', rule, msg }],
    stats: null,
  });

  if (!name || typeof name !== 'string') return fail('BUILD_NAME', '动作名不能为空');
  if (frames.length === 0) return fail('BUILD_EMPTY', '没有可烘焙的帧');
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) {
    return fail('BUILD_RANGE', '裁剪区间必须是有限数值');
  }
  if (outMs <= inMs) return fail('BUILD_RANGE', `出点必须大于入点（${inMs} → ${outMs}）`);

  const trimmedMs = outMs - inMs;
  if (trimmedMs < MOCAP_LIMITS.minTrimMs) {
    return fail('BUILD_TOO_SHORT', `选区 ${Math.round(trimmedMs)}ms 短于最短 ${MOCAP_LIMITS.minTrimMs}ms`);
  }

  // 严格落在 1/fps 的网格上：第 i 帧在 inMs + i*1000/fps
  const stepMs = 1000 / fps;
  const frameCount = Math.max(2, Math.round(trimmedMs / stepMs) + 1);
  const duration = (frameCount - 1) / fps;

  const bones = unionBones(frames);
  if (bones.length === 0) return fail('BUILD_NO_BONES', '所有帧都没有骨骼轨道');

  // ── 重采样 ───────────────────────────────────────────────────────────
  const tracks: Record<string, QuaternionTuple[]> = {};
  for (const b of bones) tracks[b] = [];

  for (let i = 0; i < frameCount; i++) {
    const t = inMs + i * stepMs;
    const pose = samplePoseAt(frames, t, bones);
    for (const b of bones) {
      const q = pose[b];
      // 采样不到就沿用上一帧（避免整条轨道出现空洞；正常路径不会走到这里）
      const fallback = i > 0 ? tracks[b][i - 1] : ([0, 0, 0, 1] as QuaternionTuple);
      const src = q ?? (fallback as Quat);
      tracks[b].push([round6(src[0]), round6(src[1]), round6(src[2]), round6(src[3])]);
    }
  }

  // ── 符号连续化 ───────────────────────────────────────────────────────
  let signFlipsFixed = 0;
  for (const b of bones) signFlipsFixed += makeSignContinuous(tracks[b]);

  const clip: ClipFile = {
    schemaVersion: CLIP_SPEC.schemaVersion,
    rigProfile: CLIP_SPEC.rigProfile,
    name,
    space: CLIP_SPEC.space,
    rotationMode: CLIP_SPEC.rotationMode,
    quaternionOrder: CLIP_SPEC.quaternionOrder,
    fps,
    frameCount,
    duration,
    loop: opts.loop ?? false,
    rootMotion: CLIP_SPEC.rootMotion,
    mask: [...bones].sort(),
    bones: tracks,
  };

  // 规范化模长（round6 会带来极小偏差；超过阈值的才算 ERROR，由校验器判）
  const { clip: normalized } = normalizeClipQuaternions(clip);

  // ── 用**同一个**校验器自检 ───────────────────────────────────────────
  const result = validateClip(normalized, {
    boneList: opts.boneList,
    targetBones: opts.targetBones ?? null,
  });

  return {
    ok: result.ok,
    clip: result.ok ? normalized : null,
    issues: result.issues,
    stats: {
      frameCount,
      fps,
      duration,
      sourceFrameCount: frames.length,
      trimmedMs,
      durationDriftMs: Math.abs(duration * 1000 - trimmedMs),
      signFlipsFixed,
      bones,
    },
  };
}
