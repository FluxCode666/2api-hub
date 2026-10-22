import {pageMetadata} from '@/lib/seo';
import type {ModelSummary,VendorSummary} from '@hub/shared';
import {publicApi} from '@/lib/api/public';
import {paginationValues,slicePage} from '@/lib/pagination';
import type {SearchValues} from '@/lib/query';
import {searchString} from '@/lib/query';
import {PageHead,Empty} from '@/components/page-kit';
import {ModelCard} from '@/components/catalog';
import {DirectoryFilters} from '@/components/ranking-controls';
import {DataPagination} from '@/components/data-pagination';
export async function generateMetadata(){const models=await publicApi<ModelSummary[]>('/models');return pageMetadata({title:'AI 模型目录与中转站价格对比',description:`浏览 ${models.length} 个主流 AI 模型，覆盖 Claude、GPT、Gemini、DeepSeek 等系列。比较各模型中转渠道的最低人民币价格、可用率与可信度。`,path:'/models'});}
export default async function Models({searchParams}:{searchParams:Promise<SearchValues>}){const values=await searchParams;const{page,pageSize}=paginationValues(values);const[models,vendors]=await Promise.all([publicApi<ModelSummary[]>(`/models?${searchString(values)}`),publicApi<VendorSummary[]>('/vendors')]);const visible=slicePage(models,page,pageSize);return <div className="container"><PageHead eyebrow="从熟悉的模型开始" title="模型广场" description="主流模型，一个入口。找到模型，再比较提供它的渠道。"/><DirectoryFilters kind="models" vendors={vendors} values={values}/>{!visible.length?<Empty title="没有找到相关模型" description="请换一个关键词或厂商试试。"/>:vendors.filter(vendor=>visible.some(model=>model.vendor.slug===vendor.slug)).map(vendor=><section key={vendor.slug} className="mb-8"><div className="mb-4 flex items-center justify-between"><h2 className="text-xl font-semibold">{vendor.name}</h2><span className="text-xs text-muted-foreground">{models.filter(model=>model.vendor.slug===vendor.slug).length} 个模型</span></div><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visible.filter(model=>model.vendor.slug===vendor.slug).map(model=><ModelCard model={model} key={model.slug}/>)}</div></section>)}<DataPagination page={page} pageSize={pageSize} total={models.length} values={values} base="/models"/></div>}
export const revalidate = 300;
