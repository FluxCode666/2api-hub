import Link from 'next/link';
import type { AdminSiteDetail } from '@hub/shared';
import { requireSession, serverApi } from '@/lib/api/server';
import { PageHead } from '@/components/page-kit';
import { AdminSiteDetailView } from '@/components/admin/site-detail';
import { Button } from '@/components/ui/button';

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  if (!await requireSession(true)) return null;
  const { id } = await params;
  const site = await serverApi<AdminSiteDetail>(`/admin/sites/${encodeURIComponent(id)}`);
  return <div className="space-y-6"><PageHead title="审阅站点" description="核对站长资料、连接结果和模型检测证据。"><Button asChild variant="outline"><Link href="/admin/reviews">返回审核队列</Link></Button></PageHead><AdminSiteDetailView site={site} /></div>;
}
