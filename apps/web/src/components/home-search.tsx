'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import type {ModelSummary} from '@hub/shared';
import {MagnifyingGlass,ArrowRight} from '@phosphor-icons/react';
import {Button} from '@/components/ui/button';
import {Popover,PopoverContent,PopoverTrigger} from '@/components/ui/popover';
import {Command,CommandInput,CommandItem,CommandGroup,CommandList,CommandEmpty} from '@/components/ui/command';
export function HomeSearch({models}:{models:ModelSummary[]}){
 const router=useRouter();const[open,setOpen]=useState(false);const[query,setQuery]=useState('');
 function search(model?:string){setOpen(false);router.push(`/rankings?${model?`model=${encodeURIComponent(model)}`:`q=${encodeURIComponent(query.trim())}`}`)}
 return <div className="hero-search border-0 bg-transparent p-0" data-hero-reveal><Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button variant="outline" role="combobox" aria-expanded={open} className="h-12 w-full justify-between px-4 text-xs font-normal text-muted-foreground"><span className="flex items-center gap-3"><MagnifyingGlass/>搜索模型、站点或渠道…</span><ArrowRight/></Button></PopoverTrigger><PopoverContent className="w-[min(510px,calc(100vw-40px))] p-0"><Command><CommandInput value={query} onValueChange={setQuery} placeholder="搜索模型、站点或渠道…"/><CommandList><CommandEmpty>没有匹配的模型。</CommandEmpty>{query&&<CommandGroup><CommandItem value={query} onSelect={()=>search()}>搜索站点或渠道「{query}」<ArrowRight className="ml-auto"/></CommandItem></CommandGroup>}<CommandGroup heading="精选模型">{models.map(model=><CommandItem value={`${model.displayName} ${model.slug} ${model.vendor.name}`} key={model.slug} onSelect={()=>search(model.slug)}><span>{model.displayName}</span><span className="ml-auto text-xs text-muted-foreground">{model.vendor.name}</span></CommandItem>)}</CommandGroup></CommandList></Command></PopoverContent></Popover></div>
}
