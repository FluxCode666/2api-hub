import 'server-only';
import { cache } from 'react';
import { connection } from 'next/server';
import { apiPath, ApiRequestError, readResponse } from './error';

export { ApiRequestError } from './error';

// 只缓存游客视角的数据；不读取或透传任何用户 Cookie。
const readPublic = cache(async (path: string, revalidate: number): Promise<unknown> => {
  if (process.env.HUB_MOCK === '1') {
    const { mockRequest } = await import('../mock');
    const { MockError } = await import('../mock/error');
    try { return await mockRequest(path, 'GET', undefined, null); }
    catch (error) {
      if (error instanceof MockError) throw new ApiRequestError(error.status, error.code, error.message);
      throw error;
    }
  }
  const origin = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:8711').replace(/\/$/, '');
  const response = await fetch(`${origin}/api/v1${path}`, {
    credentials: 'omit',
    next: { revalidate, tags: ['hub-public'] },
  });
  return readResponse<unknown>(response);
});

export async function publicApi<T>(path: string, revalidate = 300): Promise<T> {
  // 无 API 的镜像构建阶段跳过预渲染；运行时不设置此开关。
  if (process.env.HUB_SKIP_API_PRERENDER === '1') await connection();
  return await readPublic(apiPath(path), revalidate) as T;
}
