import type { MetaResponse } from '@hub/shared';
import { publicApi } from '@/lib/api/public';
import { brandImage } from '@/lib/og';

export const alt = '2API Hub — 为每一次连接，找到更优解';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpenGraphImage() {
  try {
    return await brandImage(await publicApi<MetaResponse>('/meta'));
  } catch {
    return brandImage();
  }
}
