import { notFound } from 'next/navigation';
import type { ModelSummary, VendorSummary } from '@hub/shared';
import { serverApi, requireSession } from '@/lib/api/server';
import type { SearchValues } from '@/lib/query';
import { PageHead } from '@/components/page-kit';
import { Onboarding } from '@/components/merchant/onboarding';
import { getMerchantSite } from '@/components/merchant/server';
import { DashboardTrail } from '@/components/dashboard-shell';
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<SearchValues> }) {
  await requireSession();
  const values = await searchParams;
  const siteId = Array.isArray(values.siteId) ? values.siteId[0] : values.siteId;
  if (siteId && !/^\d+$/.test(siteId)) notFound();
  const [vendors, models, site] = await Promise.all([serverApi<VendorSummary[]>('/vendors'), serverApi<ModelSummary[]>('/models'), siteId ? getMerchantSite(siteId) : Promise.resolve(null)]);
  return <><DashboardTrail items={site ? [{ label: '我的站点', href: '/merchant/sites' }, { label: site.name, href: `/merchant/sites/${site.id}` }, { label: '继续入驻' }] : [{ label: '站点入驻' }]} /><PageHead title="让优质的连接被更多人看见。" description="四步完成入驻，先验证，再公开。每一步都会保存，随时可以继续。" /><Onboarding key={site?.id ?? 'new'} initialSite={site} vendors={vendors} models={models} values={values} /></>;
}
