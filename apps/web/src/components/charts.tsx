import type { SparkPoint, TrustVerdict, VendorRef } from '@hub/shared';
import { VERDICT_LABELS } from '@hub/shared';
import { ShieldCheck } from '@phosphor-icons/react/dist/ssr';

export function UptimeBar({ points }: { points: SparkPoint[] }) {
  const slots = Array.from({length:60},(_,i) => points[points.length-60+i]);
  return <div className="uptime-bar" role="img" aria-label={`最近 ${points.length} 次探测，${points.filter(p=>p.ok).length} 次成功；灰色为无样本`}>{slots.map((p,i)=><span key={i} className={!p?'unknown':p.ok?'ok':'fail'} title={p?`${new Date(p.t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · ${p.ok?`成功 ${p.ms??'—'}ms`:'失败'}`:'无样本'}/>)}</div>;
}
export function Sparkline({ points }: { points: SparkPoint[] }) {
  const values=points.flatMap((p,i)=>p.ms==null?[]:[{v:p.ms,x:i}]);
  if(values.length<2)return <div className="muted" style={{fontSize:11}}>样本不足</div>;
  const max=Math.max(...values.map(p=>p.v),1),min=Math.min(...values.map(p=>p.v));
  const d=values.map((p,i)=>`${i?'L':'M'}${p.x/Math.max(points.length-1,1)*200},${35-(p.v-min)/Math.max(max-min,1)*28}`).join(' ');
  return <svg className="sparkline" viewBox="0 0 200 40" role="img" aria-label="最近探测延迟趋势" preserveAspectRatio="none"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/></svg>;
}
export function TrustBadge({ score,verdict }: { score:number|null;verdict:TrustVerdict }) {
  return <span className={`badge ${verdict==='genuine'?'badge-good':verdict==='suspect'?'badge-warn':verdict==='fake'?'badge-bad':''}`} title="模型检测为多项信号综合判断，并非官方真伪证明"><ShieldCheck size={12}/>{score===null?'—':score} · {VERDICT_LABELS[verdict]}</span>;
}
export function VendorMark({ vendor }: { vendor:VendorRef|null }) {
  return <span className="vendor-mark" style={{color:vendor?.color}} title={vendor?.name??'多厂商'} aria-label={vendor?.name??'多厂商'}>{vendor?.slug==='anthropic'?'A':vendor?.slug==='google'?'G':vendor?.slug==='openai'?'O':vendor?.name.slice(0,1)??'+'}</span>;
}
