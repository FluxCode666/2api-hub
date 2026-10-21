import Link from 'next/link';
import type {VendorDetail,Paginated,ChannelListItem} from '@hub/shared';
import {serverApi} from '@/lib/api/server';
import {resource} from '@/lib/resource';
import {PageHead} from '@/components/ui';
import {ModelCard} from '@/components/catalog';
import {ChannelTable} from '@/components/channel-table';
import {RankingFilters,Pagination,searchString,type SearchValues} from '@/components/ranking-filters';

export default async function VendorPage({params,searchParams}:{params:Promise<{slug:string}>;searchParams:Promise<SearchValues>}){
 const {slug}=await params;
 const values:SearchValues={...await searchParams,vendor:slug};
 const base=`/vendors/${encodeURIComponent(slug)}`;
 const [vendor,channels]=await Promise.all([
  resource<VendorDetail>(`/vendors/${encodeURIComponent(slug)}`),
  serverApi<Paginated<ChannelListItem>>(`/channels?${searchString(values)}`),
 ]);
 return <div className="container"><PageHead title={vendor.name} eyebrow={vendor.nameZh??'模型厂商'} description={vendor.description??`发现 ${vendor.name} 的模型，并比较各中转渠道的真实服务质量。`}>{vendor.website&&<a href={vendor.website} target="_blank" rel="noopener noreferrer" className="btn">访问厂商官网 ↗</a>}</PageHead><div className="card-grid">{vendor.models.map(m=><ModelCard model={m} key={m.slug}/>)}</div><section className="detail-block"><div className="section-heading"><h2 style={{marginBottom:0}}>相关渠道</h2><Link className="link" href={`/rankings?${searchString(values)}`}>打开完整榜单 →</Link></div><RankingFilters models={vendor.models} vendors={[vendor]} values={values} lockedVendor={slug} base={base}/><ChannelTable items={channels.items}/><Pagination {...channels} values={values} base={base}/></section></div>
}
