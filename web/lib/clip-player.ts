/**
 * ClipPlayer —— 管理播放时间、状态、采样、切换与淡入淡出，**返回骨骼姿态，不持有 VRM**。
 *
 * 分工（G1 计划）：
 *   ClipPlayer        只管「某时刻各骨骼该是什么四元数」
 *   CharacterRuntime  是唯一把姿态写进 normalized 骨骼的人
 *
 * 关键约定：
 * - 按**秒**采样，与显示帧率无关（30fps 的 clip 在 60Hz / 120Hz 屏上得到同一姿态）。
 * - 全部用最短路径 slerp。
 * - 切换时冻结上一个动作的姿态，在新旧 mask 的并集上从该姿态过渡；
 *   退出 mask 的骨骼因此会平滑回到基础站姿，而不是瞬间弹回。
 */
import { slerpQuat as slerpQ } from './clip-spec.ts';
import type { ClipFile, QuaternionTuple } from './clip-spec.ts';
import { baseQuatOf, IDENTITY, slerp as slerpPose } from './pose.ts';
import type { Pose, Quat } from './pose.ts';

export const DEFAULT_FADE = 0.2;

/** 被新动作取代 / 被 stop() 打断时的可识别取消信号 */
export class ClipPlaybackCancelledError extends Error {
  readonly clipName: string;
  constructor(clipName: string, reason: 'replaced' | 'stopped') {
    super(`动作 "${clipName}" 的播放被${reason === 'replaced' ? '新动作取代' : ' stop() 停止'}，未播放完成`);
    this.name = 'ClipPlaybackCancelledError';
    this.clipName = clipName;
  }
}

export type PlaybackState = 'idle' | 'playing' | 'paused' | 'fadingOut';

export interface ClipSnapshot {
  name: string | null;
  state: PlaybackState;
  /** 秒 */
  time: number;
  /** 秒 */
  duration: number;
  loop: boolean;
  /** 当前动作在合成姿态中的权重 0..1（淡入淡出期间在变） */
  weight: number;
  /** 正在淡出的上一个动作名 */
  outgoing: string | null;
}

export interface ClipPlayOptions {
  fadeIn?: number;
  fadeOut?: number;
  loop?: boolean;
  /** 从某个时刻开始播放（秒），用于时间轴定位后继续播 */
  startTime?: number;
}

interface Active {
  clip: ClipFile;
  time: number;
  loop: boolean;
  fadeIn: number;
  fadeOut: number;
  /** 淡入进度 0..1 */
  weight: number;
  /** 淡出剩余秒数；null 表示不在淡出 */
  fadeOutLeft: number | null;
  settle: { resolve: () => void; reject: (e: Error) => void } | null;
}

interface Outgoing {
  clip: ClipFile;
  /** 冻结的姿态（切换瞬间采样） */
  pose: Pose;
  bones: string[];
  left: number;
  total: number;
}

const clampTime = (clip: ClipFile, t: number) =>
  Math.max(0, Math.min(t, (clip.frameCount - 1) / clip.fps));

/** 在两条轨道间按秒采样：i0/i1 + 小数部分做最短路径 slerp */
function sampleBone(clip: ClipFile, bone: string, timeSec: number): Quat {
  const track = clip.bones[bone];
  if (!track || track.length === 0) return baseQuatOf(bone);
  const last = track.length - 1;
  const pos = Math.max(0, Math.min(timeSec * clip.fps, last));
  const i0 = Math.floor(pos);
  const i1 = Math.min(i0 + 1, last);
  const frac = pos - i0;
  if (i0 === i1 || frac === 0) return track[i0] as Quat;
  return slerpQ(track[i0] as QuaternionTuple, track[i1] as QuaternionTuple, frac) as Quat;
}

function samplePose(clip: ClipFile, timeSec: number): Pose {
  const pose: Pose = {};
  for (const bone of clip.mask) pose[bone] = sampleBone(clip, bone, timeSec);
  return pose;
}

export class ClipPlayer {
  private current: Active | null = null;
  private outgoing: Outgoing | null = null;
  /** 用户主动暂停 */
  private paused = false;
  /** 页面不可见时的挂起（与用户暂停分开，恢复可见不会替用户取消暂停） */
  private suspended = false;

  // -------------------------------------------------------------------------
  // 播放控制
  // -------------------------------------------------------------------------

  play(clip: ClipFile, opts: ClipPlayOptions = {}): Promise<void> {
    const fadeIn = opts.fadeIn ?? DEFAULT_FADE;
    const fadeOut = opts.fadeOut ?? DEFAULT_FADE;

    // 替换前先把当前姿态冻结成 outgoing，实现「从当前合成姿态过渡」
    if (this.current) {
      const frozen = this.compositePose();
      this.outgoing = {
        clip: this.current.clip,
        pose: frozen,
        bones: Object.keys(frozen),
        left: fadeOut,
        total: Math.max(fadeOut, 1e-6),
      };
      this.settleCurrent(new ClipPlaybackCancelledError(this.current.clip.name, 'replaced'));
    }

    const startTime = clampTime(clip, opts.startTime ?? 0);
    let resolveFn: () => void = () => {};
    let rejectFn: (e: Error) => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    this.current = {
      clip,
      time: startTime,
      loop: opts.loop ?? clip.loop,
      fadeIn,
      fadeOut,
      weight: fadeIn > 0 ? 0 : 1,
      fadeOutLeft: null,
      settle: { resolve: resolveFn, reject: rejectFn },
    };
    this.paused = false;

    // 循环动作：启动即算成功（不等待，因为永远不会「播完」）
    if (this.current.loop) {
      this.settleCurrent(null);
    }
    return promise;
  }

  pause(): void {
    if (this.current) this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** 页面隐藏/恢复：挂起动作时钟，恢复后不会突然跳到结尾 */
  setSuspended(v: boolean): void {
    this.suspended = v;
  }

  /** 定位到某时刻并保持暂停，便于逐帧验收 */
  seek(seconds: number): void {
    if (!this.current) return;
    this.current.time = clampTime(this.current.clip, seconds);
    this.current.weight = 1;
    this.current.fadeOutLeft = null;
    this.paused = true;
  }

  stop(): void {
    if (this.current) {
      const frozen = this.compositePose();
      this.outgoing = {
        clip: this.current.clip,
        pose: frozen,
        bones: Object.keys(frozen),
        left: this.current.fadeOut,
        total: Math.max(this.current.fadeOut, 1e-6),
      };
      this.settleCurrent(new ClipPlaybackCancelledError(this.current.clip.name, 'stopped'));
      this.current = null;
    }
  }

  /** 立即清空一切（切角色时用），不留过渡 */
  reset(): void {
    this.settleCurrent(this.current ? new ClipPlaybackCancelledError(this.current.clip.name, 'stopped') : null);
    this.current = null;
    this.outgoing = null;
    this.paused = false;
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  getSnapshot(): ClipSnapshot {
    const c = this.current;
    return {
      name: c?.clip.name ?? null,
      state: !c ? (this.outgoing ? 'fadingOut' : 'idle') : this.paused || this.suspended ? 'paused' : c.fadeOutLeft !== null ? 'fadingOut' : 'playing',
      time: c?.time ?? 0,
      duration: c ? (c.clip.frameCount - 1) / c.clip.fps : 0,
      loop: c?.loop ?? false,
      weight: c?.weight ?? 0,
      outgoing: this.outgoing?.clip.name ?? null,
    };
  }

  isActive(): boolean {
    return this.current !== null || this.outgoing !== null;
  }

  /** 当前参与合成的全部骨骼（新旧 mask 的并集） */
  getBoneNames(): string[] {
    const set = new Set<string>();
    for (const b of this.current?.clip.mask ?? []) set.add(b);
    for (const b of this.outgoing?.bones ?? []) set.add(b);
    return [...set];
  }

  // -------------------------------------------------------------------------
  // 每帧推进
  // -------------------------------------------------------------------------

  /**
   * 推进 delta 秒并返回本帧要写入的骨骼姿态。
   * 返回的 pose 只包含参与合成的骨骼，且**每个值都是绝对局部四元数**；
   * 未列出的骨骼由调用方（CharacterRuntime）写基础站姿。
   */
  update(delta: number): Pose {
    const frozen = this.paused || this.suspended;
    const dt = frozen ? 0 : Math.max(0, delta);

    // ---- 推进当前动作 ----
    if (this.current) {
      const c = this.current;
      const endTime = (c.clip.frameCount - 1) / c.clip.fps;

      // 淡入
      if (c.weight < 1 && c.fadeIn > 0) {
        c.weight = Math.min(1, c.weight + dt / c.fadeIn);
      }

      if (c.fadeOutLeft === null) {
        c.time += dt;
        if (c.time >= endTime) {
          if (c.loop) {
            c.time = ((c.time - endTime) % Math.max(endTime, 1e-6)) + 0; // 回到开头继续
          } else {
            c.time = endTime;
            c.fadeOutLeft = c.fadeOut;
            if (c.fadeOut <= 0) this.finishCurrent();
          }
        }
      } else {
        c.fadeOutLeft -= dt;
        if (c.fadeOutLeft <= 0) {
          c.fadeOutLeft = 0;
          // 非循环动作：末帧后淡出完成，权重归零
          c.weight = Math.max(0, c.weight - dt / Math.max(c.fadeOut, 1e-6));
          if (c.weight <= 0) this.finishCurrent();
        } else {
          c.weight = Math.max(0, c.fadeOutLeft / Math.max(c.fadeOut, 1e-6));
        }
      }
    }

    // ---- 推进淡出中的上一个动作 ----
    if (this.outgoing) {
      this.outgoing.left -= dt;
      if (this.outgoing.left <= 0) this.outgoing = null;
    }

    return this.compositePose();
  }

  /** 合成当前姿态：outgoing 与新动作在各骨骼上按权重混合，未涉及骨骼回落基础站姿 */
  private compositePose(): Pose {
    const cur = this.current;
    const out = this.outgoing;

    if (!cur && !out) return {};

    const bones = new Set<string>();
    for (const b of cur?.clip.mask ?? []) bones.add(b);
    for (const b of out?.bones ?? []) bones.add(b);

    const pose: Pose = {};
    const w = cur ? cur.weight : 0;

    for (const bone of bones) {
      const base = baseQuatOf(bone);
      const curQ = cur?.clip.mask.includes(bone) ? sampleBone(cur.clip, bone, cur.time) : null;
      const outQ = (out?.pose[bone] as Quat | undefined) ?? null;

      // 新动作侧：没被新动作覆盖的骨骼回到基础站姿
      const targetNew = curQ ?? base;
      if (!out) {
        pose[bone] = w >= 1 ? targetNew : slerpPose(base, targetNew, w);
        continue;
      }
      // 有 outgoing：从 outgoing 冻结姿态过渡到 targetNew
      const from = outQ ?? base;
      pose[bone] = w >= 1 ? targetNew : slerpPose(from, targetNew, w);
    }
    return pose;
  }

  /** 结束当前动作：resolve（正常播完）或拒绝（已被取消） */
  private finishCurrent(): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    if (c.settle) {
      c.settle.resolve();
      c.settle = null;
    }
  }

  private settleCurrent(err: Error | null): void {
    const c = this.current;
    if (!c?.settle) return;
    const s = c.settle;
    c.settle = null;
    if (err) s.reject(err);
    else s.resolve();
  }
}

/** 把一个 pose 里未列出的骨骼补齐为基础站姿值（运行时写入前用） */
export function withBasePose(pose: Pose, bones: readonly string[]): Pose {
  const out: Pose = { ...pose };
  for (const b of bones) if (!(b in out)) out[b] = baseQuatOf(b);
  return out;
}

export { IDENTITY };
