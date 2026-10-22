import {pageMetadata} from '@/lib/seo';
import Link from 'next/link';
import type {VendorDetail,Paginated,ChannelListItem} from '@hub/shared';
import {publicApi} from '@/lib/api/public';
import {publicResource} from '@/lib/resource';
import {paginationValues,slicePage} from '@/lib/pagination';
import {Button} from '@/components/ui/button';
import {DataPagination} from '@/components/data-pagination';
import {PageHead} from '@/components/page-kit';
import {ModelCard} from '@/components/catalog';
import {ChannelTable} from '@/components/channel-table';
import {RankingFilters,Pagination,searchString,type SearchValues} from '@/components/ranking-filters';

export async function generateMetadata({params}:{params:Promise<{slug:string}>}){const{slug}=await params;const vendor=await publicResource<VendorDetail>(`/vendors/${encodeURIComponent(slug)}`);return pageMetadata({title:`${vendor.nameZh??vendor.name} 模型与 API 中转渠道`,description:`浏览 ${vendor.name} 的 ${vendor.modelCount} 个模型与 ${vendor.channelCount} 条已上线中转渠道，比较输入输出价格、实测可用率、响应延迟与模型检测结果。`,path:`/vendors/${encodeURIComponent(vendor.slug)}`});}
export default async function VendorPage({params,searchParams}:{params:Promise<{slug:string}>;searchParams:Promise<SearchValues>}){
 const {slug}=await params;
 const input=await searchParams;const paging=paginationValues(input);const modelPaging=paginationValues(input,'modelsPage','modelsPageSize');const values:SearchValues={...input,vendor:slug,page:String(paging.page),pageSize:String(paging.pageSize)};
 const base=`/vendors/${encodeURIComponent(slug)}`;
 const [vendor,channels]=await Promise.all([
  publicResource<VendorDetail>(`/vendors/${encodeURIComponent(slug)}`),
  publicApi<Paginated<ChannelListItem>>(`/channels?${searchString(values)}`,60),
 ]);
 return <div className="container"><PageHead title={vendor.name} eyebrow={vendor.nameZh??'模型厂商'} description={vendor.description??`发现 ${vendor.name} 的模型，并比较各中转渠道的真实服务质量。`}>{vendor.website&&<Button variant="outline" asChild><a href={vendor.website} target="_blank" rel="noopener noreferrer">访问厂商官网 ↗</a></Button>}</PageHead><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{slicePage(vendor.models,modelPaging.page,modelPaging.pageSize).map(m=><ModelCard model={m} key={m.slug}/>)}</div><DataPagination {...modelPaging} total={vendor.models.length} values={values} base={base} pageKey="modelsPage" pageSizeKey="modelsPageSize"/><section className="detail-block"><div className="section-heading"><h2 style={{marginBottom:0}}>相关渠道</h2><Button variant="link" size="sm" asChild><Link href={`/rankings?${searchString(values)}`}>打开完整榜单 →</Link></Button></div><RankingFilters models={vendor.models} vendors={[vendor]} values={values} lockedVendor={slug} base={base}/><ChannelTable items={channels.items} model={typeof values.model==='string'?values.model:undefined}/><Pagination {...channels} values={values} base={base}/></section></div>
}

export const revalidate = 60;
