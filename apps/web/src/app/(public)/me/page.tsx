import Link from 'next/link';
import {redirect} from 'next/navigation';
import type {ChannelListItem,Notification,MyReview,Paginated} from '@hub/shared';
import {getSession,serverApi} from '@/lib/api/server';
import {PageHead,Empty} from '@/components/ui';
import {ChannelTable} from '@/components/channel-table';
import {Notifications} from '@/components/notifications';
import {MyReviews} from '@/components/my-reviews';
export const metadata={title:'个人中心'};
export default async function Me(){const user=await getSession();if(!user)redirect('/login?next=%2Fme');const[favorites,notifications,reviews]=await Promise.all([serverApi<ChannelListItem[]>('/me/favorites'),serverApi<Notification[]>('/me/notifications'),serverApi<Paginated<MyReview>>('/me/reviews')]);return <div className="container"><PageHead eyebrow="我的连接" title={`你好，${user.nickname}。`} description="优选渠道和最新动态，都在这里。"><div className="row"><Link href="/merchant" className="btn">站长工作台 →</Link>{user.role==='admin'&&<Link href="/admin" className="btn btn-primary">管理后台 →</Link>}</div></PageHead><div className="stack"><section><div className="section-heading"><h2 style={{fontSize:22}}>我的收藏</h2><span className="badge">{favorites.length} 个渠道</span></div>{favorites.length?<ChannelTable items={favorites}/>:<Empty title="还没有收藏渠道" description="在榜单中收藏感兴趣的渠道，方便以后查找和比较。"/>}</section><Notifications items={notifications}/><MyReviews initial={reviews}/></div></div>}
