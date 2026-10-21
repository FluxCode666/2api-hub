import type { ModelDetail } from '@hub/shared';
import { publicApi } from '@/lib/api/public';
import { brandImage, modelImage } from '@/lib/og';

export const alt = '2API Hub 模型指南 — 价格、渠道数量与可用率';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    return await modelImage(await publicApi<ModelDetail>(`/models/${encodeURIComponent(slug)}`));
  } catch {
    return brandImage();
  }
}
