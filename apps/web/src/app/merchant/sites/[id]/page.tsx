import { notFound } from 'next/navigation';
import type { ModelSummary, VendorSummary } from '@hub/shared';
import { serverApi, requireSession } from '@/lib/api/server';
import type { SearchValues } from '@/lib/query';
import { PageHead } from '@/components/page-kit';
import { SiteManager } from '@/components/merchant/site-manager';
import { getMerchantSite } from '@/components/merchant/server';
export default async function SitePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchValues> }) {
  await requireSession();
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const [site, vendors, models, values] = await Promise.all([getMerchantSite(id), serverApi<VendorSummary[]>('/vendors'), serverApi<ModelSummary[]>('/models'), searchParams]);
  return <><PageHead title={site.name} description="维护站点档案，管理各个分组与模型。" /><SiteManager initialSite={site} vendors={vendors} models={models} values={values} /></>;
}
