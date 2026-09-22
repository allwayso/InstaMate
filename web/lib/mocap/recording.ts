/**
 * 录制缓冲与质量统计。
 *
 * 职责边界：本文件**只负责"攒帧 + 算指标"**，不算姿态、不碰 VRM、不读时钟
 * （时刻由调用方传入）。这样单元测试可以喂一串合成帧直接验指标，
 * 不需要摄像头也不需要计时器。
 *
 * 为什么质量指标这么重要：真人动捕失败的方式通常是"看起来在动，其实有半秒丢了"。
 * 所以要在录制时就量化三件事，并让它决定这段能不能生成 clip：
 *   · 有效帧占比      —— 低于 70% 直接禁止生成
 *   · 最长丢失段      —— 超过 500ms 允许预览但必须警告
 *   · 推理帧率        —— 判断是不是机器跟不上（帧率低会让动作变慢）
 */
import { MOCAP_LIMITS, type MocapQuality, type RecordingStats } from './mocap-types.ts';

/** 录制缓冲里的一帧 */
export interface RecordingFrame {
  timestampMs: number;
  /** 交给 CharacterRuntime 的最终姿态（已校准 + 平滑 + 回退） */
  pose: Record<string, [number, number, number, number]>;
  /** 这一帧身体是否被检到 */
  tracked: boolean;
  /** 这一帧处于"跟踪丢失"档（>500ms）的骨骼 */
  lostBones: string[];
}

export interface RecordingOutcome {
  frames: RecordingFrame[];
  stats: RecordingStats;
  quality: MocapQuality;
  /** 是否满足生成 clip 的质量门槛（有效帧 ≥70%） */
  canBuildClip: boolean;
}

/**
 * 录制会话。
 *
 * 采样即判定：`add()` 时就把"这帧算不算有效"定下来，而不是事后重算 ——
 * 事后重算需要保留每一帧的置信度明细，而那个明细对生成 clip 没用。
 */
export class RecordingSession {
  readonly maxDurationMs: number;

  private frames: RecordingFrame[] = [];
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;

  /** 丢失段的起点（毫秒），null 表示当前没有丢失 */
  private bodyLostSince: number | null = null;
  /** 每根骨骼的丢失起点 */
  private boneLostSince = new Map<string, number>();
  /** 已闭合的丢失段时长 */
  private gapsMs: number[] = [];

  constructor(maxDurationMs: number = MOCAP_LIMITS.maxRecordingMs) {
    this.maxDurationMs = maxDurationMs;
  }

  start(nowMs: number): void {
    this.frames = [];
    this.startedAt = nowMs;
    this.stoppedAt = null;
    this.bodyLostSince = null;
    this.boneLostSince.clear();
    this.gapsMs = [];
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get durationMs(): number {
    if (this.startedAt === null) return 0;
    const end = this.stoppedAt ?? this.frames[this.frames.length - 1]?.timestampMs ?? this.startedAt;
    return end - this.startedAt;
  }

  /** 是否已到 10 秒上限（页面据此自动停止） */
  get isFull(): boolean {
    return this.durationMs >= this.maxDurationMs;
  }

  get isRecording(): boolean {
    return this.startedAt !== null && this.stoppedAt === null;
  }

  /** 一帧是否"有效"：身体检到、且没有任何骨骼处于丢失档 */
  private isFrameValid(f: RecordingFrame): boolean {
    return f.tracked && f.lostBones.length === 0;
  }

  add(frame: RecordingFrame): void {
    if (this.startedAt === null || this.stoppedAt !== null) return;

    // 身体是否丢失：检不到身体本身就算一段丢失
    if (frame.tracked) {
      if (this.bodyLostSince !== null) {
        this.gapsMs.push(frame.timestampMs - this.bodyLostSince);
        this.bodyLostSince = null;
      }
    } else if (this.bodyLostSince === null) {
      this.bodyLostSince = frame.timestampMs;
    }

    // 逐骨骼的丢失段
    const lostNow = new Set(frame.lostBones);
    for (const bone of lostNow) {
      if (!this.boneLostSince.has(bone)) this.boneLostSince.set(bone, frame.timestampMs);
    }
    for (const [bone, since] of [...this.boneLostSince]) {
      if (!lostNow.has(bone)) {
        this.gapsMs.push(frame.timestampMs - since);
        this.boneLostSince.delete(bone);
      }
    }

    this.frames.push(frame);
  }

  /** 结束录制；把还没闭合的丢失段收尾 */
  stop(nowMs: number): RecordingOutcome {
    if (this.stoppedAt === null) this.stoppedAt = nowMs;
    if (this.bodyLostSince !== null) {
      this.gapsMs.push(this.stoppedAt - this.bodyLostSince);
      this.bodyLostSince = null;
    }
    for (const [, since] of this.boneLostSince) this.gapsMs.push(this.stoppedAt - since);
    this.boneLostSince.clear();

    const stats = this.stats();
    const quality: MocapQuality = {
      validFrameRatio: stats.validFrameRatio,
      inferenceFpsMean: stats.inferenceFps,
      longestTrackingGapMs: stats.longestTrackingGapMs,
      warnings: [],
    };
    if (stats.longestTrackingGapMs > MOCAP_LIMITS.lostGapMs) {
      quality.warnings.push(
        `存在 ${Math.round(stats.longestTrackingGapMs)}ms 的跟踪丢失段（超过 ${MOCAP_LIMITS.lostGapMs}ms）：允许预览，但这段动作不可信`,
      );
    }
    if (stats.validFrameRatio < MOCAP_LIMITS.minValidFrameRatio) {
      quality.warnings.push(
        `有效帧仅 ${(stats.validFrameRatio * 100).toFixed(1)}%，低于 ${MOCAP_LIMITS.minValidFrameRatio * 100}%，不允许生成动作`,
      );
    }

    return {
      frames: [...this.frames],
      stats,
      quality,
      canBuildClip: stats.validFrameRatio >= MOCAP_LIMITS.minValidFrameRatio,
    };
  }

  /** 当前指标（录制中也能读，供 HUD 实时显示） */
  stats(): RecordingStats {
    const frameCount = this.frames.length;
    const durationMs = this.durationMs;
    const validCount = this.frames.filter((f) => this.isFrameValid(f)).length;
    const lostBoneCount = new Set(this.frames.flatMap((f) => f.lostBones)).size;

    return {
      frameCount,
      durationMs,
      // 推理帧率 = 帧数 / 时长；时长为 0 时记 0（而不是 Infinity）
      inferenceFps: durationMs > 0 ? (frameCount / durationMs) * 1000 : 0,
      validFrameRatio: frameCount > 0 ? validCount / frameCount : 0,
      longestTrackingGapMs: this.gapsMs.length ? Math.max(...this.gapsMs) : 0,
      lostBoneCount,
    };
  }

  /** 录制中的帧（不改动内部状态） */
  getFrames(): RecordingFrame[] {
    return [...this.frames];
  }
}

/**
 * 判断一段录制能不能生成 clip，并给出人可读的理由。
 * 与 RecordingSession.stop() 的 canBuildClip 口径一致，抽出来便于单测。
 */
export function checkBuildable(quality: MocapQuality): { ok: boolean; reason: string | null } {
  if (quality.validFrameRatio < MOCAP_LIMITS.minValidFrameRatio) {
    return {
      ok: false,
      reason: `有效帧占比 ${(quality.validFrameRatio * 100).toFixed(1)}% 低于门槛 ${MOCAP_LIMITS.minValidFrameRatio * 100}%，这段录制不足以生成动作，请重录`,
    };
  }
  return { ok: true, reason: null };
}
