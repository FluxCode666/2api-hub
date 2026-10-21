import { apiPath, readResponse } from './error';

export { ApiRequestError } from './error';

export async function apiWithHeaders<T>(path: string, options: RequestInit = {}): Promise<{data: T; headers: Headers}> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  try {
    const response = await fetch(`/api/v1${apiPath(path)}`, { credentials: 'same-origin', ...options, headers });
    return {data: await readResponse<T>(response), headers: response.headers};
  } catch (error) {
    if (error instanceof TypeError) throw new Error('暂时无法连接服务，请稍后重试。');
    throw error;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  return (await apiWithHeaders<T>(path, options)).data;
}

export function apiNoticeMessage(headers: Headers): string | null {
  return headers.get('X-Hub-Notice')?.startsWith('rate_limited:')
    ? '配置已保存，但今日自动检测额度已用完，本次未重新检测。'
    : null;
}
