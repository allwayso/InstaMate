/**
 * 画面呈现 ↔ 模型输入的隔离层。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  这里只做一件事，但它是整个 G2 里最容易搞错的地方
 * ══════════════════════════════════════════════════════════════════════════
 *  自拍习惯要求视频画面**镜像**显示（抬右手，画面里右手出现在屏幕右侧）。
 *  但送进 MediaPipe / Kalidokit 的关键点**绝不能镜像** —— 否则左右关系会被翻转，
 *  再叠上 Kalidokit 自身那套 already-flipped 的索引约定（见 smoothing.ts 文件头），
 *  就会出现"看起来对了但左右反了"这种最难查的状态。
 *
 *  所以把「显示变换」抽成纯函数：
 *      · 它只接收/返回**归一化坐标**，用来画 Canvas 覆盖层
 *      · 它**不改动** Landmark 数组本身
 *      · 模型侧没有任何镜像入口（模型输入恒为 false，见 MODEL_INPUT_MIRRORED）
 *
 *  这样"视觉镜像不影响模型输入"就变成一条可以断言的性质，而不是一句注释。
 */
import type { Landmark } from './mocap-types.ts';

/** ★ 送进模型的关键点是否经过镜像。恒为 false —— 常量而非配置，避免被误改。 */
export const MODEL_INPUT_MIRRORED = false;

/** 视频预览是否镜像给人看 */
export const PREVIEW_MIRRORED = true;

/** 归一化 x（0–1）→ 显示用 x。mirrored 时左右翻转。 */
export function toDisplayX(xNorm: number, mirrored: boolean = PREVIEW_MIRRORED): number {
  const x = Math.max(0, Math.min(1, xNorm));
  return mirrored ? 1 - x : x;
}

/** 归一化 y（0–1，向下为正）→ 显示用 y。镜像只翻 x，不翻 y。 */
export function toDisplayY(yNorm: number): number {
  return Math.max(0, Math.min(1, yNorm));
}

/**
 * 归一化坐标 → Canvas 像素坐标。
 * 覆盖层与 `<video>` 用同一套变换，关键点才会与人物对齐。
 */
export function toCanvasPoint(
  xNorm: number,
  yNorm: number,
  width: number,
  height: number,
  mirrored: boolean = PREVIEW_MIRRORED,
): { x: number; y: number } {
  return { x: toDisplayX(xNorm, mirrored) * width, y: toDisplayY(yNorm) * height };
}

/**
 * 关键点缺失判定：任一坐标是 null 就画不出来。
 * 注意**不用** `x === 0` 判缺 —— 0 是合法坐标（画面左边缘 / 中线）。
 */
export function isDrawable(lm: Landmark | undefined | null): lm is Landmark & { x: number; y: number } {
  return !!lm && typeof lm.x === 'number' && typeof lm.y === 'number';
}

/**
 * 按可见度给关键点定色（计划 §四）：
 *   · < 0.5          → 黄色（偏低）
 *   · 严重丢失        → 红色
 *   · 其它            → 由调用方给的本色（左右手用不同颜色）
 */
export const LOW_CONFIDENCE = 0.5;
export const LOST_CONFIDENCE = 0.2;

export function confidenceColor(
  visibility: number | null,
  fallback: string,
): { color: string; level: 'ok' | 'low' | 'lost' } {
  const v = typeof visibility === 'number' ? visibility : 0;
  if (v < LOST_CONFIDENCE) return { color: '#e03131', level: 'lost' };
  if (v < LOW_CONFIDENCE) return { color: '#f2c037', level: 'low' };
  return { color: fallback, level: 'ok' };
}
