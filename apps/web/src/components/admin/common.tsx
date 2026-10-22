'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowSquareOutIcon, SpinnerGapIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { apiWithHeaders, apiNoticeMessage } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';

export function AdminTable<T>({ items, columns, empty = '暂无记录' }: {
  items: T[];
  columns: { label: string; render: (item: T) => ReactNode }[];
  searchText?: (item: T) => string;
  statusOf?: (item: T) => string;
  statuses?: { value: string; label: string }[];
  empty?: string;
}) {
  return <div className="overflow-hidden rounded-xl border bg-card text-card-foreground"><Table>
    <TableHeader><TableRow>{columns.map(column => <TableHead key={column.label} className="whitespace-nowrap px-4 text-xs">{column.label}</TableHead>)}</TableRow></TableHeader>
    <TableBody>{items.map((item, index) => <TableRow key={typeof item === 'object' && item !== null && 'id' in item ? String(item.id) : index}>{columns.map(column => <TableCell key={column.label} className="px-4 py-3 align-top text-sm [&_a]:break-all [&_p]:leading-relaxed">{column.render(item)}</TableCell>)}</TableRow>)}
      {items.length === 0 && <TableRow><TableCell colSpan={columns.length} className="h-40 text-center text-muted-foreground">{empty}</TableCell></TableRow>}
    </TableBody>
  </Table></div>;
}

export function MutationButton({ path, body, method = 'PATCH', children, className, confirmation }: { path: string; body?: unknown; method?: string; children: ReactNode; className?: string; confirmation?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  async function submit() {
    setPending(true);
    try {
      const { headers } = await apiWithHeaders<unknown>(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      toast.success(apiNoticeMessage(headers) ?? '操作已完成'); setOpen(false); router.refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : '操作失败，请稍后重试'); }
    finally { setPending(false); }
  }
  const button = <Button type="button" size="sm" variant={method === 'DELETE' ? 'destructive' : 'outline'} className={className} disabled={pending} onClick={confirmation ? undefined : submit}>{pending && <SpinnerGapIcon className="animate-spin" />}{children}</Button>;
  if (!confirmation) return button;
  return <AlertDialog open={open} onOpenChange={setOpen}><AlertDialogTrigger asChild>{button}</AlertDialogTrigger><AlertDialogContent>
    <AlertDialogHeader><AlertDialogTitle>确认此项操作</AlertDialogTitle><AlertDialogDescription>{confirmation}</AlertDialogDescription></AlertDialogHeader>
    <AlertDialogFooter><AlertDialogCancel disabled={pending}>取消</AlertDialogCancel><AlertDialogAction disabled={pending} onClick={event => { event.preventDefault(); void submit(); }}>{pending ? '处理中…' : '确认操作'}</AlertDialogAction></AlertDialogFooter>
  </AlertDialogContent></AlertDialog>;
}

export function RecordLink({ href, children }: { href: string; children: ReactNode }) { return <Link href={href} className="font-medium text-primary underline-offset-4 hover:underline">{children}</Link>; }
export function DateValue({ value }: { value: string | null }) { return <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{value ? <time dateTime={value}>{new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' })}</time> : '—'}</span>; }
const labels: Record<string, string> = { active: '正常', paused: '已暂停', invalid: '已失效', draft: '草稿', pending: '审核中', approved: '已上线', rejected: '已驳回', suspended: '已下架', queued: '排队中', running: '检测中', done: '已完成', failed: '失败', canceled: '已取消', pass: '通过', fail: '未通过', untested: '未检测', visible: '公开', hidden: '已隐藏', new: '待处理', read: '已读', handled: '已处理', banned: '已封禁', user: '用户', merchant: '站长', admin: '管理员', genuine: '真模型', suspect: '存疑', fake: '疑似假模型', unknown: '未检测' };
export function Status({ value }: { value: string }) {
  const variant = ['active', 'approved', 'done', 'pass', 'genuine', 'visible', 'handled'].includes(value) ? 'success' : ['invalid', 'rejected', 'suspended', 'failed', 'fail', 'banned', 'fake'].includes(value) ? 'danger' : ['pending', 'queued', 'running', 'suspect', 'new'].includes(value) ? 'warning' : 'unknown';
  return <Badge variant={variant}>{labels[value] ?? value}</Badge>;
}
export function DataSummary({ label, value }: { label: string; value: ReactNode }) { return <div className="space-y-1"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-words text-sm font-medium">{value}</dd></div>; }
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) { return <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-primary hover:underline">{children}<ArrowSquareOutIcon className="size-3.5 shrink-0" /></a>; }
export function InlineError({ message }: { message?: string }) { return message ? <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><WarningCircleIcon className="mt-0.5 size-4 shrink-0" />{message}</p> : null; }
export const actionRowStyle = { display: 'flex', flexWrap: 'wrap' as const, gap: 6 };
export const kindLabels = { availability: '可用性', authenticity: '真伪检测', discovery: '模型发现' };
export const triggerLabels: Record<string, string> = { scheduled: '定时探测', scheduler: '定时探测', merchant: '站长发起', admin: '管理员发起', onboarding: '入驻检测', verify: '公开鉴定', system: '系统任务' };
