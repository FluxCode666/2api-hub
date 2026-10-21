import {pageMetadata} from '@/lib/seo';
import Link from 'next/link';
import type {VendorSummary} from '@hub/shared';
import {publicApi} from '@/lib/api/public';
import {PageHead} from '@/components/ui';
import {VendorMark} from '@/components/charts';
import {ArrowUpRight} from '@phosphor-icons/react/dist/ssr';
export async function generateMetadata(){const vendors=await publicApi<VendorSummary[]>('/vendors');return pageMetadata({title:'AI 模型厂商与中转渠道目录',description:`从 ${vendors.length} 家模型厂商出发，浏览 OpenAI、Anthropic、Google、DeepSeek 等模型目录，比较已上线中转渠道的价格与稳定性。`,path:'/vendors'});}
export default async function Vendors(){const vendors=await publicApi<VendorSummary[]>('/vendors');return <div className="container"><PageHead title="连接每一种智能。" description="从厂商出发，发现它们的模型与可用渠道。" eyebrow="模型厂商"/><div className="card-grid">{vendors.map(v=><Link key={v.slug} href={`/vendors/${v.slug}`} className="card"><div className="between"><VendorMark vendor={v}/><ArrowUpRight size={17} className="muted"/></div><h2 style={{fontSize:24,margin:'25px 0 10px'}}>{v.name}</h2><p style={{fontSize:12}}>{v.nameZh??v.name}</p><div className="divider"/><div className="between muted" style={{fontSize:12}}><span>{v.modelCount} 个模型</span><span>{v.channelCount} 个渠道</span></div></Link>)}</div></div>}

export const revalidate = 300;
