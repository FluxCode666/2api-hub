import 'server-only';
import { cookies, headers as requestHeaders } from 'next/headers';
import { redirect } from 'next/navigation';
import type { SessionUser } from '@hub/shared';
import { apiPath, ApiRequestError, readResponse } from './error';

export { ApiRequestError } from './error';

export async function serverApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const cookie = (await cookies()).toString();
  if (process.env.HUB_MOCK === '1') {
    const { mockRequest, mockSession } = await import('../mock');
    const { MockError } = await import('../mock/error');
    let body: unknown;
    if (typeof options.body === 'string') {
      try { body = JSON.parse(options.body); } catch { throw new ApiRequestError(400, 'invalid_json', '请求内容不是有效的 JSON。'); }
    }
    try { return await mockRequest(apiPath(path), options.method ?? 'GET', body, mockSession(cookie)) as T; }
    catch (error) {
      if (error instanceof MockError) throw new ApiRequestError(error.status, error.code, error.message);
      throw error;
    }
  }
  const headers = new Headers(options.headers);
  if (cookie) headers.set('Cookie', cookie);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const origin = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:8711').replace(/\/$/, '');
  const response = await fetch(`${origin}/api/v1${apiPath(path)}`, { ...options, headers, cache: options.cache ?? 'no-store' });
  return readResponse<T>(response);
}

export async function getSession(): Promise<SessionUser | null> {
  try { return await serverApi<SessionUser>('/auth/me'); }
  catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) return null;
    throw error;
  }
}

export async function requireSession(admin = false): Promise<SessionUser | null> {
  const user = await getSession();
  if (!user) {
    const headers = await requestHeaders();
    const pathname = headers.get('x-hub-pathname') ?? (admin ? '/admin' : '/merchant');
    redirect(`/login?next=${encodeURIComponent(pathname)}`);
  }
  if (admin && user.role !== 'admin') return null;
  return user;
}
