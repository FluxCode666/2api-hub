import Link from 'next/link';
import type { MerchantOverview } from '@hub/shared';
import { serverApi, requireSession } from '@/lib/api/server';
import type { SearchValues } from '@/lib/query';
import { paginationValues, slicePage } from '@/lib/pagination';
import { DataPagination } from '@/components/data-pagination';
import { PageHead, Metric, Empty, StatusBadge, FormatDate } from '@/components/page-kit';
import { UptimeBar, TrustBadge } from '@/components/charts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default async function MerchantPage({ searchParams }: { searchParams: Promise<SearchValues> }) {
  await requireSession();
  const [data, values] = await Promise.all([serverApi<MerchantOverview>('/merchant/overview'), searchParams]);
  const alerts = paginationValues(values, 'alertsPage', 'alertsPageSize');
  const channels = paginationValues(values, 'channelsPage', 'channelsPageSize');
  const alertPage = Math.min(alerts.page, Math.max(1, Math.ceil(data.alerts.length / alerts.pageSize)));
  const channelPage = Math.min(channels.page, Math.max(1, Math.ceil(data.channels.length / channels.pageSize)));
  return <><PageHead eyebrow="站长工作台" title="每一条连接，都有迹可循。" description="关注渠道健康，管理站点资料，让服务表现持续被看见。"><Button asChild><Link href="/merchant/onboarding">入驻新站点</Link></Button></PageHead>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="我的站点" value={data.siteCount} detail={`${data.approvedSiteCount} 个已上线 · ${data.pendingSiteCount} 个审核中`} /><Metric label="上线站点" value={data.approvedSiteCount} detail="审核通过，公开展示" /><Metric label="渠道总数" value={data.channelCount} detail={`${data.activeChannelCount} 条运行中`} /><Metric label="24h 平均可用率" value={data.avgUptime24h === null ? '暂无样本' : `${(data.avgUptime24h * 100).toFixed(2)}%`} detail="仅统计已有探测样本的渠道" /></div>
    <section className="mt-8 space-y-4"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">需要关注</h2><span className="text-sm text-muted-foreground">{data.alerts.length} 条告警</span></div>
      {data.alerts.length ? <div className="space-y-3">{slicePage(data.alerts, alertPage, alerts.pageSize).map((alert, index) => <Link className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`/merchant/channels/${alert.channelId}`} key={`${alert.channelId}-${index}`}><Card className="transition-colors hover:border-primary/40"><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><Badge variant={alert.type === 'invalid' || alert.type === 'down' ? 'danger' : 'warning'}>{alert.type === 'invalid' ? '渠道无效' : alert.type === 'trust_low' ? '可信分偏低' : alert.type === 'down' ? '连接中断' : '服务波动'}</Badge><span className="text-xs text-muted-foreground"><FormatDate value={alert.at} /></span></div><CardTitle>{alert.siteName} / {alert.channelName}</CardTitle><CardDescription>{alert.message}</CardDescription></CardHeader></Card></Link>)}</div> : <Alert><AlertDescription>目前没有需要处理的渠道告警。</AlertDescription></Alert>}
      <DataPagination page={alertPage} pageSize={alerts.pageSize} total={data.alerts.length} base="/merchant" values={values} pageKey="alertsPage" pageSizeKey="alertsPageSize" />
    </section>
    <section className="mt-8 space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">渠道健康</h2><Button asChild variant="link" size="sm"><Link href="/merchant/sites">管理站点 →</Link></Button></div>
      {data.channels.length ? <div className="grid gap-4 xl:grid-cols-2">{slicePage(data.channels, channelPage, channels.pageSize).map((channel) => <Link className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`/merchant/channels/${channel.id}`} key={channel.id}><Card className="h-full transition-colors hover:border-primary/40"><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-2"><CardDescription>{channel.siteName}</CardDescription><CardTitle>{channel.name}</CardTitle></div><StatusBadge status={channel.status} /></div></CardHeader><CardContent className="space-y-4"><div className="flex items-center justify-between gap-3"><span className="font-mono text-lg tabular-nums">{channel.stats?.uptime24h == null ? '暂无样本' : `${(channel.stats.uptime24h * 100).toFixed(2)}%`}</span><TrustBadge score={channel.stats?.trustScore ?? null} verdict={channel.stats?.trustVerdict ?? 'unknown'} /></div><div className="merchant-chart"><UptimeBar points={channel.stats?.sparkline ?? []} /></div><p className="text-xs text-muted-foreground">24h 可用率 · 最近 {channel.stats?.sparkline.length ?? 0} 次探测</p></CardContent></Card></Link>)}</div> : <Empty title="还没有渠道" description="完成站点入驻，添加第一条渠道并测试连接。" />}
      <DataPagination page={channelPage} pageSize={channels.pageSize} total={data.channels.length} base="/merchant" values={values} pageKey="channelsPage" pageSizeKey="channelsPageSize" />
    </section>
  </>;
}
