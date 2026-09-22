/**
 * 动作库保存的**纯规则**（无文件系统、无框架依赖）。
 *
 * 单独抽出来的原因很实际：存储层 motion-library-store.ts 要 import contracts.ts，
 * 而 contracts.ts 里有 `import boneData from './human-bones-vrm1.json'` ——
 * Node 直接加载 .ts 时 JSON import 需要 import attributes，会加载失败。
 * 把这些规则独立出来，它们就能被单元测试直接覆盖，
 * 不用起服务器、也不用碰真实的 public/clips。
 */

export const NAME_MIN = 1;
export const NAME_MAX = 40;
export const ID_MAX = 48;

/** 请求体上限。10 秒录制的原始关键点可能 5–10 MB，算上 clip 留足余量 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** 只允许小写字母、数字、连字符 */
const ID_RE = /^[a-z0-9-]+$/;

export function validateDisplayName(name: unknown): string | null {
  if (typeof name !== 'string') return 'displayName 必须是字符串';
  const t = name.trim();
  if (t.length < NAME_MIN || t.length > NAME_MAX) {
    return `displayName 长度须在 ${NAME_MIN}–${NAME_MAX} 之间（当前 ${t.length}）`;
  }
  return null;
}

/**
 * ID 校验。**拒绝路径穿越**是重点：
 * id 会直接拼进文件名，允许 `..` 或斜杠就等于允许写任意路径。
 */
export function validateRequestedId(id: unknown): string | null {
  if (id === undefined || id === null || id === '') return null;
  if (typeof id !== 'string') return 'requestedId 必须是字符串';
  if (id.length > ID_MAX) return `requestedId 最长 ${ID_MAX} 个字符（当前 ${id.length}）`;
  if (id.includes('..') || id.includes('/') || id.includes('\\')) return 'requestedId 不能包含路径字符';
  if (!ID_RE.test(id)) return 'requestedId 只允许小写字母、数字与连字符';
  return null;
}

/** 未指定 ID 时的默认名：mocap-YYYYMMDD-HHmmss */
export function defaultId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `mocap-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * 分配一个不冲突的 id。冲突时追加 -2、-3……
 *
 * `exists` 由调用方注入（判断磁盘上有没有同名文件）。
 * 注入而不是直接读文件系统，是为了让这条"同名得 -2"的规则能被纯逻辑测试覆盖 ——
 * 它是最容易在重构中悄悄坏掉的一条。
 */
export function allocateId(base: string, taken: ReadonlySet<string>, exists: (id: string) => boolean): string {
  if (!taken.has(base) && !exists(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate) && !exists(candidate)) return candidate;
  }
  throw new Error(`无法为 ${base} 找到未占用的编号（已试到 -999）`);
}

export interface AccessDecision {
  allowed: boolean;
  status: number;
  reason?: string;
}

/** 生产环境必须显式开启写入，否则一律 403 */
export function checkWriteEnabled(env: { NODE_ENV?: string; MOTION_LIBRARY_WRITE_ENABLED?: string }): AccessDecision {
  if (env.NODE_ENV !== 'production') return { allowed: true, status: 200 };
  if (env.MOTION_LIBRARY_WRITE_ENABLED === '1') return { allowed: true, status: 200 };
  return {
    allowed: false,
    status: 403,
    reason: '生产环境默认禁止写入动作库；如需写入请设置 MOTION_LIBRARY_WRITE_ENABLED=1',
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 仅同源 + 默认仅 localhost */
export function checkOrigin(
  headers: { origin?: string | null; host?: string | null },
  env: { MOTION_LIBRARY_WRITE_ENABLED?: string } = {},
): AccessDecision {
  const origin = headers.origin ?? null;
  const host = headers.host ?? '';
  const hostName = host.split(':')[0];

  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { allowed: false, status: 403, reason: 'Origin 不合法' };
    }
    if (originHost !== host) {
      return {
        allowed: false,
        status: 403,
        reason: `跨源写入被拒绝（Origin ${originHost} ≠ Host ${host}）`,
      };
    }
  }

  if (!LOCAL_HOSTS.has(hostName) && env.MOTION_LIBRARY_WRITE_ENABLED !== '1') {
    return { allowed: false, status: 403, reason: `默认只允许 localhost 写入（当前 Host ${host}）` };
  }
  return { allowed: true, status: 200 };
}
