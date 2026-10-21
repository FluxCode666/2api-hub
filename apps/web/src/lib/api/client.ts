import { apiPath, readResponse } from './error';

export { ApiRequestError } from './error';

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  try {
    const response = await fetch(`/api/v1${apiPath(path)}`, { credentials: 'same-origin', ...options, headers });
    return await readResponse<T>(response);
  } catch (error) {
    if (error instanceof TypeError) throw new Error('暂时无法连接服务，请稍后重试。');
    throw error;
  }
}
