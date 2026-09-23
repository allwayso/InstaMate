import { NextResponse } from 'next/server';
import { listStates } from '@/lib/states-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_MESSAGE_LENGTH = 20_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function localRequestOnly(request: Request): NextResponse | null {
  const host = new URL(request.url).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    return NextResponse.json({ error: '对话接口仅供本机使用' }, { status: 403 });
  }
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) {
        return NextResponse.json({ error: '跨源请求被拒绝' }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: 'Origin 不合法' }, { status: 403 });
    }
  }
  return null;
}

function backendUrl(path: string): string {
  const base = process.env.MEMORY_API_URL?.replace(/\/+$/, '') || 'http://127.0.0.1:8000';
  return `${base}${path}`;
}

async function forward(path: string, init?: RequestInit): Promise<NextResponse> {
  try {
    const response = await fetch(backendUrl(path), {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(90_000),
    });
    const body = await response.json().catch(() => ({
      error: response.ok
        ? '对话服务返回的数据格式有误'
        : `对话服务处理失败（HTTP ${response.status}），请检查 Python 服务日志`,
    }));
    if (!response.ok && body && typeof body === 'object') {
      const detail = 'detail' in body ? body.detail : null;
      const error = 'error' in body ? body.error : null;
      return NextResponse.json({ error: typeof error === 'string' ? error :
        typeof detail === 'string' ? detail : `对话服务处理失败（HTTP ${response.status}）` }, {
        status: response.status,
        headers: { 'cache-control': 'no-store' },
      });
    }
    return NextResponse.json(body, {
      status: response.status,
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json(
      { error: '对话服务不可用，请先启动 memory/ 中的 Python 服务' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}

export async function GET(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  const sessionId = new URL(request.url).searchParams.get('session_id') ?? '';
  if (!SESSION_RE.test(sessionId)) {
    return NextResponse.json({ error: 'session_id 不合法' }, { status: 400 });
  }
  return forward(`/api/chat/${encodeURIComponent(sessionId)}`);
}

export async function POST(request: Request) {
  const gate = localRequestOnly(request);
  if (gate) return gate;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是 JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: '请求体必须是对象' }, { status: 400 });
  }
  const { session_id, message, profile_id } = body as Record<string, unknown>;
  if (typeof session_id !== 'string' || !SESSION_RE.test(session_id)) {
    return NextResponse.json({ error: 'session_id 不合法' }, { status: 400 });
  }
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: `message 须为 1–${MAX_MESSAGE_LENGTH} 个字符` }, { status: 400 });
  }
  if (profile_id != null && profile_id !== '' &&
      (typeof profile_id !== 'string' || !/^[0-9a-f]{32}$/.test(profile_id))) {
    return NextResponse.json({ error: 'profile_id 不合法' }, { status: 400 });
  }
  const states = await listStates().catch(() => []);
  return forward('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id,
      message,
      profile_id: profile_id || null,
      states: states.slice(0, 100).map(({ id, name, trigger_words, emotion, duration, loop, clip_id }) =>
        ({ id, name, trigger_words, emotion, duration, loop, clip_id })),
    }),
  });
}
