/**
 * 把"目标资产缺的骨骼"分类。
 *
 * ★ 这条规则直接决定**第三方模型能不能接**，所以单独成文件、可被 Node 直接单测
 *   （character-runtime.ts 不能被 Node 加载：它 import three / @pixiv/three-vrm，
 *    还有无扩展名的相对导入和 JSON 导入）。
 *
 * 两种"没有"必须分开：
 *   · `unknown` —— 名字**不在 VRM 1.0 规范的 55 根里**。
 *     说明文件本身有问题（写错名、或者 rigProfile 不是 VRM）→ **整体拒绝写入**。
 *   · `missing` —— 名字合法，但这具模型**天然没有这根骨骼**
 *     （Seed-san 没有 upperChest/jaw/眼球骨；第三方模型常常没有手指）。
 *     这是正常情况 → 写能写的部分并如实报告。
 *
 * 早期实现把两者混为一谈、一律整体拒绝，结果是：接一具缺手指的模型时，
 * 一条含手指的 clip 会让**整个角色一动不动**（而不是"只有手指不动"）。
 * 那是设计缺陷，不是模型的错。
 *
 * `specBones` 是**必传参数**（不给默认值）：规范骨骼表的唯一真相源是
 * `web/lib/human-bones-vrm1.json`，本文件刻意不 import 它，以免把 JSON 依赖
 * 带进来、让 Node 侧加载不了。
 */

export interface BoneClassification {
  /** 可以安全写入（没有任何非法骨骼名） */
  ok: boolean;
  /** 合法但本模型没有的骨骼 */
  missing: string[];
  /** 不在 VRM 1.0 规范里的骨骼名（文件有问题） */
  unknown: string[];
}

export function classifyBones(
  names: readonly string[],
  modelBones: ReadonlySet<string>,
  specBones: readonly string[],
): BoneClassification {
  const spec = new Set(specBones);
  const missing: string[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    if (modelBones.has(n)) continue;
    if (spec.has(n)) missing.push(n);
    else unknown.push(n);
  }
  return { ok: unknown.length === 0, missing, unknown };
}
