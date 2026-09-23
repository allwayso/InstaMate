import type { Pose } from '../pose.ts';
import type { MocapRawFrame } from './mocap-types.ts';
import type { KalidokitHandLike, KalidokitPoseLike, RetargetBone, XYZ } from './retarget-profile.ts';
import type { ConfidenceTier } from './smoothing.ts';

export interface DiagnosticFrame {
  /** 与视频左上角时间码共用同一个 performance.now() 起点。 */
  tMs: number;
  raw: Omit<MocapRawFrame, 'timestampMs' | 'faceLandmarks'>;
  solver: {
    pose: KalidokitPoseLike | null;
    faceHead: XYZ | null;
    hands: { Right?: KalidokitHandLike | null; Left?: KalidokitHandLike | null } | null;
  };
  retarget: { pose: Pose; missing: RetargetBone[] };
  output: { pose: Pose; tiers: Record<string, ConfidenceTier>; lost: RetargetBone[] };
  confidence: Record<string, number>;
  tracked: boolean;
  inferenceMs: number;
  rendererApplyError: string | null;
}

export interface DiagnosticTrace {
  schemaVersion: 1;
  kind: 'mocap-diagnostic';
  startedAt: string;
  durationMs: number;
  videoMimeType: string;
  metadata: {
    cameraWidth: number;
    cameraHeight: number;
    previewMirrored: true;
    modelInputMirrored: false;
    avatarUrl: string;
    secondAvatarUrl: string | null;
    swapLeftRight: boolean;
    calibrationSkipped: boolean;
    calibrationCorrections: Pose | null;
    smoothing: { tauMs: number; holdMs: number; blendMs: number; minConfidence: number };
    avatarSlots: { id: string; url: string; bones: number; missing: string[] }[];
    holisticVersion: string;
    holisticOptions: Record<string, unknown>;
    kalidokitVersion: string;
    retargetProfile: string;
  };
  frames: DiagnosticFrame[];
}

export interface DiagnosticSources {
  video: HTMLVideoElement;
  overlay: HTMLCanvasElement;
  avatar: HTMLCanvasElement;
}

const WIDTH = 1280;
const HEIGHT = 520;
const PANEL_WIDTH = 640;
const PANEL_HEIGHT = 480;
const HEADER_HEIGHT = 40;
const CAPTURE_FPS = 20;

function supportedMimeType(): string {
  if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持视频录制（MediaRecorder）。');
  for (const mime of ['video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  throw new Error('当前浏览器没有可用的视频录制格式。');
}

/** 同屏视频和逐帧管线数据使用同一个单调时钟。 */
export class DiagnosticRecorder {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly stream: MediaStream;
  private readonly recorder: MediaRecorder;
  private readonly sources: DiagnosticSources;
  private readonly chunks: Blob[] = [];
  private readonly frames: DiagnosticFrame[] = [];
  private readonly startedAtMs: number;
  private readonly startedAtIso: string;
  private readonly metadata: DiagnosticTrace['metadata'];
  private raf: number | null = null;
  private lastPaintMs = 0;

  constructor(sources: DiagnosticSources, metadata: DiagnosticTrace['metadata']) {
    if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
      throw new Error('当前浏览器不支持 Canvas 视频录制。');
    }
    this.sources = sources;
    this.metadata = metadata;
    this.canvas = document.createElement('canvas');
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('无法创建诊断录制画布。');
    this.context = context;
    this.startedAtMs = performance.now();
    this.startedAtIso = new Date().toISOString();
    this.paint(performance.now());
    this.stream = this.canvas.captureStream(CAPTURE_FPS);
    try {
      this.recorder = new MediaRecorder(this.stream, {
        mimeType: supportedMimeType(),
        videoBitsPerSecond: 2_500_000,
      });
    } catch (error) {
      this.stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
    this.recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size) this.chunks.push(event.data);
    });
    try {
      this.recorder.start(1_000);
    } catch (error) {
      this.stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
    this.paintLoop();
  }

  get elapsedMs(): number {
    return performance.now() - this.startedAtMs;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  append(frame: Omit<DiagnosticFrame, 'tMs'> & { timestampMs: number }): void {
    if (this.recorder.state !== 'recording') return;
    const { timestampMs, ...data } = frame;
    this.frames.push({ ...data, tMs: Math.max(0, Math.round(timestampMs - this.startedAtMs)) });
  }

  async stop(): Promise<{ video: Blob; trace: DiagnosticTrace }> {
    if (this.recorder.state !== 'recording') throw new Error('诊断录制已停止。');
    const durationMs = Math.round(this.elapsedMs);
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.paint(performance.now());
    const stopped = new Promise<void>((resolve, reject) => {
      this.recorder.addEventListener('stop', () => resolve(), { once: true });
      this.recorder.addEventListener('error', () => reject(new Error('浏览器视频编码失败。')), { once: true });
    });
    this.recorder.stop();
    try {
      await stopped;
    } finally {
      this.stream.getTracks().forEach((track) => track.stop());
    }
    const video = new Blob(this.chunks, { type: this.recorder.mimeType });
    if (!video.size) throw new Error('浏览器没有产出视频数据。');
    return {
      video,
      trace: {
        schemaVersion: 1,
        kind: 'mocap-diagnostic',
        startedAt: this.startedAtIso,
        durationMs,
        videoMimeType: this.recorder.mimeType,
        metadata: this.metadata,
        frames: this.frames,
      },
    };
  }

  abort(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    this.stream.getTracks().forEach((track) => track.stop());
  }

  private paintLoop = (now?: number): void => {
    const at = now ?? performance.now();
    if (at - this.lastPaintMs >= 1_000 / CAPTURE_FPS) {
      this.paint(at);
      this.lastPaintMs = at;
    }
    this.raf = requestAnimationFrame(this.paintLoop);
  };

  private paint(now: number): void {
    const ctx = this.context;
    ctx.fillStyle = '#10171b';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#18262d';
    ctx.fillRect(0, 0, WIDTH, HEADER_HEIGHT);
    ctx.fillStyle = '#e6f1ed';
    ctx.font = '18px sans-serif';
    ctx.fillText('摄像头 · 镜像预览 + 关键点', 16, 26);
    ctx.fillText('3D 角色 · 实时输出', PANEL_WIDTH + 16, 26);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.max(0, (now - this.startedAtMs) / 1_000).toFixed(2)} s`, WIDTH - 16, 26);
    ctx.textAlign = 'left';

    const { video, overlay, avatar } = this.sources;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      ctx.save();
      ctx.translate(PANEL_WIDTH, HEADER_HEIGHT);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, PANEL_WIDTH, PANEL_HEIGHT);
      ctx.restore();
    }
    if (overlay.width && overlay.height) {
      ctx.drawImage(overlay, 0, HEADER_HEIGHT, PANEL_WIDTH, PANEL_HEIGHT);
    }
    if (avatar.width && avatar.height) {
      ctx.drawImage(avatar, PANEL_WIDTH, HEADER_HEIGHT, PANEL_WIDTH, PANEL_HEIGHT);
    }
    ctx.fillStyle = '#7be4b4';
    ctx.fillRect(PANEL_WIDTH - 1, HEADER_HEIGHT, 2, PANEL_HEIGHT);
  }
}
