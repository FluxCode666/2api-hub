'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { CheckCircleIcon, XCircleIcon, PauseCircleIcon, ArrowClockwiseIcon, FloppyDiskIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import type { AdminSiteDetail, SiteReviewAction, SiteInput } from '@hub/shared';
import { SITE_TYPE_LABELS, PROTOCOL_LABELS } from '@hub/shared';
import { apiWithHeaders, apiNoticeMessage } from '@/lib/api/client';
import { UptimeBar, TrustBadge } from '@/components/charts';
import { TrustStatus } from '@/components/trust-status';
import { toTrustReportBrief, trustModelDisplayName } from '@/lib/trust-report';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Form } from '@/components/ui/form';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { ChannelsTable } from './resources';
import { AdminTable, DataSummary, DateValue, ExternalLink, Status } from './common';
import { AdminInput, AdminSelect, AdminSwitch, AdminTextarea, numberText, requiredText, splitValues, urlText } from './form-fields';

const siteSchema = z.object({
  name: requiredText('站点名称', 100), slug: requiredText('链接标识', 100).regex(/^[a-z0-9-]+$/, '标识仅支持小写字母、数字和短横线'), homepageUrl: urlText('官方网站', false), inviteUrl: urlText('邀请链接'), logoUrl: urlText('标志网址'),
  type: z.enum(['new_api', 'sub2api', 'one_api', 'custom']), rechargeRatio: numberText('充值倍率', 0.00001, 1000), sortWeight: numberText('展示权重', -1000000, 1000000, true),
  tags: z.string().refine(value => { const items = splitValues(value); return items.length <= 10 && items.every(item => item.length <= 30); }, '最多 10 个标签，每个不超过 30 个字符'), paymentMethods: z.string().refine(value => { const items = splitValues(value); return items.length <= 10 && items.every(item => item.length <= 30); }, '最多 10 个支付方式，每个不超过 30 个字符'),
  contactEmail: z.string().max(100).refine(value => !value || z.email().safeParse(value).success, '请填写有效邮箱'), contactQq: z.string().max(50), contactWechat: z.string().max(50), contactTelegram: z.string().max(50), contactGroup: z.string().max(200),
  isVerified: z.boolean(), isFeatured: z.boolean(), description: z.string().max(2000, '简介最多 2000 个字符'),
});
type SiteFields = z.infer<typeof siteSchema>;
const reviewSchema = z.object({ action: z.enum(['approve', 'reject', 'suspend', 'restore']), reason: z.string().max(500, '审核意见最多 500 个字符') }).superRefine((values, ctx) => { if (['reject', 'suspend'].includes(values.action) && !values.reason.trim()) ctx.addIssue({ code: 'custom', path: ['reason'], message: '请填写原因，便于站长修正' }); });
const actionLabels = { approve: '审核通过并上线', reject: '驳回申请', suspend: '下架站点', restore: '恢复上线' };
function SiteSettings({ site }: { site: AdminSiteDetail }) {
  const router = useRouter(); const form = useForm<SiteFields>({ resolver: zodResolver(siteSchema), defaultValues: { name: site.name, slug: site.slug, homepageUrl: site.homepageUrl, inviteUrl: site.inviteUrl ?? '', logoUrl: site.logoUrl ?? '', type: site.type, rechargeRatio: String(site.rechargeRatio), sortWeight: String(site.sortWeight), tags: site.tags.join(', '), paymentMethods: site.paymentMethods.join(', '), contactEmail: site.contact.email ?? '', contactQq: site.contact.qq ?? '', contactWechat: site.contact.wechat ?? '', contactTelegram: site.contact.telegram ?? '', contactGroup: site.contact.group ?? '', isVerified: site.isVerified, isFeatured: site.isFeatured, description: site.description ?? '' } });
  async function save(values: SiteFields) {
    const contact = { email: values.contactEmail, qq: values.contactQq, wechat: values.contactWechat, telegram: values.contactTelegram, group: values.contactGroup };
    const body: SiteInput & Pick<AdminSiteDetail, 'isFeatured' | 'isVerified' | 'sortWeight'> = { name: values.name.trim(), slug: values.slug, homepageUrl: values.homepageUrl, inviteUrl: values.inviteUrl || null, logoUrl: values.logoUrl || null, description: values.description.trim() || null, type: values.type, rechargeRatio: Number(values.rechargeRatio), tags: splitValues(values.tags), paymentMethods: splitValues(values.paymentMethods), contact: Object.fromEntries(Object.entries(contact).filter(([, value]) => value.trim())), isFeatured: values.isFeatured, isVerified: values.isVerified, sortWeight: Number(values.sortWeight) };
    try { const { headers } = await apiWithHeaders<unknown>(`/admin/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify(body) }); toast.success(apiNoticeMessage(headers) ?? '站点资料已保存'); router.refresh(); }
    catch (error) { toast.error(error instanceof Error ? error.message : '保存失败，请稍后重试'); }
  }
  return <Card><CardHeader><CardTitle>站点资料与展示设置</CardTitle><CardDescription>资料与倍率修改立即生效，不触发连接检测。</CardDescription></CardHeader><CardContent><Form {...form}><form onSubmit={form.handleSubmit(save)} className="space-y-5"><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    <AdminInput control={form.control} name="name" label="站点名称" /><AdminInput control={form.control} name="slug" label="链接标识" /><AdminInput control={form.control} name="homepageUrl" label="官方网站" type="url" /><AdminInput control={form.control} name="inviteUrl" label="邀请链接" type="url" /><AdminInput control={form.control} name="logoUrl" label="标志网址" type="url" />
    <AdminSelect control={form.control} name="type" label="站点类型" options={Object.entries(SITE_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
    <AdminInput control={form.control} name="rechargeRatio" label="充值倍率" type="number" min={0.00001} step="any" description="每充值 1 元可获得的美元额度。" /><AdminInput control={form.control} name="sortWeight" label="展示权重" type="number" step={1} />
    <AdminInput control={form.control} name="tags" label="标签" description="使用逗号分隔，最多 10 个。" /><AdminInput control={form.control} name="paymentMethods" label="支付方式" description="使用逗号分隔，最多 10 个。" />
    <AdminInput control={form.control} name="contactEmail" label="联系邮箱" type="email" /><AdminInput control={form.control} name="contactQq" label="联系 QQ" /><AdminInput control={form.control} name="contactWechat" label="联系微信" /><AdminInput control={form.control} name="contactTelegram" label="Telegram 账号" /><AdminInput control={form.control} name="contactGroup" label="交流群" />
    <AdminSwitch control={form.control} name="isVerified" label="官方认证" /><AdminSwitch control={form.control} name="isFeatured" label="精选展示" />
    </div><AdminTextarea control={form.control} name="description" label="站点简介" /><Button disabled={form.formState.isSubmitting}>{form.formState.isSubmitting ? <SpinnerGapIcon className="animate-spin" /> : <FloppyDiskIcon />}保存资料</Button></form></Form></CardContent></Card>;
}


export function AdminSiteDetailView({ site }: { site: AdminSiteDetail }) {
  const router = useRouter(); const [reviewOpen, setReviewOpen] = useState(false); const form = useForm<z.infer<typeof reviewSchema>>({ resolver: zodResolver(reviewSchema), defaultValues: { action: 'approve', reason: '' } }); const action = form.watch('action');
  function openReview(next: SiteReviewAction['action']) { form.reset({ action: next, reason: '' }); setReviewOpen(true); }
  async function submitReview(values: z.infer<typeof reviewSchema>) {
    const body: SiteReviewAction = { action: values.action, ...(values.reason.trim() ? { reason: values.reason.trim() } : {}) };
    try { const { headers } = await apiWithHeaders<unknown>(`/admin/sites/${site.id}/review`, { method: 'POST', body: JSON.stringify(body) }); toast.success(apiNoticeMessage(headers) ?? '审核状态已更新'); setReviewOpen(false); router.refresh(); }
    catch (error) { toast.error(error instanceof Error ? error.message : '审核失败，请稍后重试'); }
  }
  return <div className="space-y-6">
    <Card><CardHeader><div className="flex items-start justify-between gap-4"><div className="space-y-2"><CardTitle>{site.name}</CardTitle><ExternalLink href={site.homepageUrl}>{site.homepageUrl}</ExternalLink></div><Status value={site.status} /></div></CardHeader><CardContent className="space-y-5"><dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4"><DataSummary label="站长" value={<>{site.owner.nickname}<p className="mt-1 text-xs text-muted-foreground">{site.owner.email}</p></>} /><DataSummary label="提交时间" value={<DateValue value={site.submittedAt} />} /><DataSummary label="上线时间" value={<DateValue value={site.approvedAt} />} /><DataSummary label="最近修改" value={<DateValue value={site.updatedAt} />} /></dl>
      {site.reviewNote && <Alert><AlertTitle>审核备注</AlertTitle><AlertDescription>{site.reviewNote}</AlertDescription></Alert>}
      <div className="flex flex-wrap gap-2">{site.status === 'pending' && <><Button onClick={() => openReview('approve')}><CheckCircleIcon />审核通过并上线</Button><Button variant="destructive" onClick={() => openReview('reject')}><XCircleIcon />驳回申请</Button></>}{site.status === 'approved' && <Button variant="destructive" onClick={() => openReview('suspend')}><PauseCircleIcon />下架站点</Button>}{site.status === 'suspended' && <Button onClick={() => openReview('restore')}><ArrowClockwiseIcon />恢复上线</Button>}</div>
    </CardContent></Card>
    <Dialog open={reviewOpen} onOpenChange={setReviewOpen}><DialogContent><DialogHeader><DialogTitle>{actionLabels[action]}</DialogTitle><DialogDescription>{action === 'approve' || action === 'restore' ? '确认后站点将公开展示，并按渠道配置执行定时探测。' : '请说明具体原因与修正建议，站长会收到通知。'}</DialogDescription></DialogHeader><Form {...form}><form onSubmit={form.handleSubmit(submitReview)} className="space-y-5"><AdminTextarea control={form.control} name="reason" label={action === 'reject' || action === 'suspend' ? '审核原因（必填）' : '审核备注（选填）'} /><div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setReviewOpen(false)}>取消</Button><Button variant={action === 'reject' || action === 'suspend' ? 'destructive' : 'default'} disabled={form.formState.isSubmitting}>{form.formState.isSubmitting && <SpinnerGapIcon className="animate-spin" />}确认{actionLabels[action]}</Button></div></form></Form></DialogContent></Dialog>
    <Card><CardHeader><CardTitle>渠道与连接检查</CardTitle><CardDescription>查看渠道配置、测试记录和模型状态。</CardDescription></CardHeader><CardContent className="space-y-5"><ChannelsTable items={site.channels.map(channel => ({ ...channel, site: { id: site.id, slug: site.slug, name: site.name, status: site.status } }))} /><Accordion type="multiple">{site.channels.map(channel => <AccordionItem key={channel.id} value={String(channel.id)}><AccordionTrigger>{channel.name} · 上游配置与模型</AccordionTrigger><AccordionContent className="space-y-5"><dl className="grid gap-4 sm:grid-cols-2"><DataSummary label="上游地址" value={<span className="break-all font-mono text-xs">{channel.baseUrl}</span>} /><DataSummary label="检测凭据" value={<span className="font-mono">{channel.apiKeyMask}</span>} /><DataSummary label="最近连接结果" value={<>{channel.lastTestOk === null ? '未测试' : channel.lastTestOk ? '连接成功' : '连接失败'} · <DateValue value={channel.lastTestAt} /></>} /><DataSummary label="备用模型 / 每分钟请求上限" value={`${channel.backupModel ?? '未设置'} / ${channel.rpmLimit ?? '未设置'}`} /></dl>{channel.stats && <UptimeBar points={channel.stats.sparkline} />}<AdminTable items={channel.models} columns={[
      { label: '上游模型', render: model => <span className="font-mono text-xs">{model.upstreamName}</span> }, { label: '标准模型', render: model => model.displayName ?? model.modelSlug ?? '未映射' }, { label: '最近测试', render: model => <Status value={model.lastStatus} /> }, { label: '可信分', render: model => <TrustBadge score={model.trustScore} verdict={model.trustVerdict} report={toTrustReportBrief(site.reports.find(report => report.channelId === channel.id && report.model === model.upstreamName) ?? null)} channelId={channel.id} basis="model" model={model.upstreamName} modelName={model.displayName??undefined} /> }, { label: '失败原因', render: model => <p className="max-w-md whitespace-normal text-xs text-muted-foreground">{model.lastError ?? '—'}</p> },
    ]} /></AccordionContent></AccordionItem>)}</Accordion></CardContent></Card>
    <Card><CardHeader><CardTitle>最近模型检测报告</CardTitle><CardDescription>检测得分用于辅助判断，请结合各项证据阅读。</CardDescription></CardHeader><CardContent>{site.reports.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">尚无检测报告，可在渠道操作中发起真伪检测。</p> : <Accordion type="multiple" defaultValue={[String(site.reports[0]?.id)]}>{site.reports.map((report, index) => <AccordionItem key={report.id ?? index} value={String(report.id ?? index)}><AccordionTrigger><span className="flex flex-wrap items-center gap-3"><span className="font-mono text-sm">{report.model}</span><span className="text-xs text-muted-foreground">{PROTOCOL_LABELS[report.protocol]}</span><TrustStatus score={report.score} verdict={report.verdict} /></span></AccordionTrigger><AccordionContent className="space-y-3"><AdminTable items={report.checks} columns={[
      { label: '检查项目', render: check => check.name }, { label: '结果', render: check => <Status value={check.passed === null ? 'untested' : check.passed ? 'pass' : 'fail'} /> }, { label: '权重', render: check => <span className="font-mono tabular-nums">{check.weight}</span> }, { label: '证据说明', render: check => <p className="max-w-2xl whitespace-normal">{check.detail}</p> },
    ]} /><p className="text-xs text-muted-foreground">耗时 {(report.durationMs / 1000).toFixed(1)} 秒 · <DateValue value={report.createdAt} /></p></AccordionContent></AccordionItem>)}</Accordion>}</CardContent></Card>
    <SiteSettings key={site.updatedAt} site={site} />
  </div>;
}
