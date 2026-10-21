'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SettingsMap, ScoringWeights } from '@hub/shared';
import { api } from '@/lib/api/client';

const numericSettings = [
  ['probe.defaultIntervalSec', '默认探测间隔（秒）', 30], ['probe.concurrency', '全局探测并发', 1], ['probe.perSiteConcurrency', '单站点并发', 1], ['probe.timeoutMs', '探测超时（毫秒）', 1000],
  ['authenticity.intervalHours', '真伪检测间隔（小时）', 1], ['authenticity.merchantDailyLimit', '站长每日手动检测次数', 1], ['verify.hourlyLimitPerIp', '公开鉴定每 IP 每小时次数', 1],
] as const;
export function SettingsEditor({ settings }: { settings: SettingsMap }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const router = useRouter();
  async function save(form: FormData) {
    const weights: ScoringWeights = { uptime: Number(form.get('uptime')), latency: Number(form.get('latency')), trust: Number(form.get('trust')), stability: Number(form.get('stability')) };
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total <= 0) { setMessage('评分权重总和必须大于 0'); return; }
    const body: SettingsMap = { ...settings, 'scoring.weights': weights, 'site.allowRegistration': form.get('allowRegistration') === 'on', 'site.announcementBar': String(form.get('announcementBar') ?? '') };
    for (const [key] of numericSettings) body[key] = Number(form.get(key));
    setPending(true); setMessage('');
    try { await api<SettingsMap>('/admin/settings', { method: 'PUT', body: JSON.stringify(body) }); setMessage('系统设置已更新'); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); } finally { setPending(false); }
  }
  return <form action={save} className="stack">
    <section className="panel stack"><h2>探测与访问限制</h2><div className="form-grid">{numericSettings.map(([key, label, min]) => <label key={key} className="field">{label}<input className="input mono" type="number" min={min} step="1" name={key} defaultValue={settings[key]} required /></label>)}</div></section>
    <section className="panel stack"><h2>推荐分权重</h2><p className="muted">权重按总和归一化计算。价格独立排序，不计入推荐分；低于 6 个样本时不计算推荐分。</p><div className="form-grid">{([['uptime', '可用率'], ['latency', '响应延迟'], ['trust', '模型可信分'], ['stability', '连续稳定性']] as const).map(([key, label]) => <label key={key} className="field">{label}<input className="input mono" type="number" min="0" max="1" step="0.01" name={key} defaultValue={settings['scoring.weights'][key]} required /></label>)}</div></section>
    <section className="panel stack"><h2>站点设置</h2><label className="row"><input name="allowRegistration" type="checkbox" defaultChecked={settings['site.allowRegistration']} />开放新用户注册</label><label className="field">全站公告栏<input className="input" name="announcementBar" defaultValue={settings['site.announcementBar']} /></label></section>
    {message && <div className="notice" role="status">{message}</div>}<div><button className="btn btn-primary" disabled={pending}>{pending ? '保存中…' : '保存系统设置'}</button></div>
  </form>;
}
