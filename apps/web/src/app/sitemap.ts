import type { MetadataRoute } from 'next';
import type { ChannelListItem, ModelSummary, Paginated, SiteListItem, VendorSummary } from '@hub/shared';
import { publicApi } from '@/lib/api/public';
import { absoluteUrl } from '@/lib/seo';

export const revalidate = 300;

async function allPages<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const result = await publicApi<Paginated<T>>(`${path}?page=${page}&pageSize=100`);
    items.push(...result.items);
    if (result.items.length === 0 || page * result.pageSize >= result.total) return items;
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [sites, channels, models, vendors] = await Promise.all([
    allPages<SiteListItem>('/sites'),
    allPages<ChannelListItem>('/channels'),
    publicApi<ModelSummary[]>('/models'),
    publicApi<VendorSummary[]>('/vendors'),
  ]);
  const staticPages: MetadataRoute.Sitemap = [
    { url: absoluteUrl('/'), changeFrequency: 'daily', priority: 1 },
    { url: absoluteUrl('/rankings'), changeFrequency: 'hourly', priority: 0.9 },
    { url: absoluteUrl('/models'), changeFrequency: 'daily', priority: 0.8 },
    { url: absoluteUrl('/vendors'), changeFrequency: 'weekly', priority: 0.7 },
    { url: absoluteUrl('/sites'), changeFrequency: 'daily', priority: 0.8 },
    { url: absoluteUrl('/verify'), changeFrequency: 'weekly', priority: 0.7 },
    { url: absoluteUrl('/join'), changeFrequency: 'monthly', priority: 0.6 },
    { url: absoluteUrl('/guide'), changeFrequency: 'monthly', priority: 0.6 },
  ];
  const entries: MetadataRoute.Sitemap = [
    ...staticPages,
    ...sites.map(site => ({ url: absoluteUrl(`/sites/${encodeURIComponent(site.slug)}`), changeFrequency: 'daily' as const, priority: 0.7 })),
    ...channels.map(channel => ({ url: absoluteUrl(`/channels/${channel.id}`), changeFrequency: 'hourly' as const, priority: 0.6 })),
    ...models.map(model => ({ url: absoluteUrl(`/models/${encodeURIComponent(model.slug)}`), changeFrequency: 'daily' as const, priority: 0.8 })),
    ...vendors.map(vendor => ({ url: absoluteUrl(`/vendors/${encodeURIComponent(vendor.slug)}`), changeFrequency: 'weekly' as const, priority: 0.6 })),
  ];
  return [...new Map(entries.map(entry => [entry.url, entry])).values()];
}
