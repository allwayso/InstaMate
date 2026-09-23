/**
 * 动作库的本地存储层（**仅服务端**）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么写入要这么小心
 * ══════════════════════════════════════════════════════════════════════════
 *  这里写的是 `web/public/clips/index.json` —— **整个动作库的目录**。
 *  如果写坏了，不只是新动作丢了，而是动作库页面对所有既有动作都打不开。
 *  所以：
 *    · 先写临时文件，全部校验通过后再原子 rename
 *    · **index.json 最后替换**（它是"提交点"）
 *    · 失败时回滚本请求产生的所有文件，不留半个状态
 *    · 进程内保存锁：两个请求同时保存不能分到同一个编号
 *
 *  另外两道闸：
 *    · 生产环境必须显式设置 MOTION_LIBRARY_WRITE_ENABLED=1，否则 POST 一律 403
 *      （本地工具不该在部署环境里突然能写文件系统）
 *    · 只接受同源请求，且默认只允许 localhost
 *
 *  原始关键点写在 `data/mocap/` 而**不是** public/：
 *  体积大（单段 5–10 MB），且不需要被静态服务暴露；只经本地 API 下载。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { validateClipFile } from './contracts.ts';
import { HUMAN_BONES_VRM1 } from './contracts.ts';
import type { ClipCatalogEntry } from './clip-catalog.ts';
import type { ClipFile } from './clip-spec.ts';
import type { MocapCaptureV1 } from './mocap/mocap-types.ts';

/** Next dev/start 的 cwd 是 web/ */
const WEB_ROOT = process.cwd();
const REPO_ROOT = resolve(WEB_ROOT, '..');

export const CLIPS_DIR = join(WEB_ROOT, 'public', 'clips');
export const INDEX_PATH = join(CLIPS_DIR, 'index.json');
export const MOCAP_DIR = join(REPO_ROOT, 'data', 'mocap');

// 请求体上限、名称/ID 校验、默认 ID、编号分配、访问控制这些都搬到了
// web/lib/motion-library-rules.ts（纯规则、无 fs、可被 Node 直接单测）。
// 这里 re-export，保持调用方不用改。
export interface SaveMotionRequest {
  requestedId?: string | null;
  displayName: string;
  note?: string;
  clip: ClipFile;
  capture: MocapCaptureV1 | null;
}

export interface SaveMotionResult {
  ok: boolean;
  status: number;
  id?: string;
  entry?: ClipCatalogEntry;
  issues?: { level: string; rule: string; msg: string }[];
  error?: string;
}

export {
  NAME_MIN,
  NAME_MAX,
  ID_MAX,
  MAX_BODY_BYTES,
  validateDisplayName,
  validateRequestedId,
  defaultId,
} from './motion-library-rules.ts';
export type { AccessDecision } from './motion-library-rules.ts';
import type { AccessDecision } from './motion-library-rules.ts';
import {
  MAX_BODY_BYTES,
  validateDisplayName,
  validateRequestedId,
  defaultId,
  allocateId as allocateIdPure,
  checkWriteEnabled as checkWriteEnabledPure,
  checkOrigin as checkOriginPure,
} from './motion-library-rules.ts';

/** 包装：把"磁盘上有没有同名文件"注入给纯函数 */
function allocateId(base: string, taken: ReadonlySet<string>): string {
  return allocateIdPure(base, taken, (id) => existsSync(join(CLIPS_DIR, `${id}.json`)));
}

/** 包装：读 process.env（纯规则函数由测试直接覆盖） */
export function checkWriteEnabled(): AccessDecision {
  return checkWriteEnabledPure({
    NODE_ENV: process.env.NODE_ENV,
    MOTION_LIBRARY_WRITE_ENABLED: process.env.MOTION_LIBRARY_WRITE_ENABLED,
  });
}

/** 包装：把 Headers 拆成纯函数要的形状 */
export function checkOrigin(headers: Headers) {
  return checkOriginPure(
    { origin: headers.get('origin'), host: headers.get('host') },
    { MOTION_LIBRARY_WRITE_ENABLED: process.env.MOTION_LIBRARY_WRITE_ENABLED },
  );
}

// ── 目录读写 ─────────────────────────────────────────────────────────────

export function readIndex(): { clips: ClipCatalogEntry[] } {
  if (!existsSync(INDEX_PATH)) return { clips: [] };
  try {
    const data = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as { clips?: ClipCatalogEntry[] };
    return { clips: Array.isArray(data.clips) ? data.clips : [] };
  } catch {
    // 目录坏了不能当成"空目录"静默继续 —— 那会把整个动作库覆盖掉
    throw new Error(`动作目录 ${INDEX_PATH} 不是合法 JSON，已中止以免覆盖`);
  }
}

// ── 原子写入 + 回滚 ──────────────────────────────────────────────────────

interface PendingWrite {
  tmp: string;
  final: string;
}

function atomicWrite(finalPath: string, content: string): PendingWrite {
  mkdirSync(join(finalPath, '..'), { recursive: true });
  const tmp = `${finalPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, content, 'utf8');
  return { tmp, final: finalPath };
}

// ── 进程内保存锁 ─────────────────────────────────────────────────────────

let queue: Promise<unknown> = Promise.resolve();

/** 串行化保存请求：否则两个请求可能分到同一个编号，后写的覆盖先写的 */
export function withSaveLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = queue.then(fn, fn);
  // 锁本身不能因为某次失败而卡死
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── 主流程 ───────────────────────────────────────────────────────────────

export function saveMotion(req: SaveMotionRequest): SaveMotionResult {
  const nameErr = validateDisplayName(req.displayName);
  if (nameErr) return { ok: false, status: 400, error: nameErr };
  const idErr = validateRequestedId(req.requestedId);
  if (idErr) return { ok: false, status: 400, error: idErr };

  // 服务端**重新校验** clip —— 绝不信任客户端已经验过
  const v = validateClipFile(req.clip, HUMAN_BONES_VRM1);
  if (!v.ok) {
    return {
      ok: false,
      status: 400,
      error: 'clip 未通过服务端校验',
      issues: v.issues.map((i) => ({ level: i.level, rule: i.rule, msg: i.msg })),
    };
  }

  let index: { clips: ClipCatalogEntry[] };
  try {
    index = readIndex();
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }

  const taken = new Set(index.clips.map((c) => c.id));
  const base = (req.requestedId && req.requestedId.trim()) || defaultId();
  let id: string;
  try {
    id = allocateId(base, taken);
  } catch (e) {
    return { ok: false, status: 409, error: e instanceof Error ? e.message : String(e) };
  }

  const createdAt = new Date().toISOString();
  const clipOut: ClipFile = { ...req.clip, name: id };
  const captureOut: MocapCaptureV1 | null = req.capture ? { ...req.capture, id, createdAt } : null;

  const entry: ClipCatalogEntry = {
    id,
    name: req.displayName.trim(),
    url: `/clips/${id}.json`,
    source: 'mocap',
    note: req.note ?? '',
    fps: clipOut.fps,
    duration: clipOut.duration,
    frameCount: clipOut.frameCount,
    mask: [...clipOut.mask],
    createdAt,
    captureId: captureOut ? id : null,
    trackingValidRatio: req.capture?.quality.validFrameRatio,
    inferenceFpsMean: req.capture?.quality.inferenceFpsMean,
    longestTrackingGapMs: req.capture?.quality.longestTrackingGapMs,
    qualityWarnings: req.capture?.quality.warnings ?? [],
  };

  // 写入顺序：全部先写临时文件，最后才动 index.json（提交点）
  const pending: PendingWrite[] = [];
  const created: string[] = [];

  try {
    const clipWrite = atomicWrite(join(CLIPS_DIR, `${id}.json`), JSON.stringify(clipOut));
    pending.push(clipWrite);
    created.push(clipWrite.final);

    if (captureOut) {
      const lmWrite = atomicWrite(join(MOCAP_DIR, `${id}.landmarks.json`), JSON.stringify(captureOut));
      pending.push(lmWrite);
      created.push(lmWrite.final);
    }

    const nextIndex = { ...index, clips: [...index.clips, entry] };
    const idxWrite = atomicWrite(INDEX_PATH, JSON.stringify(nextIndex, null, 2));
    pending.push(idxWrite); // 最后一个 push = 最后 rename

    for (const w of pending) {
      renameSync(w.tmp, w.final);
    }
    return { ok: true, status: 201, id, entry };
  } catch (e) {
    // 回滚本请求产生的所有文件（含临时文件与已 rename 的正式文件）
    for (const w of pending) {
      try {
        if (existsSync(w.tmp)) rmSync(w.tmp, { force: true });
      } catch {
        /* 清理失败不覆盖原始错误 */
      }
    }
    for (const f of created) {
      try {
        if (existsSync(f)) rmSync(f, { force: true });
      } catch {
        /* 同上 */
      }
    }
    return { ok: false, status: 500, error: `写入失败且已回滚：${e instanceof Error ? e.message : e}` };
  }
}

// ── 删除 ───────────────────────────────────────────────────────────────────

export interface DeleteMotionResult {
  ok: boolean;
  status: number;
  error?: string;
  /** 实际删掉的文件路径（供 UI/测试报告"到底动了什么"） */
  removed?: string[];
  /** 目录已经提交、但这些文件没能删掉（只是留了孤儿文件，不影响可用性） */
  failed?: string[];
}

/**
 * 从动作库里删掉一条。
 *
 * ★ 顺序与 saveMotion **相反**：先原子写 index.json（提交点），再删文件。
 *
 *   反过来（先删文件、后写目录）的失败模式很坏：目录写失败时文件已经没了，
 *   于是留下「目录里有、文件不存在」的条目 —— 动作库页面对该条**打不开**，
 *   而且从界面上看不出原因。
 *
 *   按当前顺序，最坏情况是「目录里没了、文件还在」= 孤儿文件：
 *   不影响任何功能，只是占几百 KB 磁盘，而且随时可以再删一次。
 *   **删不掉文件比删掉了却还挂在目录里安全得多。**
 *
 * 同时删除原始关键点（data/mocap/*.landmarks.json）：一段 5–10 MB，
 * 留着没有用途（clip 已经烘好了）。要保留原始点的话这里就是唯一的改动点。
 */
export function deleteMotion(id: string): DeleteMotionResult {
  const idErr = validateRequestedId(id);
  if (idErr || !id) return { ok: false, status: 400, error: idErr ?? 'id 不合法' };

  let index: { clips: ClipCatalogEntry[] };
  try {
    index = readIndex();
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }

  if (!index.clips.some((c) => c.id === id)) {
    return { ok: false, status: 404, error: `动作库里没有 ${id}` };
  }

  // ── 提交点：目录先落地 ──
  const nextIndex = { ...index, clips: index.clips.filter((c) => c.id !== id) };
  const idxWrite = atomicWrite(INDEX_PATH, JSON.stringify(nextIndex, null, 2));
  try {
    renameSync(idxWrite.tmp, idxWrite.final);
  } catch (e) {
    try {
      if (existsSync(idxWrite.tmp)) rmSync(idxWrite.tmp, { force: true });
    } catch {
      /* 清理失败不覆盖原始错误 */
    }
    return {
      ok: false,
      status: 500,
      error: `目录写入失败，未删除任何文件：${e instanceof Error ? e.message : e}`,
    };
  }

  // ── 提交点已过。下面失败只是孤儿文件，不回滚目录 ──
  const removed: string[] = [];
  const failed: string[] = [];
  for (const p of [join(CLIPS_DIR, `${id}.json`), join(MOCAP_DIR, `${id}.landmarks.json`)]) {
    try {
      if (!existsSync(p)) continue;
      rmSync(p, { force: true });
      removed.push(p);
    } catch {
      failed.push(p);
    }
  }

  return { ok: true, status: 200, removed, failed };
}

export function readLandmarks(id: string): MocapCaptureV1 | null {
  if (validateRequestedId(id) !== null || !id) return null;
  const p = join(MOCAP_DIR, `${id}.landmarks.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as MocapCaptureV1;
  } catch {
    return null;
  }
}

export function landmarksExist(id: string): boolean {
  if (!id || validateRequestedId(id) !== null) return false;
  return existsSync(join(MOCAP_DIR, `${id}.landmarks.json`));
}
