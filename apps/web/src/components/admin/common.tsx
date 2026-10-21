'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api/client';
import { StatusBadge } from '@/components/ui';

export function AdminTable<T>({ items, columns, searchText, statusOf, statuses = [], empty = '暂无记录' }: {
  items: T[];
  columns: { label: string; render: (item: T) => ReactNode }[];
  searchText: (item: T) => string;
  statusOf?: (item: T) => string;
  statuses?: { value: string; label: string }[];
  empty?: string;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const filtered = items.filter(item => searchText(item).toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (!status || statusOf?.(item) === status));
  return <div className="stack">
    <div className="row between" style={{ flexWrap: 'wrap', gap: 12 }}>
      <input className="input" aria-label="搜索当前页记录" placeholder="在当前页搜索名称、内容或编号" value={query} onChange={event => setQuery(event.target.value)} style={{ maxWidth: 360 }} />
      <div className="row" style={{ gap: 12 }}>
        {statuses.length > 0 && <select className="select" aria-label="筛选状态" value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{statuses.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}
        <span className="muted mono">{filtered.length} 条</span>
      </div>
    </div>
    <div className="table-wrap"><table className="data-table"><thead><tr>{columns.map(column => <th key={column.label}>{column.label}</th>)}</tr></thead><tbody>{filtered.map((item, index) => <tr key={index}>{columns.map(column => <td key={column.label}>{column.render(item)}</td>)}</tr>)}</tbody></table>{filtered.length === 0 && <div className="empty">{empty}</div>}</div>
  </div>;
}

export function MutationButton({ path, body, method = 'PATCH', children, className = 'btn btn-small', confirmation }: { path: string; body?: unknown; method?: string; children: ReactNode; className?: string; confirmation?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  async function submit() {
    if (confirmation && !window.confirm(confirmation)) return;
    setPending(true); setMessage('');
    try { await api<unknown>(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); setMessage('操作成功'); router.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { setPending(false); }
  }
  return <span><button type="button" className={className} disabled={pending} onClick={submit}>{pending ? '处理中…' : children}</button>{message && <span role="status" className="muted" style={{ display: 'block', marginTop: 6, maxWidth: 240 }}>{message}</span>}</span>;
}

export function RecordLink({ href, children }: { href: string; children: ReactNode }) { return <Link href={href} style={{ color: 'var(--accent)' }}>{children}</Link>; }
export function DateValue({ value }: { value: string | null }) { return <span className="mono muted">{value ? <time dateTime={value}>{new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' })}</time> : '—'}</span>; }
export function Status({ value }: { value: string }) { return <StatusBadge status={value} />; }
export const actionRowStyle = { display: 'flex', flexWrap: 'wrap' as const, gap: 6 };
