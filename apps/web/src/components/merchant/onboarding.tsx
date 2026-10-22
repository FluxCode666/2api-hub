'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { ChannelInput, MerchantSite, MerchantSiteDetail, ModelSummary, ProbeResult, SiteInput, VendorSummary } from '@hub/shared';
import { api } from '@/lib/api/client';
import type { SearchValues } from '@/lib/query';
import { paginationValues, slicePage } from '@/lib/pagination';
import { DataPagination } from '@/components/data-pagination';
import { FormatDate, StatusBadge } from '@/components/page-kit';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SiteForm, ChannelForm, errorMessage } from './forms';

const steps = ['站点信息', '添加渠道', '连接测试与模型', '提交审核'];
export function Onboarding({ initialSite, vendors, models, values }: { initialSite: MerchantSiteDetail | null; vendors: VendorSummary[]; models: ModelSummary[]; values: SearchValues }) {
  const [site, setSite] = useState(initialSite);
  const [step, setStep] = useState(initialSite && !['draft', 'rejected'].includes(initialSite.status) ? 3 : initialSite?.channels.some((channel) => channel.lastTestOk) ? 3 : initialSite?.channels.length ? 2 : initialSite ? 1 : 0);
  const [busy, setBusy] = useState('');
  const router = useRouter();
  const pagination = paginationValues(values, 'channelsPage', 'channelsPageSize');
  const totalChannels = site?.channels.length ?? 0;
  const channelPage = Math.min(pagination.page, Math.max(1, Math.ceil(totalChannels / pagination.pageSize)));
  async function loadSite(id: number) { const next = await api<MerchantSiteDetail>(`/merchant/sites/${id}`); setSite(next); return next; }
  async function saveSite(input: SiteInput) { const created = await api<MerchantSite>('/merchant/sites', { method: 'POST', body: JSON.stringify(input) }); await loadSite(created.id); router.replace(`/merchant/onboarding?siteId=${created.id}`, { scroll: false }); setStep(1); toast.success('站点草稿已保存。'); }
  async function addChannel(input: ChannelInput) { if (!site) return; await api(`/merchant/sites/${site.id}/channels`, { method: 'POST', body: JSON.stringify(input) }); await loadSite(site.id); setStep(2); toast.success('渠道已添加，请测试连接。'); }
  async function action(key: string, work: () => Promise<void>) { setBusy(key); try { await work(); } catch (error) { toast.error(errorMessage(error)); } finally { setBusy(''); } }
  async function test(id: number) { await action(`test-${id}`, async () => { const result = await api<ProbeResult>(`/merchant/channels/${id}/test`, { method: 'POST', body: '{}' }); await loadSite(site!.id); if (!result.success) throw new Error(result.errorMessage ?? '连接测试失败'); toast.success(`连接成功：完整响应 ${result.latencyMs ?? '—'} ms，首字响应 ${result.ttftMs ?? '—'} ms。`); }); }
  async function discover(id: number) { await action(`discover-${id}`, async () => { await api(`/merchant/channels/${id}/discover`, { method: 'POST', body: '{}' }); const next = await loadSite(site!.id); toast.success(`已同步 ${next.channels.find((channel) => channel.id === id)?.models.length ?? 0} 个上游模型。`); }); }
  async function submitSite() { await action('submit', async () => { await api(`/merchant/sites/${site!.id}/submit`, { method: 'POST', body: '{}' }); await loadSite(site!.id); toast.success('已提交审核，审核结果会通过站内通知发送。'); router.refresh(); }); }
  const canSubmit = site?.channels.some((channel) => channel.lastTestOk) ?? false;
  const submitted = site ? !['draft', 'rejected'].includes(site.status) : false;
  return <div className="space-y-6">
    {site && <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><span className="font-medium">{site.name}</span><StatusBadge status={site.status} /></div><Button asChild variant="ghost" size="sm"><Link href={`/merchant/sites/${site.id}`}>管理站点</Link></Button></div>}
    {site?.reviewNote && <Alert variant="destructive"><AlertDescription>审核反馈：{site.reviewNote}</AlertDescription></Alert>}
    <Tabs value={String(step)} onValueChange={(value) => setStep(Number(value))} className="space-y-6">
      <TabsList className="grid h-auto w-full grid-cols-2 gap-1 p-1 sm:grid-cols-4" aria-label="入驻步骤">{steps.map((name, index) => <TabsTrigger key={name} value={String(index)} className="h-auto gap-2 whitespace-normal py-3 text-xs sm:text-sm" disabled={Boolean(busy) || (index === 0 ? Boolean(site) : index === 1 ? !site || submitted : index === 2 ? !totalChannels || submitted : !canSubmit && !submitted)}><span className="font-mono tabular-nums">{index + 1}.</span>{name}</TabsTrigger>)}</TabsList>
      <TabsContent value="0"><Card><CardHeader><CardTitle>先让大家认识你的站点。</CardTitle><CardDescription>资料会保存为草稿，你可以随时回来继续。</CardDescription></CardHeader><CardContent><SiteForm onSave={saveSite} submitLabel="保存并添加渠道" /></CardContent></Card></TabsContent>
      <TabsContent value="1"><Card><CardHeader><CardTitle>添加一条可检测的渠道。</CardTitle><CardDescription>不同计费分组请分别添加。检测密钥只在提交时发送，页面始终显示掩码。</CardDescription></CardHeader><CardContent className="space-y-5"><ChannelForm vendors={vendors} models={models} onSave={addChannel} submitLabel="保存并测试连接" />{Boolean(totalChannels) && <Button variant="outline" onClick={() => setStep(2)}>返回已有渠道</Button>}</CardContent></Card></TabsContent>
      <TabsContent value="2" className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><div className="space-y-2"><h2 className="text-lg font-semibold">验证连接，同步模型。</h2><p className="text-sm text-muted-foreground">至少一条渠道连接成功，即可提交审核。</p></div><Button variant="outline" size="sm" onClick={() => setStep(1)}>再添加渠道</Button></div>
        {slicePage(site?.channels ?? [], channelPage, pagination.pageSize).map((channel) => <Card key={channel.id}><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-2"><CardTitle>{channel.name}</CardTitle><CardDescription className="font-mono">{channel.primaryModel}</CardDescription></div><Badge variant={channel.lastTestOk === true ? 'success' : channel.lastTestOk === false ? 'danger' : 'unknown'}>{channel.lastTestOk === true ? '连接通过' : channel.lastTestOk === false ? '连接失败' : '尚未测试'}</Badge></div></CardHeader><CardContent className="space-y-4"><p className="text-sm text-muted-foreground">{channel.models.length} 个声明模型 · 最近测试 <FormatDate value={channel.lastTestAt} /></p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={Boolean(busy)} onClick={() => test(channel.id)}>{busy === `test-${channel.id}` ? '测试中，最多 30 秒…' : '测试连接'}</Button><Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => discover(channel.id)}>{busy === `discover-${channel.id}` ? '正在获取…' : '获取模型列表'}</Button><Button asChild variant="ghost" size="sm"><Link href={`/merchant/channels/${channel.id}`}>编辑配置</Link></Button></div>{Boolean(channel.models.length) && <div className="flex flex-wrap gap-2">{channel.models.slice(0, 8).map((model) => <Badge variant="secondary" className="font-mono" key={model.id}>{model.upstreamName}</Badge>)}{channel.models.length > 8 && <Button asChild variant="link" size="sm"><Link href={`/merchant/channels/${channel.id}`}>查看全部 {channel.models.length} 个模型</Link></Button>}</div>}</CardContent></Card>)}
        <DataPagination page={channelPage} pageSize={pagination.pageSize} total={totalChannels} base="/merchant/onboarding" values={{ ...values, siteId: site ? String(site.id) : undefined }} pageKey="channelsPage" pageSizeKey="channelsPageSize" />
        <div className="flex flex-wrap items-center justify-between gap-3 pt-4"><Button variant="outline" onClick={() => setStep(1)}>添加渠道</Button><Button disabled={!canSubmit || Boolean(busy)} onClick={() => setStep(3)}>继续，确认提交</Button></div>
      </TabsContent>
      <TabsContent value="3">{site && <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>{site.status === 'pending' ? '已进入审核队列。' : site.status === 'approved' ? '站点已经上线。' : site.status === 'suspended' ? '站点暂时未公开。' : '准备好，让表现说话。'}</CardTitle><StatusBadge status={site.status} /></div><CardDescription>{site.status === 'pending' ? '平台将检测模型特征与一致性，审核通过后站点与渠道会展示在公开榜单。' : site.status === 'approved' ? '你的站点与渠道已在公开榜单展示，可以继续维护资料与渠道表现。' : site.status === 'suspended' ? '请按审核反馈修改站点与渠道资料，并联系平台处理。' : '提交后将启动模型真伪检测，请确保测试密钥额度充足，站点资料和倍率真实准确。'}</CardDescription></CardHeader><CardContent className="space-y-6"><dl className="merchant-info-list"><div><dt>站点</dt><dd>{site.name}</dd></div><div><dt>渠道数量</dt><dd className="font-mono tabular-nums">{totalChannels} 条</dd></div><div><dt>连接通过</dt><dd className="font-mono tabular-nums">{site.channels.filter((channel) => channel.lastTestOk).length} 条</dd></div></dl>{submitted ? <div className="flex flex-wrap gap-2"><Button asChild><Link href="/merchant/sites">查看我的站点</Link></Button><Button asChild variant="outline"><Link href="/merchant">返回工作台</Link></Button></div> : <div className="flex flex-wrap items-center justify-between gap-3"><Button variant="outline" onClick={() => setStep(2)}>返回连接测试</Button><Button disabled={!canSubmit || Boolean(busy)} onClick={submitSite}>{busy === 'submit' ? '正在提交…' : '确认提交审核'}</Button></div>}</CardContent></Card>}</TabsContent>
    </Tabs>
  </div>;
}
