/**
 * GET  /api/motion-library   返回动作目录
 * POST /api/motion-library   保存一段录制为动作
 *
 * 只有本地工具会用到，但仍然按"不信任客户端"写：
 *   · 服务端重新校验 clip（不因为客户端验过就跳过）
 *   · id/name 严格校验，拒绝路径穿越
 *   · 生产环境默认 403，需要显式开 MOTION_LIBRARY_WRITE_ENABLED=1
 *   · 仅同源，默认只允许 localhost
 *   · 请求体大小上限，且**先看 content-length 再读体**，避免被超大请求拖死
 */
import { NextResponse } from 'next/server';
import {
  MAX_BODY_BYTES,
  checkOrigin,
  checkWriteEnabled,
  readIndex,
  saveMotion,
  withSaveLock,
  type SaveMotionRequest,
} from '@/lib/motion-library-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const index = readIndex();
    return NextResponse.json({ ok: true, clips: index.clips });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const writeGate = checkWriteEnabled();
  if (!writeGate.allowed) {
    return NextResponse.json({ ok: false, error: writeGate.reason }, { status: writeGate.status });
  }

  const originGate = checkOrigin(request.headers);
  if (!originGate.allowed) {
    return NextResponse.json({ ok: false, error: originGate.reason }, { status: originGate.status });
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: `请求体 ${(declared / 1024 / 1024).toFixed(1)}MB 超过 ${MAX_BODY_BYTES / 1024 / 1024}MB 上限` },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    const text = await request.text();
    // content-length 可能缺失或被伪造，所以读完之后再量一次
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: '请求体超过大小上限' }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `请求体不是合法 JSON：${e instanceof Error ? e.message : e}` },
      { status: 400 },
    );
  }

  const req = body as Partial<SaveMotionRequest>;
  if (!req || typeof req !== 'object') {
    return NextResponse.json({ ok: false, error: '请求体必须是对象' }, { status: 400 });
  }
  if (!req.clip) {
    return NextResponse.json({ ok: false, error: '缺少 clip' }, { status: 400 });
  }

  try {
    // 串行化：两个请求同时保存不能分到同一个编号
    const result = await withSaveLock(() =>
      saveMotion({
        requestedId: req.requestedId ?? null,
        displayName: req.displayName as string,
        note: req.note,
        clip: req.clip as SaveMotionRequest['clip'],
        capture: req.capture ?? null,
      }),
    );
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.error, issues: result.issues },
        { status: result.status },
      );
    }
    return NextResponse.json(
      { ok: true, id: result.id, entry: result.entry },
      { status: result.status },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `保存失败：${e instanceof Error ? e.message : e}` },
      { status: 500 },
    );
  }
}
