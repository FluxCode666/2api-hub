'use client';
import {useState} from 'react';
import type {ModelSummary} from '@hub/shared';
import {CaretUpDown,Check,X} from '@phosphor-icons/react';
import {Button} from '@/components/ui/button';
import {Popover,PopoverContent,PopoverTrigger} from '@/components/ui/popover';
import {Command,CommandEmpty,CommandGroup,CommandInput,CommandItem,CommandList} from '@/components/ui/command';
import {vendorColor} from '@/lib/theme';

export function ModelCombobox({models,value,onChange,readOnly=false}:{models:ModelSummary[];value:string;onChange:(slug:string|undefined)=>void;readOnly?:boolean}){
 const[open,setOpen]=useState(false);const selected=models.find(model=>model.slug===value);
 return <Popover open={open&&!readOnly} onOpenChange={setOpen}><PopoverTrigger asChild><Button type="button" variant="outline" role="combobox" aria-label="选择模型" aria-expanded={open} aria-readonly={readOnly} disabled={readOnly} className="w-full justify-between text-xs disabled:opacity-100" title={selected?`${selected.displayName} · ${selected.vendor.name}`:undefined}><span className="flex min-w-0 items-center gap-2">{selected&&<span className="size-2 shrink-0 rounded-full" style={{background:vendorColor(selected.vendor.slug)}}/>}<span className="truncate">{selected?.displayName??(value||'搜索或选择模型')}</span></span>{!readOnly&&<CaretUpDown className="size-3 opacity-60"/>}</Button></PopoverTrigger><PopoverContent className="w-[min(320px,90vw)] p-0" align="end"><Command><CommandInput placeholder="搜索模型名称或标识"/><CommandList><CommandEmpty>没有找到目录模型。</CommandEmpty><CommandGroup><CommandItem value="全部模型" onSelect={()=>{onChange(undefined);setOpen(false)}}><X/>全部模型{!value&&<Check className="ml-auto"/>}</CommandItem>{models.map(model=><CommandItem key={model.slug} value={`${model.displayName} ${model.slug} ${model.vendor.name} ${model.vendor.nameZh??''}`} onSelect={()=>{onChange(model.slug);setOpen(false)}}><span className="size-2 shrink-0 rounded-full" style={{background:vendorColor(model.vendor.slug)}}/><span className="flex flex-col"><span>{model.displayName}</span><span className="text-[10px] text-muted-foreground">{model.vendor.name} · {model.slug}</span></span>{value===model.slug&&<Check className="ml-auto"/>}</CommandItem>)}</CommandGroup></CommandList></Command></PopoverContent></Popover>
}
