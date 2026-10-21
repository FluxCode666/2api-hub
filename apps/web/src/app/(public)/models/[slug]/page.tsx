import {JsonLd} from '@/components/json-ld';
import {absoluteUrl} from '@/lib/seo';
import {modelDescription} from '@/lib/seo-content';
import {pageMetadata} from '@/lib/seo';
import Link from 'next/link';
import type {ModelDetail,Paginated,ChannelListItem} from '@hub/shared';
import {PROTOCOL_LABELS} from '@hub/shared';
import {publicApi} from '@/lib/api/public';
import {publicResource} from '@/lib/resource';
import {PageHead,Metric,money,percent} from '@/components/ui';
import {VendorMark} from '@/components/charts';
import {ChannelTable} from '@/components/channel-table';
import {RankingFilters,Pagination,searchString,type SearchValues} from '@/components/ranking-filters';

export async function generateMetadata({params}:{params:Promise<{slug:string}>}){const{slug}=await params;const model=await publicResource<ModelDetail>(`/models/${encodeURIComponent(slug)}`);const path=`/models/${encodeURIComponent(model.slug)}`;return pageMetadata({title:`${model.displayName} 中转站价格对比与实测排名`,description:modelDescription(model),path,imagePath:`${path}/opengraph-image`});}
export default async function ModelPage({params,searchParams}:{params:Promise<{slug:string}>;searchParams:Promise<SearchValues>}){
 const {slug}=await params;
 const values:SearchValues={...await searchParams,model:slug};
 const base=`/models/${encodeURIComponent(slug)}`;
 const [model,channels]=await Promise.all([
  publicResource<ModelDetail>(`/models/${encodeURIComponent(slug)}`),
  publicApi<Paginated<ChannelListItem>>(`/channels?${searchString(values)}`,60),
 ]);
 return <div className="container"><JsonLd data={{"@context":"https://schema.org","@type":"ItemList",name:`${model.displayName} 中转渠道排名`,url:absoluteUrl(base),numberOfItems:channels.total,itemListOrder:"https://schema.org/ItemListOrderAscending",itemListElement:channels.items.map(channel=>({"@type":"ListItem",position:channel.rank,name:`${channel.site.name} / ${channel.name}`,url:absoluteUrl(`/channels/${channel.id}`)}))}}/>
  <PageHead eyebrow={model.vendor.name} title={model.displayName} description={model.description??'从真实价格、稳定性与模型可信度，选择适合你的 API 渠道。'}><VendorMark vendor={model.vendor}/></PageHead>
  <div className="metric-grid"><Metric label="最低输入价 · ¥/百万 Token" value={money(model.minInputPriceCny)} detail="各渠道最低价，仅供参考"/><Metric label="提供该模型的渠道" value={model.channelCount} detail="已审核上线渠道"/><Metric label="最佳 24h 可用率" value={percent(model.bestUptime24h)} detail="实际探测成功率"/><Metric label="上下文窗口" value={model.contextWindow?`${Math.round(model.contextWindow/1000)}K`:'—'} detail={PROTOCOL_LABELS[model.defaultProtocol]}/></div>
  <div className="notice" style={{marginTop:23,fontSize:12}}>官方价（$/百万 Token）：输入 ${model.officialInputPrice??'—'} / 输出 ${model.officialOutputPrice??'—'}<span className="muted">　·　模型标识：{model.slug}　·　知识截止：{model.knowledgeCutoff??'未公开'}</span></div>
  <section className="detail-block"><div className="section-heading"><h2 style={{margin:0}}>可选渠道</h2><Link className="link" href={`/rankings?${searchString(values)}`}>打开完整筛选 →</Link></div><RankingFilters models={[model]} vendors={[]} values={values} lockedModel={slug} base={base}/><ChannelTable items={channels.items}/><Pagination {...channels} values={values} base={base}/></section>
 </div>
}

export const revalidate = 60;
