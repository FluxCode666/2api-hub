'use client';
import Link from 'next/link';
import {useState} from 'react';
import type {RankingOverview} from '@hub/shared';
import {ChannelTable} from './channel-table';
import {Empty} from './page-kit';
import {Tabs,TabsList,TabsTrigger} from '@/components/ui/tabs';
import {Button} from '@/components/ui/button';
export function HomeRankings({overview}:{overview:RankingOverview}){const[index,setIndex]=useState(0);const current=overview.models[index];return <><div className="between" style={{gap:20,marginBottom:23}}><Tabs value={String(index)} onValueChange={value=>setIndex(Number(value))}><TabsList aria-label="精选模型榜单" className="max-w-full overflow-x-auto">{overview.models.slice(0,7).map((entry,i)=><TabsTrigger key={entry.model.slug} value={String(i)} aria-controls="home-ranking-panel">{entry.model.displayName}</TabsTrigger>)}</TabsList></Tabs></div><div id="home-ranking-panel" role="tabpanel">{current?<><div className="ranking-meta"><span><span className="live-dot"/>综合推荐 Top 3</span><Button asChild variant="link" size="sm"><Link href={`/models/${current.model.slug}`}>查看 {current.model.displayName} 全部渠道 →</Link></Button></div><ChannelTable items={current.top}/></>:<Empty title="精选榜单正在准备中" description="渠道完成首轮探测后将在这里展示。"/>}</div></>}
