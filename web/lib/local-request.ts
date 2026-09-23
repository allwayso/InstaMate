import { NextResponse } from 'next/server';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Local tools can read conversations and write files, so reject remote/cross-origin requests. */
export function localRequestOnly(request: Request): NextResponse | null {
  const url = new URL(request.url);
  // Next.js may build request.url from its configured hostname rather than the
  // hostname the browser used. The Host header is the browser-visible authority.
  const receivedHost = request.headers.get('host') ?? url.host;
  let host: URL;
  try {
    host = new URL(`${url.protocol}//${receivedHost}`);
  } catch {
    return NextResponse.json({ error: 'Host 不合法' }, { status: 403 });
  }
  if (host.host.toLowerCase() !== receivedHost.toLowerCase() ||
      !LOCAL_HOSTS.has(host.hostname) || !LOCAL_HOSTS.has(url.hostname)) {
    return NextResponse.json({ error: '接口仅供本机使用' }, { status: 403 });
  }
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== host.host) {
        return NextResponse.json({ error: '跨源请求被拒绝' }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: 'Origin 不合法' }, { status: 403 });
    }
  }
  return null;
}
