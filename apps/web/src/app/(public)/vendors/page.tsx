import {pageMetadata} from '@/lib/seo';
import Link from 'next/link';
import type {VendorSummary} from '@hub/shared';
import {publicApi} from '@/lib/api/public';
import type {SearchValues} from '@/lib/query';
import {paginationValues,slicePage} from '@/lib/pagination';
import {PageHead} from '@/components/page-kit';
import {VendorMark} from '@/components/charts';
import {ArrowUpRight} from '@phosphor-icons/react/dist/ssr';
import {Card,CardHeader,CardContent,CardFooter} from '@/components/ui/card';
import {DataPagination} from '@/components/data-pagination';
export async function generateMetadata(){const vendors=await publicApi<VendorSummary[]>('/vendors');return pageMetadata({title:'AI 模型厂商与中转渠道目录',description:`从 ${vendors.length} 家模型厂商出发，浏览 OpenAI、Anthropic、Google、DeepSeek 等模型目录，比较已上线中转渠道的价格与稳定性。`,path:'/vendors'});}
export default async function Vendors({searchParams}:{searchParams:Promise<SearchValues>}){const values=await searchParams;const{page,pageSize}=paginationValues(values);const vendors=await publicApi<VendorSummary[]>('/vendors');return <div className="container"><PageHead title="连接每一种智能。" description="从厂商出发，发现它们的模型与可用渠道。" eyebrow="模型厂商"/><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{slicePage(vendors,page,pageSize).map(vendor=><Link key={vendor.slug} href={`/vendors/${vendor.slug}`} className="group"><Card className="h-full transition group-hover:-translate-y-0.5 group-hover:ring-primary/30"><CardHeader><div className="flex items-center justify-between"><VendorMark vendor={vendor}/><ArrowUpRight className="size-4 text-muted-foreground"/></div></CardHeader><CardContent><h2 className="mb-2 text-2xl font-semibold">{vendor.name}</h2><p className="text-sm text-muted-foreground">{vendor.nameZh??vendor.name}</p></CardContent><CardFooter className="justify-between text-xs text-muted-foreground"><span>{vendor.modelCount} 个模型</span><span>{vendor.channelCount} 个渠道</span></CardFooter></Card></Link>)}</div><DataPagination page={page} pageSize={pageSize} total={vendors.length} values={values} base="/vendors"/></div>}
export const revalidate = 300;
