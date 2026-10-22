'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { PencilSimpleIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import type { AdminOverview, AdminSite, AdminUser, FeedbackItem, AdminReview, AuditLog, MerchantChannel, ChannelInput, ProbeRun, ProbeTask, Role, UserStatus, ProbeKind } from '@hub/shared';
import { PROTOCOL_LABELS } from '@hub/shared';
import { apiWithHeaders, apiNoticeMessage } from '@/lib/api/client';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Form } from '@/components/ui/form';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AdminInput, AdminSelect, AdminSwitch, numberText, requiredText, urlText } from './form-fields';
import { AdminTable, MutationButton, RecordLink, DateValue, Status, actionRowStyle, kindLabels, triggerLabels } from './common';

export function SiteTable({ items, review = false }: { items: AdminSite[]; review?: boolean }) {
  return <AdminTable items={items} empty={review ? '当前没有待审核的入驻申请' : undefined} columns={[
    { label: '站点', render: item => <><RecordLink href={`/admin/sites/${item.id}`}>{item.name}</RecordLink><div className="max-w-52 truncate text-xs text-muted-foreground">{item.homepageUrl}</div></> },
    { label: '站长', render: item => <><div>{item.owner.nickname}</div><span className="text-xs text-muted-foreground">{item.owner.email}</span></> },
    { label: '状态', render: item => <Status value={item.status} /> },
    { label: '渠道 / 充值倍率', render: item => <span className="font-mono tabular-nums">{item.channelCount} / {item.rechargeRatio.toFixed(3)}</span> },
    { label: '提交时间', render: item => <DateValue value={item.submittedAt} /> },
    { label: '操作', render: item => <RecordLink href={`/admin/sites/${item.id}`}>{review ? '审阅申请' : '管理站点'}</RecordLink> },
  ]} />;
}

const channelSchema = z.object({
  name: requiredText('渠道名称', 100), baseUrl: urlText('上游地址', false), apiKey: z.string().max(500, 'API Key 最多 500 位').refine(value => value.length === 0 || value.trim().length >= 8, 'API Key 长度至少 8 位'),
  protocol: z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini']), primaryModel: requiredText('主测模型', 200), backupModel: z.string().max(200),
  groupRatio: numberText('分组倍率', 0.00001, 1000), rpmLimit: numberText('RPM 限制', 1, Number.MAX_SAFE_INTEGER, true, true), billingType: z.enum(['per_token', 'per_request', 'subscription']),
  status: z.enum(['active', 'paused', 'invalid']), probeEnabled: z.boolean(), probeIntervalSec: numberText('探测间隔', 30, 86400, true),
});
type ChannelFields = z.infer<typeof channelSchema>;
function ChannelEditor({ item }: { item: MerchantChannel }) {
  const router = useRouter(); const [open, setOpen] = useState(false);
  const form = useForm<ChannelFields>({ resolver: zodResolver(channelSchema), defaultValues: { name: item.name, baseUrl: item.baseUrl, apiKey: '', protocol: item.protocol, primaryModel: item.primaryModel, backupModel: item.backupModel ?? '', groupRatio: String(item.groupRatio), rpmLimit: item.rpmLimit == null ? '' : String(item.rpmLimit), billingType: item.billingType, status: item.status, probeEnabled: item.probeEnabled, probeIntervalSec: String(item.probeIntervalSec) } });
  async function save(values: ChannelFields) {
    const key = values.apiKey.trim();
    const body: Partial<ChannelInput & Pick<MerchantChannel, 'status' | 'probeEnabled' | 'probeIntervalSec'>> = { ...values, groupRatio: Number(values.groupRatio), rpmLimit: values.rpmLimit ? Number(values.rpmLimit) : null, probeIntervalSec: Number(values.probeIntervalSec), backupModel: values.backupModel.trim() || null, ...(key ? { apiKey: key } : { apiKey: undefined }) };
    try { const { headers } = await apiWithHeaders<unknown>(`/admin/channels/${item.id}`, { method: 'PATCH', body: JSON.stringify(body) }); toast.success(apiNoticeMessage(headers) ?? '渠道配置已保存'); setOpen(false); form.setValue('apiKey', ''); router.refresh(); }
    catch (error) { toast.error(error instanceof Error ? error.message : '保存失败，请稍后重试'); }
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline" size="sm"><PencilSimpleIcon />编辑</Button></DialogTrigger><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>编辑渠道 · {item.name}</DialogTitle><DialogDescription>只有接口地址、API Key、协议或主测模型变化会重新检测。倍率修改只更新价格。</DialogDescription></DialogHeader><Form {...form}><form onSubmit={form.handleSubmit(save)} className="space-y-5"><div className="grid gap-4 sm:grid-cols-2">
    <AdminInput control={form.control} name="name" label="渠道名称" /><AdminInput control={form.control} name="baseUrl" label="上游地址" type="url" />
    <AdminInput control={form.control} name="apiKey" label="更新检测密钥" type="password" placeholder={`留空保留 ${item.apiKeyMask}`} description="留空保持原密钥；新密钥至少 8 位。" />
    <AdminSelect control={form.control} name="protocol" label="协议" options={Object.entries(PROTOCOL_LABELS).map(([value, label]) => ({ value, label }))} />
    <AdminInput control={form.control} name="primaryModel" label="主测模型" /><AdminInput control={form.control} name="backupModel" label="备用模型" />
    <AdminInput control={form.control} name="rpmLimit" label="每分钟请求上限" type="number" min={1} step={1} />
    <AdminSelect control={form.control} name="billingType" label="计费方式" options={[{ value: 'per_token', label: '按 Token' }, { value: 'per_request', label: '按次' }, { value: 'subscription', label: '订阅' }]} />
    <AdminInput control={form.control} name="groupRatio" label="分组倍率" type="number" min={0.00001} step="any" /><AdminInput control={form.control} name="probeIntervalSec" label="探测间隔（秒）" type="number" min={30} max={86400} step={1} />
    <AdminSelect control={form.control} name="status" label="渠道状态" options={[{ value: 'active', label: '活跃' }, { value: 'paused', label: '暂停' }, { value: 'invalid', label: '失效' }]} /><AdminSwitch control={form.control} name="probeEnabled" label="启用定时探测" />
    </div><div className="flex justify-end gap-2"><Button variant="outline" type="button" onClick={() => setOpen(false)}>取消</Button><Button disabled={form.formState.isSubmitting}>{form.formState.isSubmitting && <SpinnerGapIcon className="animate-spin" />}保存渠道</Button></div></form></Form></DialogContent></Dialog>;
}

export function ChannelsTable({ items }: { items: MerchantChannel[] }) {
  return <AdminTable items={items} searchText={item => `${item.id} ${item.name} ${item.primaryModel} ${item.baseUrl}`} statusOf={item => item.status} statuses={[{ value: 'active', label: '活跃' }, { value: 'paused', label: '暂停' }, { value: 'invalid', label: '失效' }]} columns={[
    { label: '渠道', render: item => <><RecordLink href={`/channels/${item.id}`}>{item.name}</RecordLink><div className="font-mono text-xs tabular-nums text-muted-foreground">#{item.id} · 站点 #{item.siteId}</div></> },
    { label: '模型 / 协议', render: item => <><div>{item.primaryModel}</div><div className="text-xs text-muted-foreground">{PROTOCOL_LABELS[item.protocol]}</div></> },
    { label: '状态', render: item => <Status value={item.status} /> },
    { label: '可用率 / 可信分', render: item => <span className="font-mono tabular-nums">{item.stats?.uptime24h == null ? '—' : `${(item.stats.uptime24h * 100).toFixed(1)}%`} / {item.stats?.trustScore ?? '—'}</span> },
    { label: '探测配置', render: item => <span className="font-mono tabular-nums">{item.probeEnabled ? `${item.probeIntervalSec}s` : '已暂停'}</span> },
    { label: '操作', render: item => <div style={actionRowStyle}><ChannelEditor key={item.updatedAt} item={item} />{(['availability', 'authenticity', 'discovery'] as ProbeKind[]).map(kind => <MutationButton key={kind} path={`/admin/channels/${item.id}/probe`} method="POST" body={{ kind }}>{kind === 'availability' ? '探测' : kind === 'authenticity' ? '真伪检测' : '获取模型'}</MutationButton>)}<RecordLink href={`/admin/probe-runs?channelId=${item.id}`}>日志</RecordLink></div> },
  ]} />;
}

export function RunsTable({ items }: { items: ProbeRun[] }) {
  return <AdminTable items={items} searchText={item => `${item.channelId} ${item.model} ${item.errorCode ?? ''} ${item.errorMessage ?? ''}`} statusOf={item => String(item.success)} statuses={[{ value: 'true', label: '成功' }, { value: 'false', label: '失败' }]} columns={[
    { label: '渠道 / 模型', render: item => <><RecordLink href={`/channels/${item.channelId}`}>渠道 #{item.channelId}</RecordLink><div className="text-xs text-muted-foreground">{item.model}</div></> },
    { label: '结果', render: item => <Status value={item.success ? 'pass' : 'fail'} /> },
    { label: '类型 / 触发', render: item => <><div>{{ availability: '可用性', authenticity: '真伪检测', discovery: '模型发现' }[item.kind]}</div><div className="text-xs text-muted-foreground">{triggerLabels[item.trigger] ?? '系统任务'}</div></> },
    { label: '延迟 / 首 Token', render: item => <span className="font-mono tabular-nums">{item.latencyMs ?? '—'} / {item.ttftMs ?? '—'} ms</span> },
    { label: '错误详情', render: item => <div style={{ maxWidth: 320, whiteSpace: 'normal' }}><span className="font-mono tabular-nums">{item.httpStatus ?? '—'} {item.errorCode}</span><div className="text-xs text-muted-foreground">{item.errorMessage ?? '—'}</div></div> },
    { label: '时间', render: item => <DateValue value={item.createdAt} /> },
  ]} />;
}

export function FailureTable({ items }: { items: AdminOverview['recentFailures'] }) {
  return <AdminTable items={items} searchText={item => `${item.siteName} ${item.channelName} ${item.errorMessage ?? ''}`} columns={[
    { label: '站点 / 渠道', render: item => <><div>{item.siteName}</div><RecordLink href={`/admin/probe-runs?channelId=${item.channelId}`}>{item.channelName}</RecordLink></> },
    { label: '错误', render: item => <><div className="font-mono tabular-nums">{item.errorCode}</div><div className="text-xs text-muted-foreground" style={{ whiteSpace: 'normal', maxWidth: 380 }}>{item.errorMessage}</div></> },
    { label: '时间', render: item => <DateValue value={item.createdAt} /> },
  ]} />;
}

export function TasksTable({ items }: { items: ProbeTask[] }) {
  const router = useRouter();
  const hasPending = items.some(item => item.status === 'queued' || item.status === 'running');
  useEffect(() => { if (!hasPending) return; const timer = window.setInterval(() => router.refresh(), 5000); return () => window.clearInterval(timer); }, [hasPending, router]);
  return <AdminTable items={items} searchText={item => `${item.id} ${item.channelId} ${item.kind} ${item.error ?? ''}`} statusOf={item => item.status} statuses={[{ value: 'queued', label: '排队中' }, { value: 'running', label: '运行中' }, { value: 'done', label: '已完成' }, { value: 'failed', label: '失败' }, { value: 'canceled', label: '已取消' }]} columns={[
    { label: '任务 / 渠道', render: item => <><span className="font-mono tabular-nums">#{item.id}</span><div><RecordLink href={`/channels/${item.channelId}`}>渠道 #{item.channelId}</RecordLink></div></> },
    { label: '类型', render: item => <>{kindLabels[item.kind]}<div className="text-xs text-muted-foreground">{triggerLabels[item.trigger] ?? '系统任务'}</div></> },
    { label: '状态', render: item => <Status value={item.status} /> },
    { label: '模型 / 错误', render: item => <div style={{ maxWidth: 340, whiteSpace: 'normal' }}>{item.payload.models?.join(', ') || '主测模型'}<div className="text-xs text-muted-foreground">{item.error}</div></div> },
    { label: '创建 / 完成时间', render: item => <><DateValue value={item.createdAt} /><div><DateValue value={item.finishedAt} /></div></> },
  ]} />;
}

export function UsersTable({ items }: { items: AdminUser[] }) {
  return <AdminTable items={items} searchText={item => `${item.nickname} ${item.email}`} statusOf={item => item.role} statuses={[{ value: 'user', label: '普通用户' }, { value: 'merchant', label: '站长' }, { value: 'admin', label: '管理员' }]} columns={[
    { label: '用户', render: item => <><div>{item.nickname}</div><span className="text-xs text-muted-foreground">{item.email}</span></> },
    { label: '角色 / 状态', render: item => <><Status value={item.role} /> <Status value={item.status} /></> },
    { label: '站点数', render: item => <span className="font-mono tabular-nums">{item.siteCount}</span> },
    { label: '最近登录', render: item => <DateValue value={item.lastLoginAt} /> },
    { label: '管理', render: item => <div style={actionRowStyle}>{(['user', 'merchant', 'admin'] as Role[]).filter(role => role !== item.role).map(role => <MutationButton key={role} path={`/admin/users/${item.id}`} body={{ role }} confirmation={`确定将 ${item.nickname} 的角色改为${{ user: '普通用户', merchant: '站长', admin: '管理员' }[role]}？`}>设为{{ user: '用户', merchant: '站长', admin: '管理员' }[role]}</MutationButton>)}<MutationButton path={`/admin/users/${item.id}`} body={{ status: (item.status === 'banned' ? 'active' : 'banned') satisfies UserStatus }} confirmation={item.status === 'banned' ? undefined : `确定封禁 ${item.nickname}？`}>{item.status === 'banned' ? '解除封禁' : '封禁'}</MutationButton></div> },
  ]} />;
}

export function FeedbackTable({ items }: { items: FeedbackItem[] }) {
  return <AdminTable items={items} searchText={item => `${item.content} ${item.siteName ?? ''} ${item.contact ?? ''}`} statusOf={item => item.status} statuses={[{ value: 'new', label: '待阅读' }, { value: 'read', label: '已阅读' }, { value: 'handled', label: '已处理' }]} columns={[
    { label: '类型 / 站点', render: item => <><div>{{ recommend_site: '收录推荐', suggestion: '建议', complaint: '投诉', bug: '问题反馈' }[item.type]}</div><span className="text-xs text-muted-foreground">{item.siteName ?? '—'}</span></> },
    { label: '反馈内容', render: item => <div style={{ minWidth: 200, maxWidth: 430, whiteSpace: 'normal' }}>{item.content}{item.siteUrl && <div className="text-xs text-muted-foreground">{item.siteUrl}</div>}</div> },
    { label: '提交人 / 联系方式', render: item => <>{item.user?.nickname ?? '游客'}<div className="text-xs text-muted-foreground">{item.contact ?? '未提供'}</div></> },
    { label: '状态', render: item => <Status value={item.status} /> },
    { label: '时间', render: item => <DateValue value={item.createdAt} /> },
    { label: '处理', render: item => <div style={actionRowStyle}>{item.status === 'new' && <MutationButton path={`/admin/feedback/${item.id}`} body={{ status: 'read' }}>标记已读</MutationButton>}{item.status !== 'handled' && <MutationButton path={`/admin/feedback/${item.id}`} body={{ status: 'handled' }}>处理完成</MutationButton>}</div> },
  ]} />;
}

export function RatingsTable({ items }: { items: AdminReview[] }) {
  return <AdminTable items={items} searchText={item => `${item.site.name} ${item.user.nickname} ${item.content}`} statusOf={item => item.status} statuses={[{ value: 'visible', label: '公开' }, { value: 'hidden', label: '隐藏' }]} columns={[
    { label: '站点 / 用户', render: item => <><RecordLink href={`/sites/${item.site.slug}`}>{item.site.name}</RecordLink><div className="text-xs text-muted-foreground">{item.user.nickname}</div></> },
    { label: '评分', render: item => <span className="font-mono tabular-nums">{item.rating} / 5</span> },
    { label: '评价内容', render: item => <div style={{ maxWidth: 440, whiteSpace: 'normal' }}>{item.content}</div> },
    { label: '状态', render: item => <Status value={item.status} /> },
    { label: '时间', render: item => <DateValue value={item.createdAt} /> },
    { label: '管理', render: item => <MutationButton path={`/admin/reviews/${item.id}`} body={{ status: item.status === 'visible' ? 'hidden' : 'visible' }}>{item.status === 'visible' ? '隐藏评价' : '恢复公开'}</MutationButton> },
  ]} />;
}

export function AuditTable({ items }: { items: AuditLog[] }) {
  return <AdminTable items={items} searchText={item => `${item.action} ${item.actor?.email ?? ''} ${item.targetId} ${item.targetType}`} statusOf={item => item.targetType}  columns={[
    { label: '操作', render: item => <span className="font-mono tabular-nums">{auditLabels[item.action] ?? '管理操作'}</span> },
    { label: '操作人', render: item => <>{item.actor?.nickname ?? '系统'}<div className="text-xs text-muted-foreground">{item.actor?.email ?? '自动任务'}</div></> },
    { label: '目标', render: item => <span className="font-mono tabular-nums">{targetLabels[item.targetType] ?? '记录'} #{item.targetId}</span> },
    { label: '变更详情', render: item => <AuditDetails item={item} /> },
    { label: '来源 IP', render: item => <span className="font-mono tabular-nums">{item.ip ?? '—'}</span> },
    { label: '时间', render: item => <DateValue value={item.createdAt} /> },
  ]} />;
}

const targetLabels: Record<string, string> = { site: '站点', channel: '渠道', user: '用户', vendor: '厂商', model: '模型', settings: '设置', announcement: '公告', review: '评价', feedback: '反馈' };
const auditLabels: Record<string, string> = { 'site.approve': '通过入驻审核', 'site.reject': '驳回入驻申请', 'site.suspend': '下架站点', 'site.restore': '恢复站点', 'site.update': '更新站点', 'channel.update': '更新渠道', 'user.update': '更新用户', 'settings.update': '更新系统设置', 'review.update': '更新评价状态', 'feedback.update': '更新反馈状态', 'vendor.create': '创建厂商', 'vendor.update': '更新厂商', 'vendor.delete': '删除厂商', 'model.create': '创建模型', 'model.update': '更新模型', 'model.delete': '删除模型', 'announcement.create': '创建公告', 'announcement.update': '更新公告', 'announcement.delete': '删除公告' };
function AuditDetails({ item }: { item: AuditLog }) { return <Dialog><DialogTrigger asChild><Button variant="ghost" size="sm">查看变更</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>审计变更详情</DialogTitle><DialogDescription>{auditLabels[item.action] ?? '管理操作'} · {targetLabels[item.targetType] ?? '记录'} #{item.targetId}</DialogDescription></DialogHeader><pre className="max-h-96 overflow-auto rounded-lg bg-muted p-4 font-mono text-xs">{JSON.stringify(item.meta, null, 2)}</pre></DialogContent></Dialog>; }
