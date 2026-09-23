/** 诊断录制只保存在本机 data/mocap/diagnostics，不进入动作库或 public。 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DiagnosticTrace } from './diagnostic-recorder.ts';

/** 与 motion-library-store.ts 相同的 web/ 运行目录约定。 */
export const DIAGNOSTIC_DIR = join(resolve(process.cwd(), '..'), 'data', 'mocap', 'diagnostics');
export const MAX_DIAGNOSTIC_BODY_BYTES = 90 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 48 * 1024 * 1024;
export const MAX_TRACE_BYTES = 35 * 1024 * 1024;

export function validateDiagnosticTrace(value: unknown): value is DiagnosticTrace {
  if (!value || typeof value !== 'object') return false;
  const trace = value as Partial<DiagnosticTrace>;
  return trace.schemaVersion === 1 &&
    trace.kind === 'mocap-diagnostic' &&
    typeof trace.startedAt === 'string' &&
    Number.isFinite(Date.parse(trace.startedAt)) &&
    typeof trace.durationMs === 'number' &&
    trace.durationMs > 0 && trace.durationMs <= 180_000 &&
    typeof trace.videoMimeType === 'string' &&
    !!trace.metadata &&
    typeof trace.metadata.avatarUrl === 'string' &&
    Array.isArray(trace.frames) &&
    trace.frames.length <= 6_000 &&
    trace.frames.every((frame) => typeof frame?.tMs === 'number' && frame.tMs >= 0);
}

export function saveDiagnostic(
  video: Uint8Array,
  trace: DiagnosticTrace,
  mimeType: string,
  root: string = DIAGNOSTIC_DIR,
): { id: string; path: string; relativePath: string } {
  if (!validateDiagnosticTrace(trace)) throw new Error('诊断数据格式不正确。');
  if (video.byteLength === 0 || video.byteLength > MAX_VIDEO_BYTES) throw new Error('诊断视频大小不合法。');
  const extension = mimeType.startsWith('video/webm') ? 'webm' : mimeType.startsWith('video/mp4') ? 'mp4' : null;
  if (!extension || !trace.videoMimeType.startsWith(`video/${extension}`)) throw new Error('诊断视频格式不匹配。');

  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const path = join(root, id);
  const pending = `${path}.tmp`;
  mkdirSync(root, { recursive: true });
  mkdirSync(pending);
  try {
    writeFileSync(join(pending, `comparison.${extension}`), video);
    writeFileSync(join(pending, 'trace.json'), JSON.stringify(trace));
    writeFileSync(join(pending, 'README.txt'),
      'comparison: 同步的摄像头镜像预览、关键点覆盖层和 3D 角色画面。\n' +
      'trace.json: 每个推理帧的原始身体/手部点、世界坐标、Kalidokit 输出、重定向结果、平滑结果和置信度。\n' +
      '两者使用相同的录制起点；trace.frames[].tMs 对应视频上的时间码（毫秒）。\n',
    );
    renameSync(pending, path);
  } catch (error) {
    rmSync(pending, { recursive: true, force: true });
    throw error;
  }
  return { id, path, relativePath: `data/mocap/diagnostics/${id}` };
}
