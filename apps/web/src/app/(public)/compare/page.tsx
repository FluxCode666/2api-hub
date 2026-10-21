import type {Paginated,ChannelListItem} from '@hub/shared';
import {serverApi} from '@/lib/api/server';
import {PageHead} from '@/components/ui';
import {CompareView} from '@/components/compare-view';
export const metadata={title:'渠道对比'};
export default async function Compare({searchParams}:{searchParams:Promise<{ids?:string;model?:string}>}){const{ids,model}=await searchParams;const parsed=[...new Set((ids??'').split(',').map(Number).filter(x=>Number.isSafeInteger(x)&&x>0))].slice(0,4);const data=parsed.length?await serverApi<Paginated<ChannelListItem>>(`/channels?ids=${parsed.join(',')}&pageSize=4${model?`&model=${encodeURIComponent(model)}`:''}`):null;return <div className="container"><PageHead eyebrow="选择，可以更清楚" title="并排一看，心里有数。" description="一次比较 2–4 个渠道。按模型从榜单加入的渠道会使用相同模型报价；未指定模型时展示各自主测模型价格。"/><CompareView items={data?.items??[]} hasIds={!!ids} model={model}/></div>}
