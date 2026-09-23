/**
 * 动作目录（web/public/clips/index.json）的合并规则。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  为什么这是一个需要单独成文件、单独测的规则
 * ══════════════════════════════════════════════════════════════════════════
 *  这个文件同时被两方写：
 *    · tools/gen-clips.mjs      程序化动作生成器（source: 'generated'）
 *    · G2 的保存 API            录入真人动作（source: 'mocap'）
 *
 *  早期实现是整体重写，于是「录完动作再跑一次 gen:clips」会把录的动作从目录里抹掉 ——
 *  文件还在磁盘上，但从目录里消失了，看起来像"动作丢了"。
 *  实测复现过：塞一条 source:'mocap' 的条目，跑一次生成器就没了。
 *
 *  所以规则是：**生成器只拥有 source === 'generated' 的那一部分**，
 *  其它来源原样保留；目录里与生成器无关的字段也一律不动
 *  （将来加版本号、统计之类的字段时不会被无声抹掉）。
 *
 *  做成纯函数是为了能被单测直接覆盖 —— 这条规则坏掉的表现太隐蔽了。
 */

export interface CatalogFileLike {
  clips?: unknown[];
  [key: string]: unknown;
}

/** 哪些条目属于生成器 */
export function isGeneratedEntry(entry: unknown): boolean {
  return !!entry && typeof entry === 'object' && (entry as { source?: unknown }).source === 'generated';
}

/** 取出现有目录里**不属于生成器**的条目（mocap / imported / 无 source 的旧数据） */
export function preserveNonGenerated(existing: CatalogFileLike | null | undefined): unknown[] {
  const clips = existing?.clips;
  if (!Array.isArray(clips)) return [];
  return clips.filter((c) => !isGeneratedEntry(c));
}

/**
 * 合并：生成器的新条目在前，保留的条目在后；顶层其它字段一律保留。
 *
 * 注意 `existing` 为 null（文件不存在或内容不是对象）时按空目录处理 ——
 * 调用方负责在 JSON 解析失败时提前中止，不要把坏文件当成空目录。
 */
export function mergeCatalog(
  existing: CatalogFileLike | null | undefined,
  generated: readonly unknown[],
): CatalogFileLike {
  const preserved = preserveNonGenerated(existing);
  return {
    ...(existing && typeof existing === 'object' ? existing : {}),
    clips: [...generated, ...preserved],
  };
}
