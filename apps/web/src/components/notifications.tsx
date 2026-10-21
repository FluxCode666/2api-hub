'use client';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useState} from 'react';
import type {Notification} from '@hub/shared';
import {api} from '@/lib/api/client';
import {FormatDate,Empty} from './ui';
export function Notifications({items}:{items:Notification[]}){const router=useRouter();const[error,setError]=useState('');const[busy,setBusy]=useState(false);return <section className="panel"><div className="between" style={{marginBottom:20}}><h2 style={{fontSize:21}}>站内通知</h2>{items.some(x=>!x.readAt)&&<button className="btn btn-small" disabled={busy} onClick={async()=>{setBusy(true);try{await api('/me/notifications/read',{method:'POST',body:JSON.stringify({})});router.refresh()}catch(e){setError(e instanceof Error?e.message:'操作失败')}finally{setBusy(false)}}}>全部标记为已读</button>}</div>{error&&<div className="notice notice-error">{error}</div>}{items.length?items.map(n=><article key={n.id} className="review-card"><div className="between"><h3 style={{fontSize:14}}>{!n.readAt&&<span className="live-dot"/>}{n.title}</h3><small className="muted"><FormatDate value={n.createdAt}/></small></div>{n.body&&<p>{n.body}</p>}{n.link&&<Link className="link" href={n.link}>查看详情 →</Link>}</article>):<Empty title="暂时没有新通知" description="收藏与站点的最新动态会出现在这里。"/>}</section>}
