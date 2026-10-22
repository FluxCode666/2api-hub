'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MagnifyingGlassIcon, ArrowCounterClockwiseIcon } from '@phosphor-icons/react';
import type { SearchValues } from '@/lib/query';
import { searchString } from '@/lib/query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Filter = { key: string; label: string; options?: { value: string; label: string }[]; type?: 'text' | 'number'; placeholder?: string; defaultValue?: string };
export function AdminFilters({ base, values, filters, searchLabel = '搜索全部记录' }: { base: string; values: SearchValues; filters: Filter[]; searchLabel?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(filters.map(filter => [filter.key, typeof values[filter.key] === 'string' ? values[filter.key] as string : filter.defaultValue ?? ''])));
  function apply(next: Record<string, string>) { startTransition(() => router.push(`${base}?${searchString(values, { ...next, page: undefined })}`, { scroll: false })); }
  return <form className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4" onSubmit={event => { event.preventDefault(); apply(draft); }}>
    {filters.map(filter => <div className={filter.key === 'q' ? 'min-w-48 flex-1 space-y-2' : 'min-w-32 space-y-2'} key={filter.key}><Label htmlFor={`filter-${filter.key}`}>{filter.key === 'q' ? searchLabel : filter.label}</Label>{filter.options ? <Select value={draft[filter.key] || '__all__'} onValueChange={value => { const next = { ...draft, [filter.key]: value === '__all__' ? '' : value }; setDraft(next); apply(next); }}><SelectTrigger id={`filter-${filter.key}`} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{!filter.defaultValue && <SelectItem value="__all__">全部{filter.label}</SelectItem>}{filter.options.map(option => <SelectItem value={option.value} key={option.value}>{option.label}</SelectItem>)}</SelectContent></Select> : <Input id={`filter-${filter.key}`} type={filter.type ?? 'text'} min={filter.type === 'number' ? 1 : undefined} value={draft[filter.key] ?? ''} onChange={event => setDraft({ ...draft, [filter.key]: event.target.value })} placeholder={filter.placeholder ?? '输入关键词'} />}</div>)}
    <Button type="submit" disabled={pending}><MagnifyingGlassIcon />应用筛选</Button><Button type="button" variant="ghost" disabled={pending} onClick={() => { setDraft(Object.fromEntries(filters.map(filter => [filter.key, filter.defaultValue ?? '']))); startTransition(() => router.push(`${base}?${searchString({ pageSize: values.pageSize })}`, { scroll: false })); }}><ArrowCounterClockwiseIcon />重置</Button>
  </form>;
}
