import {pageMetadata} from '@/lib/seo';
import Link from 'next/link';
import {redirect} from 'next/navigation';
import type {ChannelListItem,NotificationList,MyReview,Paginated} from '@hub/shared';
import {getSession,serverApi} from '@/lib/api/server';
import {paginationValues} from '@/lib/pagination';
import {searchString,type SearchValues} from '@/lib/query';
import {PageHead,Empty} from '@/components/page-kit';
import {ChannelTable} from '@/components/channel-table';
import {Notifications} from '@/components/notifications';
import {MyReviews} from '@/components/my-reviews';
import {QueryTabs} from '@/components/ranking-controls';
import {DataPagination} from '@/components/data-pagination';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
export function generateMetadata(){return pageMetadata({title:'个人中心',description:'查看你的渠道收藏、站点评价和平台通知。',path:'/me',noIndex:true});}
export default async function Me({searchParams}:{searchParams:Promise<SearchValues>}){const user=await getSession();if(!user)redirect('/login?next=%2Fme');const values=await searchParams;const tab=values.tab==='reviews'?'reviews':values.tab==='notifications'?'notifications':'favorites';const paging=paginationValues(values);const query=searchString({}, {page:String(paging.page),pageSize:String(paging.pageSize)});let content:React.ReactNode;if(tab==='reviews'){const data=await serverApi<Paginated<MyReview>>(`/me/reviews?${query}`);content=<MyReviews initial={data} values={values}/>;}else if(tab==='notifications'){const data=await serverApi<NotificationList>(`/me/notifications?${query}`);content=<Notifications data={data} values={values}/>;}else{const data=await serverApi<Paginated<ChannelListItem>>(`/me/favorites?${query}`);content=<section><div className="mb-4 flex items-center justify-between"><h2 className="text-xl font-semibold">我的收藏</h2><Badge variant="secondary">{data.total} 个渠道</Badge></div>{data.items.length?<ChannelTable items={data.items}/>:<Empty title="还没有收藏渠道" description="在榜单中收藏感兴趣的渠道，方便以后查找和比较。"/>}<DataPagination {...data} values={values} base="/me"/></section>;}return <div className="container"><PageHead eyebrow="我的连接" title={`你好，${user.nickname}。`} description="优选渠道和最新动态，都在这里。"><div className="flex flex-wrap gap-2"><Button variant="outline" asChild><Link href="/merchant">站长工作台 →</Link></Button>{user.role==='admin'&&<Button asChild><Link href="/admin">管理后台 →</Link></Button>}</div></PageHead><div className="mb-6"><QueryTabs base="/me" values={values} value={tab} tabs={[{value:'favorites',label:'我的收藏'},{value:'reviews',label:'我的评价'},{value:'notifications',label:'站内通知'}]}/></div>{content}</div>}
