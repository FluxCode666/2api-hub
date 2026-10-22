'use client';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useState} from 'react';
import type {NotificationList} from '@hub/shared';
import {toast} from 'sonner';
import {api} from '@/lib/api/client';
import type {SearchValues} from '@/lib/query';
import {FormatDate,Empty} from './page-kit';
import {Button} from './ui/button';
import {Card,CardHeader,CardTitle,CardContent} from './ui/card';
import {Badge} from './ui/badge';
import {DataPagination} from './data-pagination';
export function Notifications({data,values={}}:{data:NotificationList;values?:SearchValues}){const router=useRouter();const[busy,setBusy]=useState(false);async function markRead(){setBusy(true);try{await api('/me/notifications/read',{method:'POST',body:JSON.stringify({})});toast.success('通知已全部标记为已读');router.refresh()}catch(error){toast.error(error instanceof Error?error.message:'操作失败')}finally{setBusy(false)}}return <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>站内通知 <Badge variant={data.unreadCount?'warning':'secondary'}>{data.unreadCount} 条未读</Badge></CardTitle>{data.unreadCount>0&&<Button variant="outline" size="sm" disabled={busy} onClick={markRead}>全部标记为已读</Button>}</div></CardHeader><CardContent><div className="divide-y">{data.items.length?data.items.map(notification=><article key={notification.id} className="space-y-3 py-5 first:pt-0"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-medium">{!notification.readAt&&<Badge variant="warning">未读</Badge>}{notification.title}</h3><span className="text-xs text-muted-foreground"><FormatDate value={notification.createdAt}/></span></div>{notification.body&&<p className="text-sm leading-relaxed text-muted-foreground">{notification.body}</p>}{notification.link&&<Button variant="link" size="sm" className="px-0" asChild><Link href={notification.link}>查看详情 →</Link></Button>}</article>):<Empty title="暂时没有新通知" description="收藏与站点的最新动态会出现在这里。"/>}</div><DataPagination {...data} values={values} base="/me"/></CardContent></Card>}
