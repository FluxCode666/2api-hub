import Link from 'next/link';
import type { MerchantSite } from '@hub/shared';
import { serverApi, requireSession } from '@/lib/api/server';
import type { SearchValues } from '@/lib/query';
import { PageHead } from '@/components/page-kit';
import { Button } from '@/components/ui/button';
import { SitesList } from '@/components/merchant/sites';
export default async function SitesPage({ searchParams }: { searchParams: Promise<SearchValues> }) {
  await requireSession();
  const [sites, values] = await Promise.all([serverApi<MerchantSite[]>('/merchant/sites'), searchParams]);
  return <><PageHead title="我的站点" description="管理站点资料、渠道配置和入驻进度。"><Button asChild><Link href="/merchant/onboarding">添加站点</Link></Button></PageHead><SitesList sites={sites} values={values} /></>;
}
