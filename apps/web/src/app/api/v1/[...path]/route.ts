import { NextRequest, NextResponse } from 'next/server';
import type { ApiError, SessionUser } from '@hub/shared';
import { mockCookieToken, mockRequest, mockSession } from '@/lib/mock';
import { MockError } from '@/lib/mock/error';

export const dynamic = 'force-dynamic';

async function proxy(request: NextRequest): Promise<Response> {
  const origin = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:8711').replace(/\/$/, '');
  const target = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, origin);
  const headers = new Headers(request.headers);
  for (const name of ['host', 'connection', 'content-length', 'transfer-encoding']) headers.delete(name);
  try {
    const upstream = await fetch(target, {
      method: request.method, headers, redirect: 'manual', cache: 'no-store',
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      signal: request.signal,
    });
    const responseHeaders = new Headers(upstream.headers);
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'connection']) responseHeaders.delete(name);
    responseHeaders.delete('set-cookie');
    for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append('set-cookie', cookie);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return NextResponse.json({ error: { code: 'upstream_unavailable', message: '暂时无法连接 API 服务，请稍后重试。' } } satisfies ApiError, { status: 502 });
  }
}

async function handler(request: NextRequest): Promise<Response> {
  if (process.env.HUB_MOCK !== '1') return proxy(request);
  try {
    let body: unknown;
    if (!['GET', 'HEAD'].includes(request.method)) {
      const text = await request.text();
      if (text) {
        try { body = JSON.parse(text); }
        catch { throw new MockError(400, 'invalid_json', '请求内容不是有效的 JSON。'); }
      }
    }
    const path = request.nextUrl.pathname.replace(/^\/api\/v1/, '');
    const data = await mockRequest(`${path}${request.nextUrl.search}`, request.method, body, mockSession(request.headers.get('cookie') ?? ''));
    if (data === undefined) throw new MockError(404, 'not_found', '没有找到该接口。');
    if (request.method === 'GET' && path.startsWith('/go/')) {
      return NextResponse.redirect((data as { url: string }).url, 302);
    }
    const response = NextResponse.json(data);
    if (request.method === 'POST' && ['/auth/login', '/auth/register'].includes(path)) {
      response.cookies.set('hub_session', mockCookieToken(data as SessionUser), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 7 });
    }
    if (request.method === 'POST' && path === '/auth/logout') {
      response.cookies.set('hub_session', '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
    }
    return response;
  } catch (error) {
    if (error instanceof MockError) return NextResponse.json({ error: { code: error.code, message: error.message } } satisfies ApiError, { status: error.status });
    return NextResponse.json({ error: { code: 'mock_error', message: '演示服务暂时不可用，请稍后重试。' } } satisfies ApiError, { status: 500 });
  }
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
export const HEAD = handler;
