'use client';
import {useEffect,useId,useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import type {ModelSummary,VendorSummary} from '@hub/shared';
import {PROTOCOL_LABELS,SORT_PRESETS,DEFAULT_SORT_ORDER} from '@hub/shared';
import {MagnifyingGlass,SlidersHorizontal,CaretDown,X,SpinnerGap} from '@phosphor-icons/react';
import {searchString,type SearchValues} from '@/lib/query';

function ModelPicker({models,value,readOnly,onChange}:{models:ModelSummary[];value:string;readOnly:boolean;onChange:(slug:string|undefined)=>void}){
 const listId=useId();
 const selected=models.find(model=>model.slug===value);
 const displayName=selected?.displayName??value;
 const[text,setText]=useState(displayName);
 useEffect(()=>{setText(displayName)},[displayName]);
 const optionLabel=(model:ModelSummary)=>`${model.displayName} · ${model.vendor.nameZh??model.vendor.name}`;
 function change(text:string){
  setText(text);
  const query=text.trim().toLocaleLowerCase();
  if(!query){onChange(undefined);return}
  const model=models.find(model=>model.slug.toLocaleLowerCase()===query)
   ??models.find(model=>optionLabel(model).toLocaleLowerCase()===query)
   ??models.find(model=>model.displayName.toLocaleLowerCase()===query);
  // 输入搜索词时只过滤候选；只有目录模型的 slug 才进入 URL。
  if(model){setText(model.displayName);onChange(model.slug)}
 }
 const vendor=selected?.vendor;
 return <div className={`ranking-model-select ${vendor?'has-vendor':''}`}>
  {vendor&&<span className="ranking-model-vendor" role="img" aria-label={`厂商：${vendor.nameZh??vendor.name}`} title={vendor.nameZh??vendor.name} style={{backgroundColor:vendor.color}}/>}
  <input list={readOnly?undefined:listId} className="input" name="model" value={text} readOnly={readOnly} onChange={event=>change(event.target.value)} onBlur={()=>setText(displayName)} placeholder="搜索或选择模型" aria-label="选择模型" title={selected?optionLabel(selected):undefined} autoComplete="off"/>
  {!readOnly&&<datalist id={listId}>{models.map(model=><option key={model.slug} value={optionLabel(model)} label={model.slug}/>)}</datalist>}
 </div>
}

export function RankingControls({models,vendors,values,lockedModel,lockedVendor,base='/rankings'}:{models:ModelSummary[];vendors:VendorSummary[];values:SearchValues;lockedModel?:string;lockedVendor?:string;base?:string}){
 const router=useRouter();const[filters,setFilters]=useState(values);const[advanced,setAdvanced]=useState(false);const[isPending,startTransition]=useTransition();const timer=useRef<ReturnType<typeof setTimeout>|null>(null);const url=searchString(values);const filtersRef=useRef(filters);
 useEffect(()=>{if(timer.current)return;setFilters(values);filtersRef.current=values},[url]);
 useEffect(()=>{function syncHistory(){if(timer.current)clearTimeout(timer.current);timer.current=null;const next:SearchValues={...Object.fromEntries(new URLSearchParams(location.search)),...(lockedModel?{model:lockedModel}:{}),...(lockedVendor?{vendor:lockedVendor}:{})};setFilters(next);filtersRef.current=next}window.addEventListener('popstate',syncHistory);return()=>{if(timer.current)clearTimeout(timer.current);window.removeEventListener('popstate',syncHistory)}},[lockedModel,lockedVendor]);
 const val=(key:string)=>typeof filters[key]==='string'?filters[key] as string:'';
 function update(change:Record<string,string|undefined>,debounce=false){if(timer.current)clearTimeout(timer.current);const next={...filtersRef.current,...change,page:undefined,...(lockedModel?{model:lockedModel}:{}),...(lockedVendor?{vendor:lockedVendor}:{})};filtersRef.current=next;setFilters(next);const navigate=()=>{timer.current=null;startTransition(()=>router.push(`${base}?${searchString(next)}`,{scroll:false}))};if(debounce)timer.current=setTimeout(navigate,300);else navigate()}
 const activeAdvanced=['maxRatio','protocol','minTrust','minUptime','stableOnly'].filter(k=>val(k)).length;
 return <div className="ranking-controls" aria-busy={isPending}><div className="ranking-controls-top">{!(lockedModel||lockedVendor)&&<div className="tabs vendor-tabs" aria-label="模型厂商"><button className={`tab ${!val('vendor')?'tab-active':''}`} onClick={()=>update({vendor:undefined})}>全部厂商</button>{vendors.map(v=><button key={v.slug} onClick={()=>update({vendor:v.slug})} className={`tab ${val('vendor')===v.slug?'tab-active':''}`}>{v.nameZh??v.name}</button>)}</div>}{(lockedModel||lockedVendor)&&<span className="muted" style={{fontSize:11,marginRight:'auto'}}>{lockedModel?'当前模型渠道':`${vendors.find(v=>v.slug===lockedVendor)?.name??lockedVendor} 渠道`}</span>}<div className="ranking-search"><MagnifyingGlass size={15}/><input className="input" name="q" value={val('q')} onChange={e=>update({q:e.target.value},true)} placeholder="搜索站点或渠道" aria-label="搜索站点或渠道"/></div><ModelPicker models={models} value={lockedModel??val('model')} readOnly={!!lockedModel} onChange={model=>update({model},true)}/></div><div className="ranking-controls-bottom"><div className="sort-presets" role="group" aria-label="排序方式">{SORT_PRESETS.map(p=><button key={p.id} onClick={()=>update({sort:p.sort,order:p.order})} aria-pressed={(val('sort')||'recommend')===p.sort} className={`sort-preset ${(val('sort')||'recommend')===p.sort?'active':''}`}>{p.label}</button>)}</div><div className="row" style={{gap:10,marginLeft:'auto'}}>{isPending&&<span className="muted" role="status" aria-label="更新榜单中"><SpinnerGap size={14} className="animate-spin"/></span>}<button className={`more-filters ${advanced?'active':''}`} onClick={()=>setAdvanced(!advanced)} aria-expanded={advanced} aria-controls="rankings-advanced"><SlidersHorizontal size={13}/>更多筛选{activeAdvanced>0&&<span className="filter-count mono">{activeAdvanced}</span>}<CaretDown size={11} style={{transform:advanced?'rotate(180deg)':'none'}}/></button>{Object.entries(filters).some(([key,value])=>Boolean(value)&&!(key==='model'&&lockedModel)&&!(key==='vendor'&&lockedVendor))&&<button className="more-filters" onClick={()=>{if(timer.current)clearTimeout(timer.current);timer.current=null;const reset={...(lockedModel?{model:lockedModel}:{}),...(lockedVendor?{vendor:lockedVendor}:{})};setFilters(reset);filtersRef.current=reset;startTransition(()=>router.push(`${base}?${searchString(reset)}`,{scroll:false}))}}><X size={12}/>重置</button>}</div></div>{advanced&&<div id="rankings-advanced" className="rankings-advanced"><label className="field">实际倍率上限<input type="number" min="0" step="0.01" name="maxRatio" value={val('maxRatio')} onChange={e=>update({maxRatio:e.target.value},true)} className="input" placeholder="不限"/></label><label className="field">API 协议<select name="protocol" className="select" value={val('protocol')} onChange={e=>update({protocol:e.target.value})}><option value="">全部协议</option>{Object.entries(PROTOCOL_LABELS).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></label><label className="field">最低可信分<select name="minTrust" className="select" value={val('minTrust')} onChange={e=>update({minTrust:e.target.value})}><option value="">不限</option><option value="80">80 分及以上</option><option value="95">95 分及以上</option></select></label><label className="field">最低可用率<select name="minUptime" className="select" value={val('minUptime')} onChange={e=>update({minUptime:e.target.value})}><option value="">不限</option><option value="0.95">95% 及以上</option><option value="0.99">99% 及以上</option><option value="1">100%</option></select></label><label className="field">其他排序<select className="select" aria-label="其他排序" value={['ratio','updated'].includes(val('sort'))?val('sort'):''} onChange={e=>update({sort:e.target.value||'recommend',order:DEFAULT_SORT_ORDER[e.target.value==='ratio'?'ratio':e.target.value==='updated'?'updated':'recommend']})}><option value="">使用预设</option><option value="ratio">实际倍率优先</option><option value="updated">最近更新</option></select></label><label className="filter-check"><input type="checkbox" name="stableOnly" checked={val('stableOnly')==='true'} onChange={e=>update({stableOnly:e.target.checked?'true':undefined})}/>只看稳定</label></div>}</div>
}
