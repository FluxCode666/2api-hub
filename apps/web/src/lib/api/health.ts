import 'server-only';
import { cache } from 'react';
import { unstable_rethrow } from 'next/navigation';
import type { HealthResponse } from '@hub/shared';
import { publicApi } from './public';

// 公开版本与会话无关；五分钟缓存，健康接口故障时不影响页面可用。
export const getPublicVersion = cache(async (): Promise<string | null> => {
  try {
    const health = await publicApi<HealthResponse>('/healthz', 300);
    return health?.ok && typeof health.version === 'string' ? health.version : null;
  } catch (cause) { unstable_rethrow(cause); return null; }
});
