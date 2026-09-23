/**
 * GET /api/avatars — 列出可选的 VRM 资产。
 *
 * 存在的理由：让"换角色"变成把 .vrm 丢进 public/avatars 就完事，
 * 而不是改常量重新构建。产物来自 tools/gltf-to-vrm.mjs（第三方 GLB 转换）
 * 或 tools/fetch-assets.mjs（内置样例）。
 *
 * 查询参数：
 *   ?include=/avatars/x.vrm  额外补齐的 URL（保证 ?avatar= 指定的项能被选中）
 */
import { NextResponse } from 'next/server';

import { buildAvatarCatalog, defaultPublicDir } from '@/lib/avatar-catalog';

export const dynamic = 'force-dynamic'; // 目录内容会变，不能被静态化

export async function GET(request: Request) {
  const include = new URL(request.url).searchParams
    .getAll('include')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8); // 防滥用

  try {
    const assets = buildAvatarCatalog(defaultPublicDir(), { include });
    return NextResponse.json({ assets }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    // 列目录失败不该让页面挂掉 —— 返回空列表，UI 会退回默认资产
    return NextResponse.json(
      { assets: [], error: err instanceof Error ? err.message : String(err) },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }
}
