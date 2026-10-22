'use client';
import {Fragment} from 'react';
import {useRouter} from 'next/navigation';
import {Pagination,PaginationContent,PaginationItem,PaginationLink,PaginationEllipsis} from '@/components/ui/pagination';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {searchString,type SearchValues} from '@/lib/query';

export function DataPagination({page,pageSize,total,base,values,pageKey='page',pageSizeKey='pageSize',onPageChange,onPageSizeChange}:{page:number;pageSize:number;total:number;base:string;values:SearchValues;pageKey?:string;pageSizeKey?:string;onPageChange?:(page:number)=>void;onPageSizeChange?:(size:number)=>void}){
 const router=useRouter();
 const pages=Math.max(1,Math.ceil(total/pageSize));
 const current=Math.min(Math.max(page,1),pages);
 const href=(target:number,size=pageSize)=>`${base}?${searchString(values,{[pageKey]:String(target),[pageSizeKey]:String(size)})}`;
 const numbers=[...new Set([1,...Array.from({length:5},(_,i)=>current+i-2).filter(p=>p>1&&p<pages),pages])].sort((a,b)=>a-b);
 function change(event:React.MouseEvent<HTMLAnchorElement>,target:number){if(onPageChange){event.preventDefault();onPageChange(target)}}
 const step=(target:number,label:string,disabled:boolean)=><PaginationItem><PaginationLink href={href(target)} size="sm" aria-label={label} aria-disabled={disabled} tabIndex={disabled?-1:undefined} onClick={e=>disabled?e.preventDefault():change(e,target)} className={disabled?'pointer-events-none text-muted-foreground opacity-50':''}>{label}</PaginationLink></PaginationItem>;
 return <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground" data-slot="data-pagination">
  <div className="flex items-center gap-3"><span>共 {total} 条</span><Select value={String(pageSize)} onValueChange={value=>{const size=Number(value);if(onPageSizeChange)onPageSizeChange(size);else router.push(href(1,size),{scroll:false})}}><SelectTrigger size="sm" className="w-28 text-xs" aria-label="每页条数"><SelectValue/></SelectTrigger><SelectContent>{[20,50,100].map(size=><SelectItem key={size} value={String(size)}>{size} 条 / 页</SelectItem>)}</SelectContent></Select></div>
  <Pagination aria-label="列表分页" className="m-0 w-auto"><PaginationContent>{step(Math.max(1,current-1),'上一页',current===1)}<PaginationItem className="px-2 sm:hidden">第 {current} / {pages} 页</PaginationItem>{numbers.map((number,index)=><Fragment key={number}>{index>0&&number-numbers[index-1]!>1&&<PaginationItem className="hidden sm:block"><PaginationEllipsis/></PaginationItem>}<PaginationItem className="hidden sm:block"><PaginationLink href={href(number)} isActive={number===current} onClick={event=>change(event,number)} aria-label={`第 ${number} 页`}>{number}</PaginationLink></PaginationItem></Fragment>)}{step(Math.min(pages,current+1),'下一页',current===pages)}</PaginationContent></Pagination>
 </div>
}
