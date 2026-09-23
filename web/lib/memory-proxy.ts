import { NextResponse } from 'next/server';

export async function forwardMemory(path: string, init?: RequestInit): Promise<NextResponse> {
  const base = process.env.MEMORY_API_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:8000';
  try {
    const response = await fetch(base + path, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(90_000),
    });
    const data = await response.json().catch(() => ({ detail: '分析服务响应无效' }));
    return NextResponse.json(
      response.ok ? data : { error: data.detail ?? data.error ?? '分析服务失败' },
      { status: response.status, headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { error: '记忆服务不可用，请先启动 memory/ 中的 Python 服务' },
      { status: 503 },
    );
  }
}
