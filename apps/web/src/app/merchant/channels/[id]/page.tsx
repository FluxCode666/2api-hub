import { notFound } from 'next/navigation';
import type { MerchantOverview, ModelSummary, Paginated, ProbeRun, VendorSummary } from '@hub/shared';
import { serverApi, requireSession } from '@/lib/api/server';
import type { SearchValues } from '@/lib/query';
import { paginationValues } from '@/lib/pagination';
import { PageHead } from '@/components/page-kit';
import { ChannelManager } from '@/components/merchant/channel-manager';
import { getMerchantSite } from '@/components/merchant/server';
export default async function ChannelPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchValues> }) {
  await requireSession();
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const channelId = Number(id);
  const [overview, vendors, models, values] = await Promise.all([serverApi<MerchantOverview>('/merchant/overview'), serverApi<VendorSummary[]>('/vendors'), serverApi<ModelSummary[]>('/models'), searchParams]);
  const summary = overview.channels.find((channel) => channel.id === channelId);
  if (!summary) notFound();
  const pagination = paginationValues(values);
  const [site, requestedRuns] = await Promise.all([getMerchantSite(summary.siteId), serverApi<Paginated<ProbeRun>>(`/merchant/channels/${id}/runs?page=${pagination.page}&pageSize=${pagination.pageSize}`)]);
  const page = Math.min(pagination.page, Math.max(1, Math.ceil(requestedRuns.total / pagination.pageSize)));
  const runs = page === pagination.page ? requestedRuns : await serverApi<Paginated<ProbeRun>>(`/merchant/channels/${id}/runs?page=${page}&pageSize=${pagination.pageSize}`);
  const channel = site.channels.find((entry) => entry.id === channelId);
  if (!channel) notFound();
  return <><PageHead title={channel.name} description="检查连接、维护模型映射与价格，查看完整检测记录。" /><ChannelManager initialSite={site} channelId={channelId} models={models} vendors={vendors} initialRuns={runs} values={values} /></>;
}
