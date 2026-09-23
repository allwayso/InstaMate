/**
 * GET /api/motion-library/[id]/landmarks
 *
 * 下载某个动作的**原始关键点**。
 *
 * 为什么要走 API 而不是放 public/：
 *   · 体积大（单段 5–10 MB），静态暴露没意义还容易被爬
 *   · `data/mocap/` 不进 git，所以新克隆后这里会 404 —— 这是预期行为，
 *     页面上的「原始点」按钮会据此置灰并提示"本机没有"，
 *     而不是让人以为下载坏了
 */
import { NextResponse } from 'next/server';
import { readLandmarks, validateRequestedId } from '@/lib/motion-library-store';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  // 防路径穿越：id 会被拼进文件路径
  const bad = validateRequestedId(id);
  if (bad || !id) {
    return NextResponse.json({ ok: false, error: bad ?? 'id 不合法' }, { status: 400 });
  }

  const capture = readLandmarks(id);
  if (!capture) {
    return NextResponse.json(
      {
        ok: false,
        error: `本机没有 ${id} 的原始关键点。原始关键点写在 data/mocap/ 且不进 git，新克隆后需要重新录制。`,
      },
      { status: 404 },
    );
  }

  return new NextResponse(JSON.stringify(capture), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${id}.landmarks.json"`,
    },
  });
}
