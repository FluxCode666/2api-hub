'use client';
import {useRouter} from 'next/navigation';
import type {ModelSummary} from '@hub/shared';
import {MagnifyingGlass,ArrowRight} from '@phosphor-icons/react';
export function HomeSearch({models}:{models:ModelSummary[]}){const router=useRouter();return <form className="hero-search" data-hero-reveal onSubmit={e=>{e.preventDefault();const q=String(new FormData(e.currentTarget).get('q')??'').trim();const model=models.find(m=>m.slug.toLowerCase()===q.toLowerCase()||m.displayName.toLowerCase()===q.toLowerCase());router.push(`/rankings?${model?`model=${encodeURIComponent(model.slug)}`:`q=${encodeURIComponent(q)}`}`)}}><MagnifyingGlass size={17}/><input name="q" list="home-models" placeholder="搜索模型、站点或渠道…" aria-label="搜索模型、站点或渠道"/><datalist id="home-models">{models.map(m=><option value={m.displayName} key={m.slug}>{m.slug}</option>)}</datalist><button className="icon-btn" type="submit" aria-label="搜索" style={{border:0}}><ArrowRight size={16}/></button></form>}
