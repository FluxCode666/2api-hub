import type { SiteDetail } from '@hub/shared';
import { publicApi } from '@/lib/api/public';
import { brandImage, siteImage } from '@/lib/og';

export const alt = '2API Hub 站点档案 — 渠道、可用率与用户评价';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    return await siteImage(await publicApi<SiteDetail>(`/sites/${encodeURIComponent(slug)}`));
  } catch {
    return brandImage();
  }
}
