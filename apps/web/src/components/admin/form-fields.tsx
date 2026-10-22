'use client';

import type { Control, FieldPath, FieldValues } from 'react-hook-form';
import { z } from 'zod';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type FieldProps<T extends FieldValues> = { control: Control<T>; name: FieldPath<T>; label: string; description?: string };
export function AdminInput<T extends FieldValues>({ control, name, label, description, type = 'text', readOnly, placeholder, min, max, step }: FieldProps<T> & { type?: string; readOnly?: boolean; placeholder?: string; min?: number; max?: number; step?: number | 'any' }) {
  return <FormField control={control} name={name} render={({ field }) => <FormItem><FormLabel>{label}</FormLabel><FormControl><Input {...field} value={field.value ?? ''} type={type} readOnly={readOnly} placeholder={placeholder} min={min} max={max} step={step} autoComplete={type === 'password' ? 'new-password' : undefined} className={type === 'number' ? 'font-mono tabular-nums' : undefined} /></FormControl>{description && <FormDescription>{description}</FormDescription>}<FormMessage /></FormItem>} />;
}
export function AdminTextarea<T extends FieldValues>({ control, name, label, description, rows = 4 }: FieldProps<T> & { rows?: number }) {
  return <FormField control={control} name={name} render={({ field }) => <FormItem><FormLabel>{label}</FormLabel><FormControl><Textarea {...field} value={field.value ?? ''} rows={rows} /></FormControl>{description && <FormDescription>{description}</FormDescription>}<FormMessage /></FormItem>} />;
}
export function AdminSelect<T extends FieldValues>({ control, name, label, description, options, disabled }: FieldProps<T> & { options: { value: string; label: string }[]; disabled?: boolean }) {
  return <FormField control={control} name={name} render={({ field }) => <FormItem><FormLabel>{label}</FormLabel><Select onValueChange={value => field.onChange(value === '__none__' ? '' : value)} value={field.value || '__none__'} disabled={disabled}><FormControl><SelectTrigger className="w-full"><SelectValue placeholder="请选择" /></SelectTrigger></FormControl><SelectContent>{options.map(option => <SelectItem key={option.value || '__none__'} value={option.value || '__none__'}>{option.label}</SelectItem>)}</SelectContent></Select>{description && <FormDescription>{description}</FormDescription>}<FormMessage /></FormItem>} />;
}
export function AdminSwitch<T extends FieldValues>({ control, name, label, description }: FieldProps<T>) {
  return <FormField control={control} name={name} render={({ field }) => <FormItem className="flex items-center justify-between gap-4 rounded-lg border p-3"><div className="space-y-1"><FormLabel>{label}</FormLabel>{description && <FormDescription>{description}</FormDescription>}</div><FormControl><Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} /></FormControl><FormMessage /></FormItem>} />;
}
export const requiredText = (label: string, max = 500) => z.string().trim().min(1, `请填写${label}`).max(max, `${label}最多 ${max} 个字符`);
export const numberText = (label: string, min: number, max = Number.MAX_SAFE_INTEGER, integer = false, optional = false) => z.string().refine(value => optional && value.trim() === '' || value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max && (!integer || Number.isInteger(Number(value))), `${label}需为 ${min}–${max === Number.MAX_SAFE_INTEGER ? '有效上限' : max} 之间的${integer ? '整数' : '数值'}`);
export const urlText = (label: string, optional = true) => z.string().trim().refine(value => optional && !value || (() => { try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; } })(), `请填写有效的${label}（http 或 https）`);
export const splitValues = (value: string) => value.split(/[\n,，]/).map(item => item.trim()).filter(Boolean);
export const optionalNumber = (value: string) => value.trim() === '' ? null : Number(value);
