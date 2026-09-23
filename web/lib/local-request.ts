import { NextResponse } from 'next/server';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function sameLocalOrigin(origin: URL, requestUrl: URL): boolean {
  return LOCAL_HOSTS.has(origin.hostname) &&
    LOCAL_HOSTS.has(requestUrl.hostname) &&
    origin.port === requestUrl.port;
}

/** Local tools can read conversations and write files, so reject remote/cross-origin requests. */
export function localRequestOnly(request: Request): NextResponse | null {
  const url = new URL(request.url);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    return NextResponse.json({ error: '接口仅供本机使用' }, { status: 403 });
  }
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host !== url.host && !sameLocalOrigin(originUrl, url)) {
        return NextResponse.json({ error: '跨源请求被拒绝' }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: 'Origin 不合法' }, { status: 403 });
    }
  }
  return null;
}
