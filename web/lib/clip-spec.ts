/**
 * clip v1 规格与校验规则 —— **浏览器与 CLI 共用的唯一实现**。
 *
 * 本文件刻意**不 import 任何东西**：
 * - 浏览器侧由 web/lib/contracts.ts 再导出，并注入骨骼表；
 * - CLI 侧（tools/validate-clip.mjs）用 Node 的类型擦除直接 import 本 .ts，
 *   自己读 human-bones-vrm1.json 后注入 —— 这样 Node 不需要 JSON import attributes。
 *
 * 规则来源：docs/Collaborate.md §九.2。改动规则必须同时跑 tools/validate-clip.mjs 的 fixtures。
 */

// ---------------------------------------------------------------------------
// 契约常量
// ---------------------------------------------------------------------------

export const CLIP_SPEC = {
  schemaVersion: 1,
  /** 项目内部 rigProfile：normalized 参考姿态下的绝对局部旋转 */
  rigProfile: 'vrm-normalized-v1',
  space: 'normalized-local',
  rotationMode: 'absolute',
  quaternionOrder: 'xyzw',
  rootMotion: 'locked',
  /** 第 n 帧时间为 n/fps，duration = (frameCount-1)/fps，容差 1e-6 秒 */
  durationTolerance: 1e-6,
  /** 加载时模长偏差不超过此值可再规范化；超过则拒绝 */
  quaternionNormTolerance: 1e-3,
  /**
   * 「建议再规范化」的提示门槛。
   * 必须远大于浮点噪声（双精度下重规范化后残差约 1e-16），否则每个文件都会亮这条提示。
   */
  renormNoticeThreshold: 1e-9,
  /** 默认导出帧率 */
  defaultFps: 30,
} as const;

/** v1 禁止出现的顶层字段（根位移 / 骨骼缩放 / 表情轨道 / 弹簧骨轨道） */
export const FORBIDDEN_CLIP_KEYS = [
  'translations',
  'positions',
  'rootTranslation',
  'scales',
  'expressions',
  'morphTargets',
  'blendShapes',
  'springBones',
  'springBoneTracks',
] as const;

/** [x, y, z, w] */
export type QuaternionTuple = [number, number, number, number];

export interface ClipFile {
  schemaVersion: typeof CLIP_SPEC.schemaVersion;
  rigProfile: typeof CLIP_SPEC.rigProfile;
  /** 动作标识，非空字符串 */
  name: string;
  space: typeof CLIP_SPEC.space;
  rotationMode: typeof CLIP_SPEC.rotationMode;
  quaternionOrder: typeof CLIP_SPEC.quaternionOrder;
  fps: number;
  frameCount: number;
  duration: number;
  /** 必须是布尔值 */
  loop: boolean;
  rootMotion: typeof CLIP_SPEC.rootMotion;
  /** 必须与 bones 的轨道名集合完全一致 */
  mask: string[];
  bones: Record<string, QuaternionTuple[]>;
}

const KNOWN_KEYS = new Set([
  'schemaVersion',
  'rigProfile',
  'name',
  'space',
  'rotationMode',
  'quaternionOrder',
  'fps',
  'frameCount',
  'duration',
  'loop',
  'rootMotion',
  'mask',
  'bones',
]);

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export type IssueLevel = 'ERROR' | 'WARN';

export interface ValidationIssue {
  level: IssueLevel;
  rule: string;
  msg: string;
  bone?: string;
  frame?: number;
}

export interface ClipTrackInfo {
  name: string;
  frames: number;
  /** 存在模长偏差 >0 但 <= 容差的帧，加载时可再规范化 */
  needRenorm: boolean;
  /** 相邻帧点积 < 0 的次数，采样时需翻符号走最短路径 */
  signFlips: number;
  maxNormErr: number;
}

export interface ValidationResult {
  name: string | null;
  issues: ValidationIssue[];
  tracks: ClipTrackInfo[];
  errors: number;
  warnings: number;
  ok: boolean;
}

export interface ValidateOptions {
  /** VRM 1.0 规范骨骼表；不传则跳过人名合法性检查 */
  boneList?: readonly string[];
  /** 目标资产实际拥有的骨骼；不传则只查规范表 */
  targetBones?: readonly string[] | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 校验一个 clip。纯函数，不读写文件、不依赖 DOM。
 * 规则编号（R1–R12）与 docs/Collaborate.md §九.2 一一对应。
 */
export function validateClip(clip: unknown, opts: ValidateOptions = {}): ValidationResult {
  const { boneList, targetBones = null } = opts;
  const boneSet = boneList ? new Set(boneList) : null;
  const targetSet = targetBones ? new Set(targetBones) : null;

  const issues: ValidationIssue[] = [];
  const tracks: ClipTrackInfo[] = [];
  const add = (level: IssueLevel, rule: string, msg: string, extra: Partial<ValidationIssue> = {}) =>
    issues.push({ level, rule, msg, ...extra });

  const finish = (name: string | null): ValidationResult => ({
    name,
    issues,
    tracks,
    errors: issues.filter((i) => i.level === 'ERROR').length,
    warnings: issues.filter((i) => i.level === 'WARN').length,
    ok: !issues.some((i) => i.level === 'ERROR'),
  });

  if (!isObj(clip)) {
    add('ERROR', 'R0 根结构', '顶层必须是一个 JSON 对象');
    return finish(null);
  }

  const name = typeof clip.name === 'string' ? clip.name : null;
  if (typeof clip.name !== 'string' || clip.name.trim() === '') {
    add('ERROR', 'R13 name', `name 必须是非空字符串，实际 ${JSON.stringify(clip.name)}`);
  }

  // ---- R1 / R2 版本与骨架配置 ---------------------------------------------
  if (clip.schemaVersion !== CLIP_SPEC.schemaVersion) {
    add('ERROR', 'R1 schemaVersion', `必须是 ${CLIP_SPEC.schemaVersion}，实际 ${JSON.stringify(clip.schemaVersion)}`);
  }
  if (clip.rigProfile !== CLIP_SPEC.rigProfile) {
    add('ERROR', 'R2 rigProfile', `必须是 "${CLIP_SPEC.rigProfile}"，实际 ${JSON.stringify(clip.rigProfile)}`);
  }
  for (const [key, want] of [
    ['space', CLIP_SPEC.space],
    ['rotationMode', CLIP_SPEC.rotationMode],
    ['quaternionOrder', CLIP_SPEC.quaternionOrder],
  ] as const) {
    if (clip[key] !== want) {
      add('ERROR', `R2 ${key}`, `必须是 "${want}"，实际 ${JSON.stringify(clip[key])}`);
    }
  }

  // ---- R3 fps / frameCount / loop ----------------------------------------
  const fps = clip.fps;
  const frameCount = clip.frameCount;
  if (!isFiniteNum(fps) || fps <= 0) {
    add('ERROR', 'R3 fps', `fps 必须是 > 0 的有限数字，实际 ${JSON.stringify(fps)}`);
  }
  if (typeof frameCount !== 'number' || !Number.isInteger(frameCount) || frameCount < 2) {
    add('ERROR', 'R3 frameCount', `frameCount 必须是 >= 2 的整数，实际 ${JSON.stringify(frameCount)}`);
  }
  if (typeof clip.loop !== 'boolean') {
    add('ERROR', 'R13 loop', `loop 必须是布尔值，实际 ${JSON.stringify(clip.loop)}`);
  }

  // ---- R4 时长 -----------------------------------------------------------
  if (isFiniteNum(fps) && fps > 0 && Number.isInteger(frameCount) && (frameCount as number) >= 2) {
    const expect = ((frameCount as number) - 1) / fps;
    if (!isFiniteNum(clip.duration)) {
      add('ERROR', 'R4 duration', `duration 必须是有限数字，实际 ${JSON.stringify(clip.duration)}`);
    } else if (Math.abs(clip.duration - expect) > CLIP_SPEC.durationTolerance) {
      add(
        'ERROR',
        'R4 duration',
        `duration 必须等于 (frameCount-1)/fps = ${expect}（容差 ${CLIP_SPEC.durationTolerance}），实际 ${clip.duration}`,
      );
    }
  }

  // ---- R12 v1 禁令 -------------------------------------------------------
  if (clip.rootMotion !== CLIP_SPEC.rootMotion) {
    add('ERROR', 'R12 rootMotion', `必须是 "${CLIP_SPEC.rootMotion}"（v1 禁止根位移），实际 ${JSON.stringify(clip.rootMotion)}`);
  }
  for (const k of FORBIDDEN_CLIP_KEYS) {
    if (k in clip) add('ERROR', 'R12 禁止字段', `v1 禁止出现顶层字段 "${k}"（根位移/缩放/表情/弹簧骨轨道）`);
  }
  for (const k of Object.keys(clip)) {
    if (!KNOWN_KEYS.has(k)) add('WARN', 'R12 未知字段', `顶层出现未定义字段 "${k}"，可能是拼写错误`);
  }

  // ---- bones（R5–R11）----------------------------------------------------
  const bones = clip.bones;
  if (!isObj(bones)) {
    add('ERROR', 'R5 bones', 'bones 必须是对象 { 骨骼名: [四元数, ...] }');
    return finish(name);
  }
  const trackNames = Object.keys(bones);
  if (trackNames.length === 0) add('ERROR', 'R5 bones', 'bones 不能为空');

  for (const boneName of trackNames) {
    const track = bones[boneName];
    if (!Array.isArray(track)) {
      add('ERROR', 'R5 轨道类型', `"${boneName}" 的轨道必须是数组`, { bone: boneName });
      continue;
    }
    if (boneSet && !boneSet.has(boneName)) {
      add('ERROR', 'R9 骨骼名', `"${boneName}" 不在 VRM 1.0 人形骨骼表中`, { bone: boneName });
    }
    if (targetSet && !targetSet.has(boneName)) {
      add('ERROR', 'R9 目标缺失骨骼', `目标资产没有 "${boneName}"，不能驱动（拒绝该动作）`, { bone: boneName });
    }

    let needRenorm = false;
    let signFlips = 0;
    let maxNormErr = 0;

    for (let i = 0; i < track.length; i++) {
      const q = track[i] as unknown;
      if (!Array.isArray(q) || q.length !== 4) {
        add('ERROR', 'R6 四元数结构', `"${boneName}" 第 ${i} 帧不是 4 元组：${JSON.stringify(q)}`, { bone: boneName, frame: i });
        continue;
      }
      if (!q.every(isFiniteNum)) {
        add('ERROR', 'R6 非有限数字', `"${boneName}" 第 ${i} 帧含 NaN/Infinity/非数字`, { bone: boneName, frame: i });
        continue;
      }
      const norm = Math.hypot(q[0] as number, q[1] as number, q[2] as number, q[3] as number);
      if (norm === 0) {
        add('ERROR', 'R7 零长度四元数', `"${boneName}" 第 ${i} 帧模长为 0，无法规范化`, { bone: boneName, frame: i });
        continue;
      }
      const err = Math.abs(norm - 1);
      maxNormErr = Math.max(maxNormErr, err);
      if (err > CLIP_SPEC.quaternionNormTolerance) {
        add(
          'ERROR',
          'R7 非单位四元数',
          `"${boneName}" 第 ${i} 帧模长 ${norm}，偏差 ${err} 超过容差 ${CLIP_SPEC.quaternionNormTolerance}`,
          { bone: boneName, frame: i },
        );
      } else if (err > CLIP_SPEC.renormNoticeThreshold) {
        needRenorm = true;
      }
    }

    if (Number.isInteger(frameCount) && track.length !== frameCount) {
      add('ERROR', 'R5 轨道长度', `"${boneName}" 有 ${track.length} 帧，应为 frameCount = ${frameCount}`, { bone: boneName });
    }

    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1] as unknown;
      const b = track[i] as unknown;
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) continue;
      if (!a.every(isFiniteNum) || !b.every(isFiniteNum)) continue;
      const dot =
        (a[0] as number) * (b[0] as number) +
        (a[1] as number) * (b[1] as number) +
        (a[2] as number) * (b[2] as number) +
        (a[3] as number) * (b[3] as number);
      if (dot < 0) signFlips++;
    }
    if (signFlips > 0) {
      add(
        'WARN',
        'R10 符号跳变',
        `"${boneName}" 有 ${signFlips}/${Math.max(0, track.length - 1)} 处相邻帧点积 < 0，采样时须翻符号走最短路径 slerp`,
        { bone: boneName },
      );
    }

    if (clip.loop === true && track.length >= 2) {
      const first = track[0] as unknown;
      const last = track[track.length - 1] as unknown;
      if (Array.isArray(first) && Array.isArray(last) && first.length === 4 && last.length === 4) {
        const dot =
          (first[0] as number) * (last[0] as number) +
          (first[1] as number) * (last[1] as number) +
          (first[2] as number) * (last[2] as number) +
          (first[3] as number) * (last[3] as number);
        const seam = 1 - Math.abs(dot);
        if (seam > 1e-3) {
          add('WARN', 'R11 循环接缝', `"${boneName}" 首尾姿态不一致（夹角量度 ${seam.toFixed(6)}），循环时会跳变`, { bone: boneName });
        }
      }
    }

    tracks.push({ name: boneName, frames: track.length, needRenorm, signFlips, maxNormErr });
  }

  // ---- R8 mask 与轨道集合一致 --------------------------------------------
  if (!Array.isArray(clip.mask)) {
    add('ERROR', 'R8 mask', 'mask 必须是字符串数组');
  } else {
    const maskSet = new Set(clip.mask as unknown[]);
    const trackSet = new Set(trackNames);
    const onlyInMask = [...maskSet].filter((m) => !trackSet.has(m as string));
    const onlyInTracks = trackNames.filter((t) => !maskSet.has(t));
    if (onlyInMask.length || onlyInTracks.length) {
      add(
        'ERROR',
        'R8 mask 不一致',
        `mask 与轨道名集合必须一致。仅在 mask：${onlyInMask.join(', ') || '无'}；仅在轨道：${onlyInTracks.join(', ') || '无'}`,
      );
    }
    if (clip.mask.length !== maskSet.size) add('WARN', 'R8 mask 重复项', 'mask 里有重复的骨骼名');
  }

  const needRenormTracks = tracks.filter((t) => t.needRenorm);
  if (needRenormTracks.length > 0) {
    add(
      'WARN',
      'R7 需再规范化',
      `${needRenormTracks.length} 条轨道存在模长偏差 >0 但 <= ${CLIP_SPEC.quaternionNormTolerance} 的帧，加载时可再规范化：${needRenormTracks.map((t) => t.name).join(', ')}`,
    );
  }

  return finish(name);
}

/**
 * 把**允许范围内**的四元数模长误差规范化。返回新的 clip 对象，**不修改入参**，
 * 更不会写回文件（「加载时规范化允许范围内的四元数误差，不改变原文件」）。
 * 超出容差的帧原样保留，交由 validateClip 报错。
 */
export function normalizeClipQuaternions(clip: ClipFile): { clip: ClipFile; changed: boolean } {
  let changed = false;
  const bones: Record<string, QuaternionTuple[]> = {};
  for (const [boneName, track] of Object.entries(clip.bones ?? {})) {
    bones[boneName] = track.map((q) => {
      const n = Math.hypot(q[0], q[1], q[2], q[3]);
      if (n === 0 || Math.abs(n - 1) > CLIP_SPEC.quaternionNormTolerance) return q;
      // 用提示门槛而非 n !== 1 判断：双精度下重规范化后残差约 1e-16，
      // 拿 n === 1 当条件会让这份提示永远亮着、失去意义
      if (Math.abs(n - 1) <= CLIP_SPEC.renormNoticeThreshold) return q;
      changed = true;
      return [q[0] / n, q[1] / n, q[2] / n, q[3] / n] as QuaternionTuple;
    });
  }
  return { clip: changed ? { ...clip, bones } : clip, changed };
}

// ---------------------------------------------------------------------------
// 采样用的小工具（播放器与测试共用，保持"只有一处四元数数学"）
// ---------------------------------------------------------------------------

/** 最短路径 slerp：先消掉符号跳变，再做球面插值 */
export function slerpQuat(a: QuaternionTuple, b: QuaternionTuple, t: number): QuaternionTuple {
  let [bx, by, bz, bw] = b;
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    const out: QuaternionTuple = [
      a[0] + t * (bx - a[0]),
      a[1] + t * (by - a[1]),
      a[2] + t * (bz - a[2]),
      a[3] + t * (bw - a[3]),
    ];
    const n = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
    return [out[0] / n, out[1] / n, out[2] / n, out[3] / n];
  }
  const theta0 = Math.acos(Math.min(1, dot));
  const theta = theta0 * t;
  const sinTheta = Math.sin(theta);
  const sinTheta0 = Math.sin(theta0);
  const s0 = Math.cos(theta) - (dot * sinTheta) / sinTheta0;
  const s1 = sinTheta / sinTheta0;
  return [a[0] * s0 + bx * s1, a[1] * s0 + by * s1, a[2] * s0 + bz * s1, a[3] * s0 + bw * s1];
}
