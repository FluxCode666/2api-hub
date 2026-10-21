import { notFound } from 'next/navigation';
import type { ModelSummary, VendorSummary } from '@hub/shared';
import { serverApi, requireSession } from '@/lib/api/server';
import { PageHead } from '@/components/ui';
import { SiteManager } from '@/components/merchant/site-manager';
import { getMerchantSite } from '@/components/merchant/server';
export default async function SitePage({ params }: { params: Promise<{ id: string }> }) { await requireSession(); const { id } = await params; if (!/^\d+$/.test(id)) notFound(); const [site, vendors, models] = await Promise.all([getMerchantSite(id), serverApi<VendorSummary[]>('/vendors'), serverApi<ModelSummary[]>('/models')]); return <><PageHead title={site.name} description="维护站点档案，管理各个分组与模型。" /><SiteManager initialSite={site} vendors={vendors} models={models} /></>; }
