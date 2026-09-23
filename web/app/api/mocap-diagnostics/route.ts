import { NextResponse } from 'next/server';
import { checkOrigin, checkWriteEnabled } from '@/lib/motion-library-rules';
import {
  MAX_DIAGNOSTIC_BODY_BYTES,
  MAX_TRACE_BYTES,
  MAX_VIDEO_BYTES,
  saveDiagnostic,
  validateDiagnosticTrace,
} from '@/lib/mocap/diagnostic-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const writeGate = checkWriteEnabled({
    NODE_ENV: process.env.NODE_ENV,
    MOTION_LIBRARY_WRITE_ENABLED: process.env.MOTION_LIBRARY_WRITE_ENABLED,
  });
  if (!writeGate.allowed) return NextResponse.json({ ok: false, error: writeGate.reason }, { status: writeGate.status });
  const originGate = checkOrigin(
    { origin: request.headers.get('origin'), host: request.headers.get('host') },
    { MOTION_LIBRARY_WRITE_ENABLED: process.env.MOTION_LIBRARY_WRITE_ENABLED },
  );
  if (!originGate.allowed) return NextResponse.json({ ok: false, error: originGate.reason }, { status: originGate.status });

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_DIAGNOSTIC_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: '诊断文件超过 90 MB 上限。' }, { status: 413 });
  }
  try {
    const form = await request.formData();
    const video = form.get('video');
    const data = form.get('trace');
    if (!(video instanceof File) || !(data instanceof File)) {
      return NextResponse.json({ ok: false, error: '缺少视频或逐帧数据。' }, { status: 400 });
    }
    if (video.size === 0 || video.size > MAX_VIDEO_BYTES || data.size === 0 || data.size > MAX_TRACE_BYTES ||
        video.size + data.size > MAX_DIAGNOSTIC_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: '诊断文件大小不合法。' }, { status: 413 });
    }
    let trace: unknown;
    try {
      trace = JSON.parse(await data.text());
    } catch {
      return NextResponse.json({ ok: false, error: '逐帧数据不是合法 JSON。' }, { status: 400 });
    }
    if (!validateDiagnosticTrace(trace)) {
      return NextResponse.json({ ok: false, error: '逐帧数据格式不正确。' }, { status: 400 });
    }
    const saved = saveDiagnostic(new Uint8Array(await video.arrayBuffer()), trace, video.type);
    return NextResponse.json({ ok: true, ...saved }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `诊断文件保存失败：${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }
}
