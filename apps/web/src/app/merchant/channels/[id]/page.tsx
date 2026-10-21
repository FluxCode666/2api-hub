import { notFound } from 'next/navigation';
import type { MerchantOverview, ModelSummary, Paginated, ProbeRun, VendorSummary } from '@hub/shared';
import { serverApi, requireSession } from '@/lib/api/server';
import { PageHead } from '@/components/ui';
import { ChannelManager } from '@/components/merchant/channel-manager';
import { getMerchantSite } from '@/components/merchant/server';
export default async function ChannelPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params; if (!/^\d+$/.test(id)) notFound(); const channelId = Number(id);
  const [overview, vendors, models] = await Promise.all([serverApi<MerchantOverview>('/merchant/overview'), serverApi<VendorSummary[]>('/vendors'), serverApi<ModelSummary[]>('/models')]);
  const summary = overview.channels.find((c) => c.id === channelId); if (!summary) notFound();
  const [site, runs] = await Promise.all([getMerchantSite(summary.siteId), serverApi<Paginated<ProbeRun>>(`/merchant/channels/${id}/runs?pageSize=20`)]);
  const channel = site.channels.find((c) => c.id === channelId);
  if (!site || !channel) notFound();
  return <><PageHead title={channel.name} description="检查连接、维护模型映射与价格，查看完整检测记录。" /><ChannelManager initialSite={site} channelId={channelId} models={models} vendors={vendors} initialRuns={runs} /></>;
}
