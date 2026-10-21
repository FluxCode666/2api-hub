'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminSiteDetail, SiteReviewAction, SiteInput, SiteType } from '@hub/shared';
import { SITE_TYPE_LABELS, PROTOCOL_LABELS } from '@hub/shared';
import { api } from '@/lib/api/client';
import { ChannelsTable } from './resources';
import { DateValue, Status, actionRowStyle } from './common';
import { TrustBadge, UptimeBar } from '@/components/charts';

export function AdminSiteDetailView({ site }: { site: AdminSiteDetail }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  async function review(action: SiteReviewAction['action']) {
    if ((action === 'reject' || action === 'suspend') && !reason.trim()) { setMessage('请填写驳回或下架原因，便于站长修正。'); return; }
    setPending(true); setMessage('');
    try { const body: SiteReviewAction = { action, ...(reason.trim() ? { reason: reason.trim() } : {}) }; await api<unknown>(`/admin/sites/${site.id}/review`, { method: 'POST', body: JSON.stringify(body) }); setMessage('审核状态已更新'); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : '审核失败'); } finally { setPending(false); }
  }
  async function save(form: FormData) {
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const body: SiteInput & Pick<AdminSiteDetail, 'isFeatured' | 'isVerified' | 'sortWeight'> = {
      name: text('name'), slug: text('slug'), homepageUrl: text('homepageUrl'), inviteUrl: text('inviteUrl') || null, logoUrl: text('logoUrl') || null, description: text('description') || null,
      type: text('type') as SiteType, rechargeRatio: Number(form.get('rechargeRatio')), tags: text('tags').split(',').map(value => value.trim()).filter(Boolean), paymentMethods: text('paymentMethods').split(',').map(value => value.trim()).filter(Boolean),
      contact: Object.fromEntries(['email', 'qq', 'wechat', 'telegram', 'group'].map(key => [key, text(`contact.${key}`)]).filter(([, value]) => value)),
      isFeatured: form.get('isFeatured') === 'on', isVerified: form.get('isVerified') === 'on', sortWeight: Number(form.get('sortWeight')),
    };
    setPending(true); setMessage('');
    try { await api<unknown>(`/admin/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify(body) }); setMessage('站点资料已保存'); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); } finally { setPending(false); }
  }
  return <div className="stack">
    <section className="panel stack"><div className="row between"><div><h2>{site.name}</h2><p className="muted">{site.homepageUrl}</p></div><Status value={site.status} /></div>
      <div className="form-grid"><div><span className="muted">站长</span><p>{site.owner.nickname} · {site.owner.email}</p></div><div><span className="muted">提交时间</span><p><DateValue value={site.submittedAt} /></p></div><div><span className="muted">上线时间</span><p><DateValue value={site.approvedAt} /></p></div><div><span className="muted">创建 / 最近修改</span><p><DateValue value={site.createdAt} /> / <DateValue value={site.updatedAt} /></p></div></div>
      {site.reviewNote && <div className="notice">审核备注：{site.reviewNote}</div>}
      <label className="field">审核意见<textarea className="input" value={reason} onChange={event => setReason(event.target.value)} rows={3} placeholder="驳回或下架时必填；请给出可执行的修正建议" /></label>
      <div style={actionRowStyle}>{site.status === 'pending' && <><button disabled={pending} className="btn btn-primary" onClick={() => review('approve')}>审核通过并上线</button><button disabled={pending} className="btn" onClick={() => review('reject')}>驳回申请</button></>}{site.status === 'approved' && <button disabled={pending} className="btn" onClick={() => review('suspend')}>下架站点</button>}{site.status === 'suspended' && <button disabled={pending} className="btn btn-primary" onClick={() => review('restore')}>恢复上线</button>}</div>
      {message && <p className="notice" role="status">{message}</p>}
    </section>
    <section className="panel stack"><h2>渠道与连接检查</h2><ChannelsTable items={site.channels} />
      {site.channels.map(channel => <details key={channel.id}><summary>{channel.name} · 上游配置与模型</summary><div className="stack" style={{ marginTop: 16 }}><div className="form-grid"><div><span className="muted">上游地址</span><p className="mono" style={{ overflowWrap: 'anywhere' }}>{channel.baseUrl}</p></div><div><span className="muted">检测凭据</span><p className="mono">{channel.apiKeyMask}</p></div><div><span className="muted">最近连接结果</span><p>{channel.lastTestOk === null ? '未测试' : channel.lastTestOk ? '连接成功' : '连接失败'} · <DateValue value={channel.lastTestAt} /></p></div><div><span className="muted">备用模型 / 限流</span><p>{channel.backupModel ?? '未设置'} / {channel.rpmLimit ?? '未设置'} RPM</p></div></div>{channel.stats && <UptimeBar points={channel.stats.sparkline} />}<div className="table-wrap"><table className="data-table"><thead><tr><th>上游模型</th><th>标准模型</th><th>最近测试</th><th>可信分</th><th>失败原因</th></tr></thead><tbody>{channel.models.map(model => <tr key={model.id}><td className="mono">{model.upstreamName}</td><td>{model.displayName ?? model.modelSlug ?? '未映射'}</td><td><Status value={model.lastStatus} /></td><td><TrustBadge score={model.trustScore} verdict={model.trustVerdict} /></td><td style={{ whiteSpace: 'normal' }}>{model.lastError ?? '—'}</td></tr>)}</tbody></table></div></div></details>)}
    </section>
    <section className="panel stack"><h2>最近模型检测报告</h2>{site.reports.length === 0 && <p className="muted">尚未生成检测报告；可在上方渠道中发起真伪检测。</p>}{site.reports.map((report, index) => <details key={report.id ?? index} open={index === 0}><summary><span className="mono">{report.model}</span> · {PROTOCOL_LABELS[report.protocol]} · <TrustBadge score={report.score} verdict={report.verdict} /></summary><div className="table-wrap" style={{ marginTop: 16 }}><table className="data-table"><thead><tr><th>检查项目</th><th>结果</th><th>权重</th><th>证据说明</th></tr></thead><tbody>{report.checks.map(check => <tr key={check.id}><td>{check.name}</td><td><Status value={check.passed === null ? 'untested' : check.passed ? 'pass' : 'fail'} /></td><td className="mono">{check.weight}</td><td style={{ whiteSpace: 'normal', maxWidth: 600 }}>{check.detail}</td></tr>)}</tbody></table></div><p className="muted">耗时 {(report.durationMs / 1000).toFixed(1)} 秒 · <DateValue value={report.createdAt} /></p></details>)}</section>
    <section className="panel stack"><h2>站点资料与展示设置</h2><form action={save} className="stack"><div className="form-grid">
      {([['name', '站点名称', site.name], ['slug', '链接标识', site.slug], ['homepageUrl', '官方网站', site.homepageUrl], ['inviteUrl', '邀请链接', site.inviteUrl], ['logoUrl', 'Logo 地址', site.logoUrl]] as const).map(([name, label, value]) => <label className="field" key={name}>{label}<input className="input" name={name} required={name === 'name' || name === 'homepageUrl' || name === 'slug'} type={name.endsWith('Url') ? 'url' : 'text'} defaultValue={value ?? ''} /></label>)}
      <label className="field">站点类型<select className="select" name="type" defaultValue={site.type}>{Object.entries(SITE_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field">充值倍率<input className="input mono" name="rechargeRatio" type="number" min="0.00001" step="any" required defaultValue={site.rechargeRatio} /></label><label className="field">展示权重<input className="input mono" name="sortWeight" type="number" defaultValue={site.sortWeight} required /></label><label className="field">标签（逗号分隔）<input className="input" name="tags" defaultValue={site.tags.join(', ')} /></label><label className="field">支付方式（逗号分隔）<input className="input" name="paymentMethods" defaultValue={site.paymentMethods.join(', ')} /></label>
      {(['email', 'qq', 'wechat', 'telegram', 'group'] as const).map(key => <label className="field" key={key}>联系方式 · {key}<input className="input" name={`contact.${key}`} defaultValue={site.contact[key] ?? ''} /></label>)}
      <label className="row"><input type="checkbox" name="isVerified" defaultChecked={site.isVerified} />官方认证</label><label className="row"><input type="checkbox" name="isFeatured" defaultChecked={site.isFeatured} />精选展示</label>
    </div><label className="field">简介<textarea className="input" rows={4} name="description" defaultValue={site.description ?? ''} /></label><div><button className="btn btn-primary" disabled={pending}>{pending ? '保存中…' : '保存资料'}</button></div></form></section>
  </div>;
}
