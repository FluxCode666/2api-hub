'use client';
import Link from 'next/link';
import {useState} from 'react';
import type {RankingOverview} from '@hub/shared';
import {ChannelTable} from './channel-table';
import {Empty} from './ui';
export function HomeRankings({overview}:{overview:RankingOverview}){const[index,setIndex]=useState(0);const current=overview.models[index];return <><div className="between" style={{gap:20,marginBottom:23}}><div className="tabs" role="tablist" aria-label="精选模型榜单">{overview.models.slice(0,7).map((entry,i)=><button key={entry.model.slug} role="tab" aria-selected={i===index} aria-controls="home-ranking-panel" className={`tab ${i===index?'tab-active':''}`} onClick={()=>setIndex(i)}>{entry.model.displayName}</button>)}</div></div><div id="home-ranking-panel" role="tabpanel">{current?<><div className="ranking-meta"><span><span className="live-dot"/>综合推荐 Top 3</span><Link className="link" href={`/models/${current.model.slug}`}>查看 {current.model.displayName} 全部渠道 →</Link></div><ChannelTable items={current.top}/></>:<Empty title="精选榜单正在准备中" description="渠道完成首轮探测后将在这里展示。"/>}</div></>}
