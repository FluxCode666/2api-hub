import { notFound } from 'next/navigation';
import type { ModelSummary, VendorSummary } from '@hub/shared';
import { serverApi, requireSession } from '@/lib/api/server';
import { PageHead } from '@/components/ui';
import { Onboarding } from '@/components/merchant/onboarding';
import { getMerchantSite } from '@/components/merchant/server';
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ siteId?: string }> }) { await requireSession(); const { siteId } = await searchParams; if (siteId && !/^\d+$/.test(siteId)) notFound(); const [vendors, models, site] = await Promise.all([serverApi<VendorSummary[]>('/vendors'), serverApi<ModelSummary[]>('/models'), siteId ? getMerchantSite(siteId) : Promise.resolve(null)]); return <><PageHead title="让优质的连接被更多人看见。" description="四步完成入驻，先验证，再公开。每一步都会保存，随时可以继续。" /><Onboarding key={site?.id ?? 'new'} initialSite={site} vendors={vendors} models={models} /></>; }
