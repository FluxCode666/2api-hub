import Link from 'next/link';
import type { MerchantSite } from '@hub/shared';
import { serverApi, requireSession } from '@/lib/api/server';
import { PageHead } from '@/components/ui';
import { SitesList } from '@/components/merchant/sites';
export default async function SitesPage() { await requireSession(); const sites = await serverApi<MerchantSite[]>('/merchant/sites'); return <><PageHead title="我的站点" description="管理站点资料、渠道配置和入驻进度。"><Link href="/merchant/onboarding" className="btn btn-primary">添加站点</Link></PageHead><SitesList sites={sites} /></>; }
