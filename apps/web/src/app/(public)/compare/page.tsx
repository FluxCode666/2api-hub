import {pageMetadata} from '@/lib/seo';
import type {Paginated,ChannelListItem} from '@hub/shared';
import {publicApi} from '@/lib/api/public';
import {PageHead} from '@/components/ui';
import {CompareView} from '@/components/compare-view';
export function generateMetadata(){return pageMetadata({title:'AI 中转渠道并排对比',description:'将 2–4 条 AI 中转渠道放在一起，比较相同模型的人民币单价、可用率、延迟、可信分与推荐分。',path:'/compare',noIndex:true});}
export default async function Compare({searchParams}:{searchParams:Promise<{ids?:string;model?:string}>}){const{ids,model}=await searchParams;const parsed=[...new Set((ids??'').split(',').map(Number).filter(x=>Number.isSafeInteger(x)&&x>0))].slice(0,4);const data=parsed.length?await publicApi<Paginated<ChannelListItem>>(`/channels?ids=${parsed.join(',')}&pageSize=4${model?`&model=${encodeURIComponent(model)}`:''}`,60):null;return <div className="container"><PageHead eyebrow="选择，可以更清楚" title="并排一看，心里有数。" description="一次比较 2–4 个渠道。按模型从榜单加入的渠道会使用相同模型报价；未指定模型时展示各自主测模型价格。"/><CompareView items={data?.items??[]} hasIds={!!ids} model={model}/></div>}

export const revalidate = 60;
