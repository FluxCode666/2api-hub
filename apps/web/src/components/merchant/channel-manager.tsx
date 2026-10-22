'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { PROTOCOL_LABELS } from '@hub/shared';
import type { ChannelInput, ChannelModelsInput, MerchantChannel, MerchantChannelModel, MerchantSiteDetail, ModelSummary, Paginated, ProbeResult, ProbeRun, ProbeTask, VendorSummary } from '@hub/shared';
import { api, apiWithHeaders, apiNoticeMessage } from '@/lib/api/client';
import type { SearchValues } from '@/lib/query';
import { paginationValues, slicePage } from '@/lib/pagination';
import { DataPagination } from '@/components/data-pagination';
import { Metric, Empty, FormatDate, StatusBadge } from '@/components/page-kit';
import { TrustBadge, UptimeBar, Sparkline } from '@/components/charts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ChannelForm, errorMessage } from './forms';
import { ModelsEditor } from './models-editor';

const taskLabels: Record<ProbeTask['status'], string> = { queued: '排队中', running: '检测中', done: '检测完成', failed: '检测失败', canceled: '已取消' };
const pending = (task: ProbeTask | null) => task?.status === 'queued' || task?.status === 'running';
const detectionSchema = z.object({ models: z.array(z.string()).max(20, '每次最多选择 20 个模型') });
type DetectionValues = z.infer<typeof detectionSchema>;

export function ChannelManager({ initialSite, channelId, models, vendors, initialRuns, values }: { initialSite: MerchantSiteDetail; channelId: number; models: ModelSummary[]; vendors: VendorSummary[]; initialRuns: Paginated<ProbeRun>; values: SearchValues }) {
  const router = useRouter();
  const [site, setSite] = useState(initialSite);
  const channel = site.channels.find((entry) => entry.id === channelId)!;
  const [runs, setRuns] = useState(initialRuns);
  const [busy, setBusy] = useState('');
  const [task, setTask] = useState<ProbeTask | null>(null);
  const [pollPaused, setPollPaused] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [modelVersion, setModelVersion] = useState(0);
  const detection = useForm<DetectionValues>({ resolver: zodResolver(detectionSchema), defaultValues: { models: [] } });
  const selectedModels = useWatch({ control: detection.control, name: 'models' });
  const detectionPagination = paginationValues(values, 'detectPage', 'detectPageSize');
  const detectPage = Math.min(detectionPagination.page, Math.max(1, Math.ceil(channel.models.length / detectionPagination.pageSize)));
  const base = `/merchant/channels/${channelId}`;
  useEffect(() => setRuns(initialRuns), [initialRuns]);
  useEffect(() => setSite(initialSite), [initialSite]);
  async function reloadChannel() { const next = await api<MerchantSiteDetail>(`/merchant/sites/${site.id}`); setSite(next); return next.channels.find((entry) => entry.id === channelId); }
  async function loadRuns() { setRuns(await api<Paginated<ProbeRun>>(`/merchant/channels/${channelId}/runs?page=${runs.page}&pageSize=${runs.pageSize}`)); }
  async function action(key: string, work: () => Promise<void>) { setBusy(key); try { await work(); } catch (error) { toast.error(errorMessage(error)); } finally { setBusy(''); } }
  useEffect(() => {
    if (!task || !pending(task) || pollPaused) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    async function poll() {
      try {
        const next = await api<ProbeTask>(`/merchant/tasks/${task!.id}`);
        if (stopped) return;
        if (!pending(next)) {
          if (next.status === 'done') { const nextSite = await api<MerchantSiteDetail>(`/merchant/sites/${initialSite.id}`); if (stopped) return; setSite(nextSite); toast.success('模型检测已完成，报告与可信分已更新。'); }
          else if (next.status === 'failed') toast.error(next.error ?? '检测失败，请稍后重试。');
          setTask(next);
          return;
        }
        failures = 0;
        setTask(next);
      } catch (error) {
        if (stopped) return;
        failures += 1;
        if (failures >= 3) { toast.error(`任务状态获取失败：${errorMessage(error)}`); setPollPaused(true); return; }
      }
      if (!stopped) timer = setTimeout(poll, 1800);
    }
    timer = setTimeout(poll, 1200);
    return () => { stopped = true; clearTimeout(timer); };
  }, [task?.id, task?.status, pollPaused, initialSite.id]);
  async function test() { await action('test', async () => { const result = await api<ProbeResult>(`/merchant/channels/${channelId}/test`, { method: 'POST', body: '{}' }); await reloadChannel(); await loadRuns(); if (!result.success) throw new Error(result.errorMessage ?? '连接测试失败'); toast.success(`连接测试通过：完整响应 ${result.latencyMs ?? '—'} ms，首字响应 ${result.ttftMs ?? '—'} ms。`); }); }
  async function discover() { await action('discover', async () => { const discovered = await api<MerchantChannelModel[]>(`/merchant/channels/${channelId}/discover`, { method: 'POST', body: '{}' }); await reloadChannel(); setModelVersion((version) => version + 1); toast.success(`已从上游同步 ${discovered.length} 个模型，请检查映射。`); }); }
  async function startTask(input: DetectionValues) { await action('authenticity', async () => { const selected = input.models.filter((name) => channel.models.some((model) => model.upstreamName === name)); const next = await api<ProbeTask>(`/merchant/channels/${channelId}/authenticity`, { method: 'POST', body: JSON.stringify(selected.length ? { models: selected } : {}) }); setTask(next); setPollPaused(false); toast.success('检测任务已提交，完成后将自动更新报告。'); }); }
  async function saveChannel(input: ChannelInput) { const { headers } = await apiWithHeaders<MerchantChannel>(`/merchant/channels/${channelId}`, { method: 'PATCH', body: JSON.stringify(input) }); await reloadChannel(); setModelVersion((version) => version + 1); const notice = apiNoticeMessage(headers); if (notice) toast.warning(notice); else toast.success('渠道配置已保存。'); router.refresh(); }
  async function saveModels(input: ChannelModelsInput) { await api(`/merchant/channels/${channelId}/models`, { method: 'PUT', body: JSON.stringify(input) }); await reloadChannel(); setModelVersion((version) => version + 1); toast.success('模型映射与覆盖价已保存。'); }
  const report = channel.latestReport;
  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><Button asChild variant="link" className="px-0"><Link href={`/merchant/sites/${site.id}`}>← {site.name}</Link></Button><div className="flex flex-wrap gap-2"><StatusBadge status={channel.status} /><Badge variant="secondary">{PROTOCOL_LABELS[channel.protocol]}</Badge></div></div>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="24h 可用率" value={channel.stats?.uptime24h == null ? '暂无样本' : `${(channel.stats.uptime24h * 100).toFixed(2)}%`} detail={`${channel.stats?.samples24h ?? 0} 次探测样本`} /><Metric label="P50 延迟" value={channel.stats?.latencyP50 == null ? '—' : `${channel.stats.latencyP50} ms`} detail={`首字响应 ${channel.stats?.ttftAvg ?? '—'} ms`} /><Metric label="实际倍率" value={`${channel.actualRatio}×`} detail={`${channel.groupRatio} ÷ ${site.rechargeRatio}`} /><Metric label="模型可信分" value={channel.stats?.trustScore ?? report?.score ?? '未检测'} detail="分数范围 0–100" /></div>
    <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>连接状态</CardTitle><Badge variant={channel.lastTestOk ? 'success' : channel.lastTestOk === false ? 'danger' : 'unknown'}>{channel.lastTestOk ? '连接通过' : channel.lastTestOk === false ? '连接失败' : '未测试'}</Badge></div></CardHeader><CardContent className="space-y-5"><dl className="merchant-info-list"><div><dt>接口地址</dt><dd className="font-mono text-sm">{channel.baseUrl}</dd></div><div><dt>主测模型</dt><dd className="font-mono text-sm">{channel.primaryModel}</dd></div><div><dt>检测密钥</dt><dd className="font-mono text-sm">{channel.apiKeyMask}</dd></div><div><dt>最近连接测试</dt><dd className="text-sm"><FormatDate value={channel.lastTestAt} /></dd></div><div><dt>自动探测</dt><dd className="text-sm">{channel.probeEnabled ? `已启用 · 每 ${channel.probeIntervalSec} 秒` : '已暂停'}</dd></div><div><dt>备用模型</dt><dd className="font-mono text-sm">{channel.backupModel ?? '未设置'}</dd></div></dl><div className="merchant-chart"><UptimeBar points={channel.stats?.sparkline ?? []} /></div><div className="flex flex-wrap gap-2"><Button size="sm" disabled={Boolean(busy)} onClick={test}>{busy === 'test' ? '测试中，最多 30 秒…' : '测试连接'}</Button><Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={discover}>{busy === 'discover' ? '正在获取…' : '获取模型列表'}</Button></div><p className="text-xs text-muted-foreground">检测密钥仅返回掩码，请保持足够测试额度。连接失败时可在下方日志查看原因。</p></CardContent></Card>
    <Card><CardContent><Accordion type="single" collapsible><AccordionItem value="channel" className="border-0"><AccordionTrigger>编辑渠道配置</AccordionTrigger><AccordionContent><ChannelForm channel={channel} models={models} vendors={vendors} onSave={saveChannel} /></AccordionContent></AccordionItem></Accordion></CardContent></Card>
    <Card><CardHeader><div className="flex items-center justify-between gap-3"><CardTitle>模型映射与价格</CardTitle><span className="text-sm text-muted-foreground">{channel.models.length} 个模型</span></div></CardHeader><CardContent><ModelsEditor key={modelVersion} channel={channel} models={models} values={values} onSave={saveModels} /></CardContent></Card>
    <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-2"><CardTitle>模型检测</CardTitle><CardDescription>按特征交叉验证模型身份，每条渠道每天可手动检测 3 次。</CardDescription></div><TrustBadge score={report?.score ?? null} verdict={report?.verdict ?? 'unknown'} /></div></CardHeader><CardContent className="space-y-6">
      <Form {...detection}><form onSubmit={detection.handleSubmit(startTask)} className="space-y-4">
        {channel.models.length > 0 && <FormField control={detection.control} name="models" render={({ field }) => <FormItem><FormLabel>检测模型（最多 20 个，不选则检测主测模型）</FormLabel><div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">{slicePage(channel.models, detectPage, detectionPagination.pageSize).map((model) => <FormItem key={model.id} className="flex items-start gap-2 space-y-0"><FormControl><Checkbox checked={field.value.includes(model.upstreamName)} disabled={pending(task) || Boolean(busy) || (selectedModels.length >= 20 && !field.value.includes(model.upstreamName))} onCheckedChange={(checked) => field.onChange(checked === true ? [...field.value, model.upstreamName] : field.value.filter((name) => name !== model.upstreamName))} /></FormControl><FormLabel className="break-all font-mono text-xs font-normal">{model.upstreamName}</FormLabel></FormItem>)}</div><FormMessage /></FormItem>} />}
        <DataPagination page={detectPage} pageSize={detectionPagination.pageSize} total={channel.models.length} base={base} values={values} pageKey="detectPage" pageSizeKey="detectPageSize" />
        <div className="flex flex-wrap items-center gap-3"><Button size="sm" type="submit" disabled={Boolean(busy) || pending(task)}>{busy === 'authenticity' ? '正在提交…' : pending(task) ? '检测进行中…' : '发起模型检测'}</Button><span className="text-xs text-muted-foreground">已选择 {selectedModels.length} 个</span></div>
      </form></Form>
      {task && <Alert><AlertTitle className="flex flex-wrap items-center justify-between gap-3"><span>任务 <span className="font-mono">#{task.id}</span> · {taskLabels[task.status]}</span>{pollPaused && <Button variant="outline" size="sm" onClick={() => setPollPaused(false)}>继续获取状态</Button>}</AlertTitle><AlertDescription>{pending(task) ? '检测需要一些时间，任务状态会自动更新。' : task.status === 'done' ? '已完成全部检查。' : task.error ?? '任务已结束。'}</AlertDescription></Alert>}
      {report ? <><div className="flex flex-wrap items-center justify-between gap-3 text-xs"><span className="font-mono">{report.model}</span><span className="text-muted-foreground"><FormatDate value={report.createdAt} /> · {(report.durationMs / 1000).toFixed(1)} 秒</span></div><div className="grid gap-3 md:grid-cols-2">{report.checks.map((check) => <Card key={check.id} className="gap-3 py-4 shadow-none"><CardContent className="space-y-3"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">{check.name}</h3><Badge variant={check.passed === true ? 'success' : check.passed === false ? 'danger' : 'unknown'}>{check.passed === true ? '通过' : check.passed === false ? '未通过' : '未执行'}</Badge></div><p className="text-sm text-muted-foreground">{check.detail}</p><p className="text-xs text-muted-foreground">权重 {check.weight}{check.score !== undefined ? ` · 得分 ${(check.score * 100).toFixed(0)}%` : ''}</p></CardContent></Card>)}</div></> : <Empty title="还没有模型检测报告" description="发起检测后，可在这里查看逐项验证结果与可信评分。" />}
    </CardContent></Card>
    <Card><CardHeader><CardTitle>延迟趋势</CardTitle><CardDescription>最近 {channel.stats?.sparkline.length ?? 0} 次探测 · ms</CardDescription></CardHeader><CardContent>{channel.stats?.sparkline.length ? <div className="merchant-chart"><Sparkline points={channel.stats.sparkline} /></div> : <Empty title="暂无趋势样本" description="站点上线并开始定时探测后，将展示延迟趋势。" />}</CardContent></Card>
    <Card><CardHeader><div className="flex items-center justify-between gap-3"><CardTitle>探测日志</CardTitle><Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => action('runs', loadRuns)}>{busy === 'runs' ? '正在刷新…' : '刷新日志'}</Button></div></CardHeader><CardContent>{runs.items.length ? <Table><TableHeader><TableRow><TableHead>时间</TableHead><TableHead>模型</TableHead><TableHead>结果</TableHead><TableHead className="text-right">完整延迟</TableHead><TableHead className="text-right">首字延迟</TableHead><TableHead>HTTP</TableHead><TableHead>原因</TableHead></TableRow></TableHeader><TableBody>{runs.items.map((run) => <TableRow key={run.id}><TableCell className="whitespace-nowrap text-xs"><FormatDate value={run.createdAt} /></TableCell><TableCell className="font-mono text-xs">{run.model}</TableCell><TableCell><Badge variant={run.success ? 'success' : 'danger'}>{run.success ? '成功' : '失败'}</Badge></TableCell><TableCell className="text-right font-mono text-xs tabular-nums">{run.latencyMs === null ? '—' : `${run.latencyMs} ms`}</TableCell><TableCell className="text-right font-mono text-xs tabular-nums">{run.ttftMs === null ? '—' : `${run.ttftMs} ms`}</TableCell><TableCell className="font-mono text-xs">{run.httpStatus ?? '—'}</TableCell><TableCell className="max-w-64 whitespace-normal text-xs">{run.errorMessage ?? run.errorCode ?? '—'}</TableCell></TableRow>)}</TableBody></Table> : <Empty title="暂无探测日志" description="先测试一次连接，日志会记录响应时间和失败原因。" />}<DataPagination page={runs.page} pageSize={runs.pageSize} total={runs.total} base={base} values={values} /></CardContent></Card>
    {site.status !== 'approved' && <Card><CardHeader><CardTitle>移除渠道</CardTitle><CardDescription>移除后，这条渠道将从站点中删除。</CardDescription></CardHeader><CardContent><Button variant="destructive" size="sm" onClick={() => setDeleting(true)}>移除渠道</Button></CardContent></Card>}
    <AlertDialog open={deleting} onOpenChange={(open) => { if (busy !== 'delete') setDeleting(open); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>移除「{channel.name}」？</AlertDialogTitle><AlertDialogDescription>此渠道及其配置将被删除，此操作无法撤销。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={Boolean(busy)}>取消</AlertDialogCancel><AlertDialogAction disabled={Boolean(busy)} onClick={(event) => { event.preventDefault(); void action('delete', async () => { await api(`/merchant/channels/${channelId}`, { method: 'DELETE' }); toast.success('渠道已移除。'); router.push(`/merchant/sites/${site.id}`); router.refresh(); }); }}>{busy === 'delete' ? '正在移除…' : '确认移除'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}
