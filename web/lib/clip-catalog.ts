/**
 * 动作目录 —— 单独保存 ID、名称、URL 与来源标记；clip 本体保持 clip-spec 的字段不变。
 *
 * 内置动作由 tools/gen-clips.mjs 生成并写入 web/public/clips/index.json；
 * 未来真人动捕动作只需往目录里加一条（source: 'mocap'），播放器无需改动。
 * 导入的同名动作**不静默覆盖**内置动作。
 */
import { normalizeClipQuaternions, type ClipFile, type ValidationIssue } from './clip-spec';
import { validateClipFile } from './contracts';

export type ClipSource = 'generated' | 'mocap' | 'imported';

export interface ClipCatalogEntry {
  id: string;
  name: string;
  url: string;
  source: ClipSource;
  note?: string;
  fps: number;
  duration: number;
  frameCount: number;
  mask: string[];
  /** 仅会话内有效的导入动作 */
  sessionOnly?: boolean;
}

export interface CatalogFile {
  clips: ClipCatalogEntry[];
}

export interface LoadClipResult {
  ok: boolean;
  clip: ClipFile | null;
  issues: ValidationIssue[];
  entry: ClipCatalogEntry | null;
}

/** 读取内置动作目录（/clips/index.json） */
export async function fetchCatalog(): Promise<ClipCatalogEntry[]> {
  const res = await fetch('/clips/index.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`动作目录读取失败：HTTP ${res.status} /clips/index.json`);
  const data = (await res.json()) as CatalogFile;
  return (data.clips ?? []).map((c) => ({ ...c, source: c.source ?? 'generated' }));
}

/**
 * 读取并校验一个 clip。
 * - 先做格式校验（与 CLI 同一套规则），再做目标骨骼检查；
 * - 任一不过就返回 issues，调用方**保留原动作/姿态**，不做部分应用；
 * - 加载时只对允许范围内的模长误差做规范化，**不改动原文件**。
 */
export async function loadClipFile(
  url: string,
  opts: { targetBones?: readonly string[] | null; expectedId?: string } = {},
): Promise<LoadClipResult> {
  const { targetBones = null, expectedId } = opts;
  let raw: unknown;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (e) {
    return {
      ok: false,
      clip: null,
      entry: null,
      issues: [{ level: 'ERROR', rule: 'R0 读取', msg: `${url} 读取失败：${e instanceof Error ? e.message : String(e)}` }],
    };
  }

  const { clip: normalized } = normalizeClipQuaternions(raw as ClipFile);
  const result = validateClipFile(normalized, targetBones);

  if (!result.ok || !normalized) {
    return { ok: false, clip: null, entry: null, issues: result.issues };
  }

  const entry: ClipCatalogEntry = {
    id: expectedId ?? normalized.name,
    name: normalized.name,
    url,
    source: expectedId ? 'generated' : 'imported',
    fps: normalized.fps,
    duration: normalized.duration,
    frameCount: normalized.frameCount,
    mask: normalized.mask,
  };
  return { ok: true, clip: normalized, entry, issues: result.issues };
}

/**
 * 从本地文件导入动作。同名（id 与内置重复）时返回错误，**不静默覆盖**。
 */
export async function importClipFromFile(
  file: File,
  existing: readonly ClipCatalogEntry[],
  targetBones?: readonly string[] | null,
): Promise<LoadClipResult> {
  const text = await file.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      clip: null,
      entry: null,
      issues: [{ level: 'ERROR', rule: 'R0 解析', msg: `${file.name} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}` }],
    };
  }

  const { clip: normalized } = normalizeClipQuaternions(raw as ClipFile);
  const result = validateClipFile(normalized, targetBones);
  if (!result.ok) return { ok: false, clip: null, entry: null, issues: result.issues };

  const id = String((raw as ClipFile).name ?? '');
  if (existing.some((c) => c.id === id && c.source !== 'imported')) {
    return {
      ok: false,
      clip: null,
      entry: null,
      issues: [
        {
          level: 'ERROR',
          rule: 'R14 重名',
          msg: `动作 id "${id}" 与内置动作重名，拒绝导入以免静默覆盖。请改用别的 name 后重试。`,
        },
      ],
    };
  }

  return {
    ok: true,
    clip: normalized,
    issues: result.issues,
    entry: {
      id,
      name: `(导入) ${id}`,
      url: `file:${file.name}`,
      source: 'imported',
      sessionOnly: true,
      note: `由 ${file.name} 导入，仅当前会话有效`,
      fps: normalized.fps,
      duration: normalized.duration,
      frameCount: normalized.frameCount,
      mask: normalized.mask,
    },
  };
}
