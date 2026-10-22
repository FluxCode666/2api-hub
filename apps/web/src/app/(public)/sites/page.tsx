import {pageMetadata} from '@/lib/seo';
import type {Paginated,SiteListItem,VendorSummary} from '@hub/shared';
import {publicApi} from '@/lib/api/public';
import {paginationValues} from '@/lib/pagination';
import {searchString,type SearchValues} from '@/lib/query';
import {PageHead,Empty} from '@/components/page-kit';
import {SiteCard} from '@/components/catalog';
import {DirectoryFilters} from '@/components/ranking-controls';
import {DataPagination} from '@/components/data-pagination';
export async function generateMetadata(){const sites=await publicApi<Paginated<SiteListItem>>('/sites?pageSize=1');return pageMetadata({title:'AI 中转站目录与用户评价',description:`浏览 ${sites.total} 个已审核上线的 AI 中转站，了解渠道数量、平均可用率、实际倍率与用户评价，挑选适合自己的 API 服务。`,path:'/sites'});}
export default async function Sites({searchParams}:{searchParams:Promise<SearchValues>}){const values=await searchParams;const paging=paginationValues(values);const[sites,vendors]=await Promise.all([publicApi<Paginated<SiteListItem>>(`/sites?${searchString(values,{page:String(paging.page),pageSize:String(paging.pageSize)})}`),publicApi<VendorSummary[]>('/vendors')]);return <div className="container"><PageHead eyebrow="优质服务，值得发现" title="站点目录" description="已审核上线的中转站点。点进档案，看清它的渠道、稳定性与用户评价。"/><DirectoryFilters kind="sites" vendors={vendors} values={values}/><div className="mb-4 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>共 {sites.total} 个已上线站点</span><span>站点认证不代表购买担保</span></div>{sites.items.length?<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{sites.items.map(site=><SiteCard site={site} key={site.id}/>)}</div>:<Empty title="没有找到相关站点"/>}<DataPagination {...sites} values={values} base="/sites"/></div>}
export const revalidate = 300;
