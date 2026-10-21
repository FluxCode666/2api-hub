import Link from 'next/link';
import type {ModelSummary,VendorSummary} from '@hub/shared';
import {ArrowRight} from '@phosphor-icons/react/dist/ssr';
import {RankingControls} from './ranking-controls';
import {searchString,type SearchValues} from '@/lib/query';
export {searchString,type SearchValues} from '@/lib/query';
export function RankingFilters(props:{models:ModelSummary[];vendors:VendorSummary[];values:SearchValues;lockedModel?:string;lockedVendor?:string;base?:string}){return <RankingControls {...props}/>}
export function Pagination({page,pageSize,total,values,base}:{page:number;pageSize:number;total:number;values:SearchValues;base:string}){const pages=Math.max(1,Math.ceil(total/pageSize));return <div className="pagination"><span>共 {total} 条 · 第 {page} / {pages} 页</span><div className="row">{page>1&&<Link href={`${base}?${searchString(values,{page:String(page-1)})}`} className="btn btn-small">上一页</Link>}{page<pages&&<Link href={`${base}?${searchString(values,{page:String(page+1)})}`} className="btn btn-small">下一页<ArrowRight size={12}/></Link>}</div></div>}
