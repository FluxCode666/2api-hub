import type { ReactNode } from 'react';

export function PageHead({ title, description, eyebrow, children }: { title: string; description?: string; eyebrow?: string; children?: ReactNode }) {
  return <div className="page-head"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{children}</div>;
}
export function Metric({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return <div className="metric"><div className="metric-label">{label}</div><div className="metric-value mono">{value}</div>{detail && <div className="metric-detail">{detail}</div>}</div>;
}
export function Empty({ title, description }: { title: string; description?: string }) {
  return <div className="empty"><h3>{title}</h3>{description && <p>{description}</p>}</div>;
}
const labels: Record<string, string> = { active:'正常', paused:'已暂停', invalid:'已失效', draft:'草稿', pending:'审核中', approved:'已上线', rejected:'已驳回', suspended:'已下架', queued:'排队中', running:'检测中', done:'已完成', failed:'失败', canceled:'已取消', pass:'通过', fail:'未通过', untested:'未检测', visible:'显示中', hidden:'已隐藏', new:'待处理', read:'已读', handled:'已处理', banned:'已封禁', user:'用户', merchant:'站长', admin:'管理员', genuine:'真模型', suspect:'存疑', fake:'疑似假模型', unknown:'未检测' };
export function StatusBadge({ status }: { status: string }) {
  const good = ['active','approved','pass','done','visible','handled','genuine'].includes(status);
  const bad = ['invalid','rejected','suspended','failed','fail','banned','fake'].includes(status);
  const warn = ['pending','running','queued','suspect','new'].includes(status);
  return <span className={`badge ${good?'badge-good':bad?'badge-bad':warn?'badge-warn':''}`}>{labels[status] ?? status}</span>;
}
export function FormatDate({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">尚无记录</span>;
  return <time dateTime={value}>{new Intl.DateTimeFormat('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Shanghai'}).format(new Date(value))}</time>;
}
export function money(n: number | null | undefined) { return n == null ? '—' : `¥${n.toLocaleString('zh-CN',{maximumFractionDigits:3})}`; }
export function percent(n: number | null | undefined) { return n == null ? '暂无数据' : `${(n*100).toFixed(2)}%`; }
export function ms(n: number | null | undefined) { return n == null ? '—' : n >= 1000 ? `${(n/1000).toFixed(2)} s` : `${Math.round(n)} ms`; }
