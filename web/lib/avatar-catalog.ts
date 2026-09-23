/**
 * 资产目录：扫描 `public/avatars/*.vrm` 并读出每个角色的摘要。
 *
 * 为什么需要它：
 *   此前资产 URL 是**写死的常量**（display-case 的 DEFAULT_AVATAR、
 *   motion-library 的 DEFAULT/SECOND），换一个模型就要改代码重新构建。
 *   接入第三方模型（tools/gltf-to-vrm.mjs 的产物）后，"把文件丢进目录就能选"
 *   才让资产迭代变成零成本操作。
 *
 * 这个文件是**服务端/Node 侧**的（用 fs）。客户端只通过 /api/avatars 拿 JSON，
 * 所以不要把它 import 进组件 —— 客户端用 `use-avatars.ts`。
 *
 * 设计取舍：
 *   - 摘要从 VRM 的 JSON chunk 里读，**不加载整份文件**（只在需要时读头部）。
 *     但 GLB 的 JSON chunk 长度不固定，所以还是读了整份 —— 16 MB 读进内存一次
 *     在本地演示场景可接受，换来的是"下拉里显示的是角色名而不是文件名"。
 *   - 任何解析失败都**不抛错**，降级为 null（一个坏文件不该让整个下拉空掉）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface AvatarEntry {
  /** 供 <img>/加载器使用的 URL，以 / 开头 */
  url: string;
  /** 文件名 */
  file: string;
  bytes: number;
  /** VRM meta.name；读不出来是 null */
  name: string | null;
  /** humanoid 骨骼数；读不出来是 null */
  boneCount: number | null;
  /** VRMC_vrm.specVersion；读不出来是 null */
  specVersion: string | null;
}

/** 目录读不到时的兜底（生产环境 public/ 不保证可读时仍能选到内置资产）。 */
export const FALLBACK_AVATARS: readonly string[] = [
  '/avatars/sample.vrm',
  '/avatars/compat.vrm',
];

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'

/**
 * 从 GLB/VRM 二进制里读出摘要。
 * 只做最小解析：魔数 → 找 JSON chunk → 取 VRMC_vrm 的 meta.name / humanoid / specVersion。
 * 失败返回 null（**不抛错**：一个坏文件不该让整个列表挂掉）。
 */
export function summarizeVrm(buf: Uint8Array): {
  name: string | null;
  boneCount: number | null;
  specVersion: string | null;
} | null {
  try {
    if (buf.length < 20) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint32(0, true) !== GLB_MAGIC) return null;

    const total = dv.getUint32(8, true);
    let off = 12;
    let json = null;
    while (off + 8 <= Math.min(total, buf.length)) {
      const len = dv.getUint32(off, true);
      const type = dv.getUint32(off + 4, true);
      if (type === CHUNK_JSON) {
        const text = new TextDecoder().decode(buf.subarray(off + 8, off + 8 + len));
        json = JSON.parse(text);
        break;
      }
      off += 8 + len;
    }
    if (!json) return null;

    const vrm = json.extensions?.VRMC_vrm;
    if (!vrm) return null;

    return {
      name: typeof vrm.meta?.name === 'string' ? vrm.meta.name : null,
      boneCount: vrm.humanoid?.humanBones ? Object.keys(vrm.humanoid.humanBones).length : null,
      specVersion: typeof vrm.specVersion === 'string' ? vrm.specVersion : null,
    };
  } catch {
    return null;
  }
}

/** 列出目录下的文件名（只认 .vrm，忽略大小写）。不递归。 */
export function listVrmFiles(dir: string): { file: string; bytes: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // 目录不存在（干净克隆还没跑 fetch-assets）→ 交给上层兜底
  }

  const out: { file: string; bytes: number }[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.vrm')) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      out.push({ file: name, bytes: st.size });
    } catch {
      // 竞态删除之类，跳过即可
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * 组装资产列表。
 *
 * @param publicDir public 目录的绝对路径（调用方给，便于测试注入临时目录）
 * @param opts.include 额外要补齐的 URL（例如 ?avatar= 指定的、不在目录里的资产）
 */
export function buildAvatarCatalog(
  publicDir: string,
  opts: { include?: string[]; urlPrefix?: string } = {},
): AvatarEntry[] {
  const prefix = opts.urlPrefix ?? '/avatars';
  const dir = join(publicDir, prefix.replace(/^\//, ''));
  const files = listVrmFiles(dir);

  const entries: AvatarEntry[] = files.map(({ file, bytes }) => {
    let summary: ReturnType<typeof summarizeVrm> = null;
    try {
      summary = summarizeVrm(readFileSync(join(dir, file)));
    } catch {
      summary = null;
    }
    return {
      url: `${prefix}/${file}`,
      file,
      bytes,
      name: summary?.name ?? null,
      boneCount: summary?.boneCount ?? null,
      specVersion: summary?.specVersion ?? null,
    };
  });

  const seen = new Set(entries.map((e) => e.url));

  // 目录为空（干净克隆）→ 用兜底列表，至少内置资产能选
  if (entries.length === 0) {
    for (const url of FALLBACK_AVATARS) {
      if (seen.has(url)) continue;
      seen.add(url);
      entries.push({ url, file: url.split('/').pop() ?? url, bytes: 0, name: null, boneCount: null, specVersion: null });
    }
  }

  // 补齐调用方点名的、但不在目录里的资产（保证 ?avatar= 指向的项能被选中）
  for (const url of opts.include ?? []) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    entries.push({ url, file: url.split('/').pop() ?? url, bytes: 0, name: null, boneCount: null, specVersion: null });
  }

  return entries;
}

/** `public/` 在 Next dev/start 下就是 process.cwd()/public。 */
export function defaultPublicDir(cwd: string = process.cwd()): string {
  return resolve(cwd, 'public');
}
