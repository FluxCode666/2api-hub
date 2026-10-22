import type { SparkPoint, VendorRef } from '@hub/shared';
export { TrustBadge } from '@/components/trust-badge';
import {Tooltip,TooltipTrigger,TooltipContent} from '@/components/ui/tooltip';
import {vendorColor} from '@/lib/theme';
export function UptimeBar({ points }: { points: SparkPoint[] }) {
  const ordered = [...points].sort((a,b) => Date.parse(a.t)-Date.parse(b.t)).slice(-60);
  const slots = Array.from({length:60},(_,i) => ordered[ordered.length-60+i]);
  return <div className="uptime-bar" role="img" aria-label={`最近 ${points.length} 次探测，${points.filter(p=>p.ok).length} 次成功；绿为成功，酒红斜纹为失败，灰色为无样本`}>{slots.map((p,i)=><Tooltip key={i}><TooltipTrigger asChild><span tabIndex={0} className={!p?'unknown':p.ok?'ok':'fail'}/></TooltipTrigger><TooltipContent>{p?`${new Date(p.t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · ${p.ok?`成功 ${p.ms??'—'}ms`:'失败'}`:'无样本'}</TooltipContent></Tooltip>)}</div>;
}
export function Sparkline({ points }: { points: SparkPoint[] }) {
  const ordered=[...points].sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  const values=ordered.flatMap((p,i)=>p.ms==null?[]:[{v:p.ms,x:i}]);
  if(values.length<2)return <div className="muted" style={{fontSize:11}}>样本不足</div>;
  const max=Math.max(...values.map(p=>p.v),1),min=Math.min(...values.map(p=>p.v));
  const d=values.map((p,i)=>`${i?'L':'M'}${p.x/Math.max(points.length-1,1)*200},${35-(p.v-min)/Math.max(max-min,1)*28}`).join(' ');
  return <svg className="sparkline" viewBox="0 0 200 40" role="img" aria-label="最近探测延迟趋势" preserveAspectRatio="none"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/></svg>;
}
export function VendorMark({ vendor }: { vendor:VendorRef|null }) {
  return <span className="vendor-mark" style={{color:vendorColor(vendor?.slug)}} title={vendor?.name??'多厂商'} aria-label={vendor?.name??'多厂商'}>{vendor?.slug==='anthropic'?'A':vendor?.slug==='google'?'G':vendor?.slug==='openai'?'O':vendor?.name.slice(0,1)??'+'}</span>;
}
