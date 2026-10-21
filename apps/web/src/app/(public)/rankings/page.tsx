import type {Metadata} from 'next';
import type {ModelSummary,VendorSummary,Paginated,ChannelListItem} from '@hub/shared';
import {serverApi} from '@/lib/api/server';
import {PageHead} from '@/components/ui';
import {ChannelTable} from '@/components/channel-table';
import {RankingFilters,Pagination,searchString,type SearchValues} from '@/components/ranking-filters';
export const metadata:Metadata={title:'渠道榜单'};
export default async function Rankings({searchParams}:{searchParams:Promise<SearchValues>}){const values=await searchParams;const[channels,models,vendors]=await Promise.all([serverApi<Paginated<ChannelListItem>>(`/channels?${searchString(values)}`),serverApi<ModelSummary[]>('/models'),serverApi<VendorSummary[]>('/vendors')]);return <div className="container ranking-page"><PageHead title="渠道榜单" description="实际价格、稳定性与模型可信度，一次看清。"/><RankingFilters models={models} vendors={vendors} values={values}/><div className="ranking-meta"><span><span className="live-dot"/>正在持续探测 · 找到 {channels.total} 个渠道</span><span>价格单位：¥/百万 Token（输入 / 输出） · 无样本显示 —</span></div><ChannelTable items={channels.items}/><Pagination {...channels} values={values} base="/rankings"/><p className="muted" style={{fontSize:11,marginTop:23}}>稳定渠道标准：24h 可用率 ≥95%，且样本 ≥12 次。推荐分不包含价格因素。<a className="link" href="/guide">了解评分规则 →</a></p></div>}
