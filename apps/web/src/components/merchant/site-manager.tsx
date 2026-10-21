'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ChannelInput, MerchantSiteDetail, ModelSummary, SiteInput, VendorSummary } from '@hub/shared';
import { api } from '@/lib/api/client';
import { Metric, StatusBadge, Empty, FormatDate } from '@/components/ui';
import { SiteForm, ChannelForm } from './forms';
export function SiteManager({ initialSite, vendors, models }: { initialSite: MerchantSiteDetail; vendors: VendorSummary[]; models: ModelSummary[] }) {
  const [site, setSite] = useState(initialSite); const [notice, setNotice] = useState(''); const [adding, setAdding] = useState(false); const router = useRouter();
  const canAddChannel = ['draft', 'rejected'].includes(site.status);
  async function reload() { setSite(await api<MerchantSiteDetail>(`/merchant/sites/${site.id}`)); router.refresh(); }
  async function save(input: SiteInput) { await api(`/merchant/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify(input) }); await reload(); setNotice('站点资料已保存。'); }
  async function addChannel(input: ChannelInput) { await api(`/merchant/sites/${site.id}/channels`, { method: 'POST', body: JSON.stringify(input) }); await reload(); setAdding(false); setNotice('渠道已添加。请进入渠道详情测试连接。'); }
  return <div className="stack"><div className="row between"><StatusBadge status={site.status} /><span className="muted merchant-small">最近更新 <FormatDate value={site.updatedAt} /></span></div>{site.reviewNote && <div className="notice notice-error">审核反馈：{site.reviewNote}</div>}{notice && <div className="notice" role="status">{notice}</div>}{['draft', 'rejected'].includes(site.status) && <div className="notice row between"><span>完成渠道连接测试后，即可继续提交审核。</span><Link className="btn btn-primary btn-small" href={`/merchant/onboarding?siteId=${site.id}`}>继续入驻</Link></div>}
    <div className="metric-grid"><Metric label="渠道数量" value={site.channels.length} /><Metric label="声明模型" value={site.channels.reduce((sum, channel) => sum + channel.models.length, 0)} detail="各渠道模型总数" /><Metric label="充值倍率" value={`${site.rechargeRatio}×`} detail="每 ¥1 可充值的美元额度" /><Metric label="24h 平均可用率" value={site.stats?.avgUptime24h == null ? '暂无样本' : `${(site.stats.avgUptime24h * 100).toFixed(2)}%`} /></div>
    <section className="panel"><details className="merchant-details"><summary>编辑站点资料</summary><SiteForm site={site} onSave={save} /></details></section>
    <section><div className="merchant-subhead"><h2>旗下渠道</h2>{canAddChannel && <button className="btn btn-primary btn-small" onClick={() => setAdding(!adding)}>{adding ? '收起表单' : '添加渠道'}</button>}</div>{!canAddChannel && <p className="muted merchant-small">当前站点状态下可维护现有渠道；新增渠道请联系平台处理。</p>}{adding && canAddChannel && <div className="panel merchant-page-block"><ChannelForm vendors={vendors} models={models} onSave={addChannel} submitLabel="创建渠道" /></div>}{site.channels.length ? <div className="merchant-site-grid merchant-page-block">{site.channels.map((channel) => <Link className="card merchant-channel-card" href={`/merchant/channels/${channel.id}`} key={channel.id}><div className="merchant-channel-title"><h3>{channel.name}</h3><StatusBadge status={channel.status} /></div><span className="muted mono merchant-small">{channel.primaryModel}</span><div className="row between"><span className="mono">{channel.actualRatio}× 实际倍率</span><span className={`badge ${channel.lastTestOk ? 'badge-good' : channel.lastTestOk === false ? 'badge-bad' : ''}`}>{channel.lastTestOk ? '连接通过' : channel.lastTestOk === false ? '连接失败' : '待测试'}</span></div><span className="merchant-link merchant-small">配置、模型与探测日志 →</span></Link>)}</div> : <Empty title="还没有添加渠道" description="为站点添加一个计费分组，再进行连接测试。" />}</section>
  </div>;
}
