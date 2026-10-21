'use client';

import { useEffect, useState } from 'react';
import type { AdminOverview, AdminSite, AdminUser, FeedbackItem, AdminReview, AuditLog, MerchantChannel, ChannelInput, ChannelProtocol, BillingType, ProbeRun, ProbeTask, Role, UserStatus, ChannelStatus, ProbeKind } from '@hub/shared';
import { SITE_STATUS_LABELS, PROTOCOL_LABELS } from '@hub/shared';
import { api, apiWithHeaders, apiNoticeMessage } from '@/lib/api/client';
import {apiKeyInputValidation, apiKeyTooShort, API_KEY_LENGTH_ERROR} from '@/lib/api-key';
import { useRouter } from 'next/navigation';
import { AdminTable, MutationButton, RecordLink, DateValue, Status, actionRowStyle } from './common';

export function SiteTable({ items, review = false }: { items: AdminSite[]; review?: boolean }) {
  return <AdminTable items={items} searchText={item => `${item.name} ${item.slug} ${item.owner.email}`} statusOf={item => item.status} statuses={Object.entries(SITE_STATUS_LABELS).map(([value, label]) => ({ value, label }))} empty={review ? '当前没有待审核的入驻申请' : undefined} columns={[
    { label: '站点', render: item => <><RecordLink href={`/admin/sites/${item.id}`}>{item.name}</RecordLink><div className="muted">{item.homepageUrl}</div></> },
    { label: '站长', render: item => <><div>{item.owner.nickname}</div><span className="muted">{item.owner.email}</span></> },
    { label: '状态', render: item => <Status value={item.status} /> },
    { label: '渠道 / 充值倍率', render: item => <span className="mono">{item.channelCount} / {item.rechargeRatio.toFixed(3)}</span> },
    { label: '提交时间', render: item => <DateValue value={item.submittedAt} /> },
    { label: '操作', render: item => <RecordLink href={`/admin/sites/${item.id}`}>{review ? '审阅申请' : '管理站点'}</RecordLink> },
  ]} />;
}

function ChannelEditor({ item }: { item: MerchantChannel }) {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  async function save(form: FormData) {
    setPending(true); setMessage('');
    try {
      const key = String(form.get('apiKey') ?? '').trim();
      if (apiKeyTooShort(key, true)) { setMessage(API_KEY_LENGTH_ERROR); return; }
      const body: Partial<ChannelInput & Pick<MerchantChannel, 'status' | 'probeEnabled' | 'probeIntervalSec'>> = { name: String(form.get('name')), baseUrl: String(form.get('baseUrl')), groupRatio: Number(form.get('groupRatio')), primaryModel: String(form.get('primaryModel')), backupModel: String(form.get('backupModel') ?? '').trim() || null, rpmLimit: form.get('rpmLimit') ? Number(form.get('rpmLimit')) : null, protocol: String(form.get('protocol')) as ChannelProtocol, billingType: String(form.get('billingType')) as BillingType, status: String(form.get('status')) as ChannelStatus, probeEnabled: form.get('probeEnabled') === 'on', probeIntervalSec: Number(form.get('probeIntervalSec')), ...(key ? { apiKey: key } : {}) };
      const {headers} = await apiWithHeaders<unknown>(`/admin/channels/${item.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setMessage(apiNoticeMessage(headers) ?? '渠道已保存。仅接口地址、API Key、协议或主测模型变化会重新检测；倍率修改只更新价格。'); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); } finally { setPending(false); }
  }
  return <details><summary className="btn btn-small">编辑</summary><form action={save} className="stack panel" style={{ minWidth: 280, marginTop: 12 }}>
    <label className="field">渠道名称<input className="input" name="name" required defaultValue={item.name} /></label>
    <label className="field">上游地址<input className="input" name="baseUrl" type="url" required defaultValue={item.baseUrl} /></label>
    <label className="field">更新检测密钥<input className="input" name="apiKey" type="password" {...apiKeyInputValidation} autoComplete="new-password" placeholder={`留空保持 ${item.apiKeyMask}`} /></label>
    <label className="field">协议<select className="select" name="protocol" defaultValue={item.protocol}>{Object.entries(PROTOCOL_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    <label className="field">主测模型<input className="input" name="primaryModel" required defaultValue={item.primaryModel} /></label>
    <label className="field">备用模型<input className="input" name="backupModel" defaultValue={item.backupModel ?? ''} /></label>
    <label className="field">RPM 限制<input className="input mono" name="rpmLimit" type="number" min="1" step="1" defaultValue={item.rpmLimit ?? ''} /></label>
    <label className="field">计费方式<select className="select" name="billingType" defaultValue={item.billingType}><option value="per_token">按 Token</option><option value="per_request">按次</option><option value="subscription">订阅</option></select></label>
    <label className="field">分组倍率<input className="input mono" name="groupRatio" type="number" min="0.0001" step="0.0001" required defaultValue={item.groupRatio} /></label>
    <label className="field">探测间隔（秒）<input className="input mono" name="probeIntervalSec" type="number" min="30" max="86400" required defaultValue={item.probeIntervalSec} /></label>
    <label className="field">状态<select className="select" name="status" defaultValue={item.status}><option value="active">活跃</option><option value="paused">暂停</option><option value="invalid">失效</option></select></label>
    <label className="row"><input type="checkbox" name="probeEnabled" defaultChecked={item.probeEnabled} />启用定时探测</label>
    <p className="muted" style={{fontSize:12}}>修改接口地址、API Key、协议或主测模型后会重新检测；倍率和资料修改不触发检测。</p>
    <button className="btn btn-primary" disabled={pending}>{pending ? '保存中…' : '保存渠道'}</button>{message && <p role="status" className="muted">{message}</p>}
  </form></details>;
}

export function ChannelsTable({ items }: { items: MerchantChannel[] }) {
  return <AdminTable items={items} searchText={item => `${item.id} ${item.name} ${item.primaryModel} ${item.baseUrl}`} statusOf={item => item.status} statuses={[{ value: 'active', label: '活跃' }, { value: 'paused', label: '暂停' }, { value: 'invalid', label: '失效' }]} columns={[
    { label: '渠道', render: item => <><RecordLink href={`/channels/${item.id}`}>{item.name}</RecordLink><div className="muted mono">#{item.id} · 站点 #{item.siteId}</div></> },
    { label: '模型 / 协议', render: item => <><div>{item.primaryModel}</div><div className="muted">{PROTOCOL_LABELS[item.protocol]}</div></> },
    { label: '状态', render: item => <Status value={item.status} /> },
    { label: '可用率 / 可信分', render: item => <span className="mono">{item.stats?.uptime24h == null ? '—' : `${(item.stats.uptime24h * 100).toFixed(1)}%`} / {item.stats?.trustScore ?? '—'}</span> },
    { label: '探测配置', render: item => <span className="mono">{item.probeEnabled ? `${item.probeIntervalSec}s` : '已暂停'}</span> },
    { label: '操作', render: item => <div style={actionRowStyle}><ChannelEditor item={item} />{(['availability', 'authenticity', 'discovery'] as ProbeKind[]).map(kind => <MutationButton key={kind} path={`/admin/channels/${item.id}/probe`} method="POST" body={{ kind }}>{kind === 'availability' ? '探测' : kind === 'authenticity' ? '真伪检测' : '获取模型'}</MutationButton>)}<RecordLink href={`/admin/probe-runs?channelId=${item.id}`}>日志</RecordLink></div> },
  ]} />;
}

export function RunsTable({ items }: { items: ProbeRun[] }) {
  return <AdminTable items={items} searchText={item => `${item.channelId} ${item.model} ${item.errorCode ?? ''} ${item.errorMessage ?? ''}`} statusOf={item => String(item.success)} statuses={[{ value: 'true', label: '成功' }, { value: 'false', label: '失败' }]} columns={[
    { label: '渠道 / 模型', render: item => <><RecordLink href={`/channels/${item.channelId}`}>渠道 #{item.channelId}</RecordLink><div className="muted">{item.model}</div></> },
    { label: '结果', render: item => <Status value={item.success ? 'pass' : 'fail'} /> },
    { label: '类型 / 触发', render: item => <><div>{{ availability: '可用性', authenticity: '真伪检测', discovery: '模型发现' }[item.kind]}</div><div className="muted">{item.trigger}</div></> },
    { label: '延迟 / 首 Token', render: item => <span className="mono">{item.latencyMs ?? '—'} / {item.ttftMs ?? '—'} ms</span> },
    { label: '错误详情', render: item => <div style={{ maxWidth: 320, whiteSpace: 'normal' }}><span className="mono">{item.httpStatus ?? '—'} {item.errorCode}</span><div className="muted">{item.errorMessage ?? '—'}</div></div> },
    { label: '时间', render: item => <DateValue value={item.createdAt} /> },
  ]} />;
}

export function FailureTable({ items }: { items: AdminOverview['recentFailures'] }) {
  return <AdminTable items={items} searchText={item => `${item.siteName} ${item.channelName} ${item.errorMessage ?? ''}`} columns={[
    { label: '站点 / 渠道', render: item => <><div>{item.siteName}</div><RecordLink href={`/admin/probe-runs?channelId=${item.channelId}`}>{item.channelName}</RecordLink></> },
    { label: '错误', render: item => <><div className="mono">{item.errorCode}</div><div className="muted" style={{ whiteSpace: 'normal', maxWidth: 380 }}>{item.errorMessage}</div></> },
    { label: '时间', render: item => <DateValue value={item.createdAt} /> },
  ]} />;
}

export function TasksTable({ items }: { items: ProbeTask[] }) {
  const router = useRouter();
  const hasPending = items.some(item => item.status === 'queued' || item.status === 'running');
  useEffect(() => { if (!hasPending) return; const timer = window.setInterval(() => router.refresh(), 5000); return () => window.clearInterval(timer); }, [hasPending, router]);
  return <AdminTable items={items} searchText={item => `${item.id} ${item.channelId} ${item.kind} ${item.error ?? ''}`} statusOf={item => item.status} statuses={[{ value: 'queued', label: '排队中' }, { value: 'running', label: '运行中' }, { value: 'done', label: '已完成' }, { value: 'failed', label: '失败' }, { value: 'canceled', label: '已取消' }]} columns={[
    { label: '任务 / 渠道', render: item => <><span className="mono">#{item.id}</span><div><RecordLink href={`/channels/${item.channelId}`}>渠道 #{item.channelId}</RecordLink></div></> },
    { label: '类型', render: item => <>{item.kind}<div className="muted">{item.trigger}</div></> },
    { label: '状态', render: item => <Status value={item.status} /> },
    { label: '模型 / 错误', render: item => <div style={{ maxWidth: 340, whiteSpace: 'normal' }}>{item.payload.models?.join(', ') || '主测模型'}<div className="muted">{item.error}</div></div> },
    { label: '创建 / 完成时间', render: item => <><DateValue value={item.createdAt} /><div><DateValue value={item.finishedAt} /></div></> },
  ]} />;
}

export function UsersTable({ items }: { items: AdminUser[] }) {
  return <AdminTable items={items} searchText={item => `${item.nickname} ${item.email}`} statusOf={item => item.role} statuses={[{ value: 'user', label: '普通用户' }, { value: 'merchant', label: '站长' }, { value: 'admin', label: '管理员' }]} columns={[
    { label: '用户', render: item => <><div>{item.nickname}</div><span className="muted">{item.email}</span></> },
    { label: '角色 / 状态', render: item => <><Status value={item.role} /> <Status value={item.status} /></> },
    { label: '站点数', render: item => <span className="mono">{item.siteCount}</span> },
    { label: '最近登录', render: item => <DateValue value={item.lastLoginAt} /> },
    { label: '管理', render: item => <div style={actionRowStyle}>{(['user', 'merchant', 'admin'] as Role[]).filter(role => role !== item.role).map(role => <MutationButton key={role} path={`/admin/users/${item.id}`} body={{ role }} confirmation={`确定将 ${item.nickname} 的角色改为${{ user: '普通用户', merchant: '站长', admin: '管理员' }[role]}？`}>设为{{ user: '用户', merchant: '站长', admin: '管理员' }[role]}</MutationButton>)}<MutationButton path={`/admin/users/${item.id}`} body={{ status: (item.status === 'banned' ? 'active' : 'banned') satisfies UserStatus }} confirmation={item.status === 'banned' ? undefined : `确定封禁 ${item.nickname}？`}>{item.status === 'banned' ? '解除封禁' : '封禁'}</MutationButton></div> },
  ]} />;
}

export function FeedbackTable({ items }: { items: FeedbackItem[] }) {
  return <AdminTable items={items} searchText={item => `${item.content} ${item.siteName ?? ''} ${item.contact ?? ''}`} statusOf={item => item.status} statuses={[{ value: 'new', label: '待阅读' }, { value: 'read', label: '已阅读' }, { value: 'handled', label: '已处理' }]} columns={[
    { label: '类型 / 站点', render: item => <><div>{{ recommend_site: '收录推荐', suggestion: '建议', complaint: '投诉', bug: '问题反馈' }[item.type]}</div><span className="muted">{item.siteName ?? '—'}</span></> },
    { label: '反馈内容', render: item => <div style={{ minWidth: 200, maxWidth: 430, whiteSpace: 'normal' }}>{item.content}{item.siteUrl && <div className="muted">{item.siteUrl}</div>}</div> },
    { label: '提交人 / 联系方式', render: item => <>{item.user?.nickname ?? '游客'}<div className="muted">{item.contact ?? '未提供'}</div></> },
    { label: '状态', render: item => <Status value={item.status} /> },
    { label: '时间', render: item => <DateValue value={item.createdAt} /> },
    { label: '处理', render: item => <div style={actionRowStyle}>{item.status === 'new' && <MutationButton path={`/admin/feedback/${item.id}`} body={{ status: 'read' }}>标记已读</MutationButton>}{item.status !== 'handled' && <MutationButton path={`/admin/feedback/${item.id}`} body={{ status: 'handled' }}>处理完成</MutationButton>}</div> },
  ]} />;
}

export function RatingsTable({ items }: { items: AdminReview[] }) {
  return <AdminTable items={items} searchText={item => `${item.site.name} ${item.user.nickname} ${item.content}`} statusOf={item => item.status} statuses={[{ value: 'visible', label: '公开' }, { value: 'hidden', label: '隐藏' }]} columns={[
    { label: '站点 / 用户', render: item => <><RecordLink href={`/sites/${item.site.slug}`}>{item.site.name}</RecordLink><div className="muted">{item.user.nickname}</div></> },
    { label: '评分', render: item => <span className="mono">{item.rating} / 5</span> },
    { label: '评价内容', render: item => <div style={{ maxWidth: 440, whiteSpace: 'normal' }}>{item.content}</div> },
    { label: '状态', render: item => <Status value={item.status} /> },
    { label: '时间', render: item => <DateValue value={item.createdAt} /> },
    { label: '管理', render: item => <MutationButton path={`/admin/reviews/${item.id}`} body={{ status: item.status === 'visible' ? 'hidden' : 'visible' }}>{item.status === 'visible' ? '隐藏评价' : '恢复公开'}</MutationButton> },
  ]} />;
}

export function AuditTable({ items }: { items: AuditLog[] }) {
  return <AdminTable items={items} searchText={item => `${item.action} ${item.actor?.email ?? ''} ${item.targetId} ${item.targetType}`} statusOf={item => item.targetType} statuses={[...new Set(items.map(item => item.targetType))].map(value => ({ value, label: value }))} columns={[
    { label: '操作', render: item => <span className="mono">{item.action}</span> },
    { label: '操作人', render: item => <>{item.actor?.nickname ?? '系统'}<div className="muted">{item.actor?.email ?? '自动任务'}</div></> },
    { label: '目标', render: item => <span className="mono">{item.targetType} #{item.targetId}</span> },
    { label: '变更详情', render: item => <details><summary>查看详情</summary><pre style={{ maxWidth: 360, overflow: 'auto' }}>{JSON.stringify(item.meta, null, 2)}</pre></details> },
    { label: '来源 IP', render: item => <span className="mono">{item.ip ?? '—'}</span> },
    { label: '时间', render: item => <DateValue value={item.createdAt} /> },
  ]} />;
}
