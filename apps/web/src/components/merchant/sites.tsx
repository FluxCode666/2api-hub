'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MerchantSite } from '@hub/shared';
import { SITE_TYPE_LABELS } from '@hub/shared';
import { api } from '@/lib/api/client';
import { Empty, StatusBadge, FormatDate } from '@/components/ui';
import { errorMessage } from './forms';
export function SitesList({ sites: initialSites }: { sites: MerchantSite[] }) {
  const [sites, setSites] = useState(initialSites); const [deleting, setDeleting] = useState<number | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const router = useRouter();
  async function remove(id: number) { setBusy(true); setError(''); try { await api(`/merchant/sites/${id}`, { method: 'DELETE' }); setSites((current) => current.filter((s) => s.id !== id)); setDeleting(null); router.refresh(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }
  return <div className="stack">{error && <div role="alert" className="notice notice-error">{error}</div>}{sites.length ? <div className="merchant-site-grid">{sites.map((site) => <article className="panel stack" key={site.id}><div className="merchant-channel-title"><div><span className="muted merchant-small">{SITE_TYPE_LABELS[site.type]}</span><h2>{site.name}</h2></div><StatusBadge status={site.status} /></div><p className="muted merchant-small">{site.description ?? '尚未填写站点简介'}</p><div className="row between"><span className="mono">{site.channelCount} 条渠道</span><span className="muted merchant-small">更新于 <FormatDate value={site.updatedAt} /></span></div>{site.reviewNote && <div className="notice notice-error">审核反馈：{site.reviewNote}</div>}<div className="row"><Link className="btn btn-small" href={`/merchant/sites/${site.id}`}>管理站点</Link>{['draft', 'rejected'].includes(site.status) && <><Link className="btn btn-primary btn-small" href={`/merchant/onboarding?siteId=${site.id}`}>继续入驻</Link><button className="btn btn-small" onClick={() => setDeleting(site.id)}>删除</button></>}{site.status === 'approved' && <Link className="merchant-link merchant-small" href={`/sites/${site.slug}`}>查看公开档案 →</Link>}</div>{deleting === site.id && <div className="merchant-confirm"><span className="merchant-small">删除站点将同时移除旗下渠道，确认删除？</span><button className="btn btn-small" disabled={busy} onClick={() => remove(site.id)}>{busy ? '正在删除…' : '确认删除'}</button><button className="btn btn-small" onClick={() => setDeleting(null)}>取消</button></div>}</article>)}</div> : <Empty title="你的第一个站点，从这里开始" description="创建站点草稿，添加渠道，连接成功后即可提交审核。" />}</div>;
}
