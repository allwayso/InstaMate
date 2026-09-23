/**
 * DELETE /api/motion-library/[id]   从动作库里删掉一条
 *
 * 和 POST 一样按"不信任客户端"处理 —— **删除也是写操作**，所以要走同一套闸：
 *   · 生产环境默认 403（需显式开 MOTION_LIBRARY_WRITE_ENABLED=1）
 *   · 仅同源，默认只允许 localhost
 *   · id 严格校验，拒绝路径穿越（它会被拼进文件路径）
 *
 * 另外**借用保存锁**串行化：删除要改的就是 index.json，
 * 和保存是同一份文件、同一类冲突 —— 两个请求同时读写会出现
 * "刚存的动作被删请求基于旧目录覆盖回去"这种丢数据。
 */
import { NextResponse } from 'next/server';

import {
  checkOrigin,
  checkWriteEnabled,
  deleteMotion,
  validateRequestedId,
  withSaveLock,
} from '@/lib/motion-library-store';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const writeGate = checkWriteEnabled();
  if (!writeGate.allowed) {
    return NextResponse.json({ ok: false, error: writeGate.reason }, { status: writeGate.status });
  }

  const originGate = checkOrigin(request.headers);
  if (!originGate.allowed) {
    return NextResponse.json({ ok: false, error: originGate.reason }, { status: originGate.status });
  }

  const { id } = await ctx.params;

  // 防路径穿越：id 会被拼进文件路径。这一步在进锁之前做，非法请求不占用串行队列。
  const bad = validateRequestedId(id);
  if (bad || !id) {
    return NextResponse.json({ ok: false, error: bad ?? 'id 不合法' }, { status: 400 });
  }

  try {
    const result = await withSaveLock(() => deleteMotion(id));
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({
      ok: true,
      id,
      removed: result.removed ?? [],
      // 目录已提交但这些文件没删掉（孤儿文件，不影响可用性）—— 如实报出来
      failed: result.failed ?? [],
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `删除失败：${e instanceof Error ? e.message : e}` },
      { status: 500 },
    );
  }
}
