'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { ChannelInput, MerchantSiteDetail, ModelSummary, SiteInput, VendorSummary } from '@hub/shared';
import { api } from '@/lib/api/client';
import type { SearchValues } from '@/lib/query';
import { paginationValues, slicePage } from '@/lib/pagination';
import { DataPagination } from '@/components/data-pagination';
import { Metric, StatusBadge, Empty, FormatDate } from '@/components/page-kit';
import { TrustBadge } from '@/components/trust-badge';
import { toTrustReportBrief, trustModelDisplayName } from '@/lib/trust-report';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { SiteForm, ChannelForm } from './forms';

export function SiteManager({ initialSite, vendors, models, values }: { initialSite: MerchantSiteDetail; vendors: VendorSummary[]; models: ModelSummary[]; values: SearchValues }) {
  const [site, setSite] = useState(initialSite); const [adding, setAdding] = useState(false); const router = useRouter();
  const canAddChannel = ['draft', 'rejected'].includes(site.status);
  const pagination = paginationValues(values);
  const page = Math.min(pagination.page, Math.max(1, Math.ceil(site.channels.length / pagination.pageSize)));
  async function reload() { setSite(await api<MerchantSiteDetail>(`/merchant/sites/${site.id}`)); router.refresh(); }
  async function save(input: SiteInput) { await api(`/merchant/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify(input) }); await reload(); toast.success('站点资料已保存。'); }
  async function addChannel(input: ChannelInput) { await api(`/merchant/sites/${site.id}/channels`, { method: 'POST', body: JSON.stringify(input) }); await reload(); setAdding(false); toast.success('渠道已添加，请进入详情测试连接。'); }
  return <div className="space-y-6"><div className="flex flex-wrap items-center justify-between gap-3"><StatusBadge status={site.status} /><span className="text-sm text-muted-foreground">最近更新 <FormatDate value={site.updatedAt} /></span></div>
    {site.reviewNote && <Alert variant="destructive"><AlertDescription>审核反馈：{site.reviewNote}</AlertDescription></Alert>}
    {canAddChannel && <Alert><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>完成渠道连接测试后，即可继续提交审核。</span><Button asChild size="sm"><Link href={`/merchant/onboarding?siteId=${site.id}`}>继续入驻</Link></Button></AlertDescription></Alert>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="渠道数量" value={site.channels.length} /><Metric label="声明模型" value={site.channels.reduce((sum, channel) => sum + channel.models.length, 0)} detail="各渠道模型总数" /><Metric label="充值倍率" value={`${site.rechargeRatio}×`} detail="每 ¥1 可充值的美元额度" /><Metric label="24h 平均可用率" value={site.stats?.avgUptime24h == null ? '暂无样本' : `${(site.stats.avgUptime24h * 100).toFixed(2)}%`} /></div>
    <Card><CardContent><Accordion type="single" collapsible><AccordionItem value="site" className="border-0"><AccordionTrigger>编辑站点资料</AccordionTrigger><AccordionContent><SiteForm site={site} onSave={save} /></AccordionContent></AccordionItem></Accordion></CardContent></Card>
    <section className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">旗下渠道</h2>{canAddChannel && <Button size="sm" variant={adding ? 'outline' : 'default'} onClick={() => setAdding(!adding)}>{adding ? '收起表单' : '添加渠道'}</Button>}</div>
      {!canAddChannel && <p className="text-sm text-muted-foreground">当前站点状态下可维护现有渠道；新增渠道请联系平台处理。</p>}
      {adding && canAddChannel && <Card><CardHeader><CardTitle>添加渠道</CardTitle></CardHeader><CardContent><ChannelForm vendors={vendors} models={models} onSave={addChannel} submitLabel="创建渠道" /></CardContent></Card>}
      {site.channels.length ? <div className="grid gap-4 xl:grid-cols-2">{slicePage(site.channels, page, pagination.pageSize).map((channel) => <Card key={channel.id} className="h-full transition-colors hover:border-primary/40"><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle><Link className="hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`/merchant/channels/${channel.id}`}>{channel.name}</Link></CardTitle><StatusBadge status={channel.status} /></div></CardHeader><CardContent className="space-y-4"><p className="font-mono text-sm text-muted-foreground">{channel.primaryModel}</p><div className="flex flex-wrap items-center justify-between gap-3"><span className="font-mono text-sm tabular-nums">{channel.actualRatio}× 实际倍率</span><Badge variant={channel.lastTestOk ? 'success' : channel.lastTestOk === false ? 'danger' : 'unknown'}>{channel.lastTestOk ? '连接通过' : channel.lastTestOk === false ? '连接失败' : '待测试'}</Badge></div><div className="flex flex-wrap items-center justify-between gap-3"><TrustBadge score={channel.latestReport?.score ?? null} verdict={channel.latestReport?.verdict ?? 'unknown'} report={toTrustReportBrief(channel.latestReport)} channelId={channel.id} modelName={trustModelDisplayName(channel.latestReport?.model,channel.models)} /><Button asChild size="sm" variant="link" className="px-0"><Link href={`/merchant/channels/${channel.id}`}>配置、模型与探测日志 →</Link></Button></div></CardContent></Card>)}</div> : <Empty title="还没有添加渠道" description="为站点添加一个计费分组，再进行连接测试。" />}
      <DataPagination page={page} pageSize={pagination.pageSize} total={site.channels.length} base={`/merchant/sites/${site.id}`} values={values} />
    </section>
  </div>;
}
