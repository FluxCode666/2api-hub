'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import type { ChannelListItem, TrustReportBrief, TrustVerdict } from '@hub/shared';
import { AUTH_CHECKS, AUTH_CHECK_NAME, VERDICT_LABELS } from '@hub/shared';
import { ArrowRight, CheckCircle, MinusCircle, XCircle } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { TrustStatus } from '@/components/trust-status';

type TrustBadgeProps = {
  score: number | null;
  verdict: TrustVerdict;
  report: TrustReportBrief | null;
  channelId: number;
  basis?: ChannelListItem['trustBasis'];
  model?: string;
  modelName?: string;
  fallbackReport?: TrustReportBrief | null;
  fallbackModelName?: string;
};

const unscoredExplanation = '上游临时错误或不适用，不计入得分';
const checkState = (passed: boolean | null | undefined) => passed === true ? '通过' : passed === false ? '未通过' : '未计分';

function modelLabel(model: string | undefined, name?: string) {
  if (!model) return name ?? '该模型';
  return name && name !== model ? `${name}（${model}）` : model;
}
function reportLink(channelId: number, model?: string) {
  return `/channels/${channelId}${model ? `?reportModel=${encodeURIComponent(model)}` : ''}#report`;
}
function TrustChecks({ report }: { report: TrustReportBrief }) {
  return <>
    <ul className="space-y-2.5" aria-label="八项模型检测结果">
      {AUTH_CHECKS.map(({ id, weight }) => {
        const check = report.checks.find(item => item.id === id);
        const passed = check?.passed;
        const partial = passed != null && check?.score != null && check.score > 0 && check.score < 1;
        const statusTone = passed === true ? 'text-success' : passed === false ? 'text-danger' : 'text-unknown';
        const Icon = passed === true ? CheckCircle : passed === false ? XCircle : MinusCircle;
        return <li key={id} className="space-y-1" data-check={id}>
          <div className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 font-medium">{AUTH_CHECK_NAME[id]}</span><span className={`flex shrink-0 items-center gap-1 ${statusTone}`}><Icon size={14} aria-hidden="true" />{checkState(passed)}</span><span className="w-11 shrink-0 text-right text-[10px] text-muted-foreground">权重 {weight}</span></div>
          {partial && <div className="flex items-center gap-2"><div role="progressbar" aria-label={`${AUTH_CHECK_NAME[id]}部分得分`} aria-valuenow={Math.round(check.score! * 100)} aria-valuemin={0} aria-valuemax={100} className="h-1 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-current text-success" style={{ width: `${check.score! * 100}%` }} /></div><span className="text-[10px] tabular-nums text-muted-foreground">部分得分 {(check.score! * 100).toFixed(0)}%</span></div>}
        </li>;
      })}
    </ul>
    <p className="text-[10px] leading-relaxed text-muted-foreground">未计分：{unscoredExplanation}。</p>
  </>;
}

export function TrustReportCard({ report, channelId, basis = 'primary', model, modelName, fallbackReport, fallbackModelName }: Omit<TrustBadgeProps, 'score' | 'verdict'>) {
  if (!report) return <div className="space-y-3 p-1">
    <TrustStatus score={null} verdict="unknown" />
    <h3 className="text-sm font-medium">{basis === 'model' ? `所选模型 ${modelName ?? model ?? ''} 尚未完成检测` : '该渠道尚未完成模型检测'}</h3>
    {basis === 'model' && <p className="break-words text-[11px] text-muted-foreground">基于所选模型 · {modelLabel(model, modelName)}</p>}
    <p className="text-xs leading-relaxed text-muted-foreground">平台通过连通性、协议特征、Token 计数和推理能力等八项信号交叉验证模型身份，检测后将展示逐项结果。</p>
    {basis === 'model' && fallbackReport && <section className="space-y-3 rounded-lg border bg-muted/30 p-3" aria-label="主测模型参考结果">
      <p className="text-xs leading-relaxed text-muted-foreground">主测模型 <span className="font-medium">{fallbackModelName ?? fallbackReport.model}</span> 的检测结果：{fallbackReport.score ?? '—'} · {VERDICT_LABELS[fallbackReport.verdict]}，仅供参考</p>
      <p className="break-words text-[10px] text-muted-foreground">{modelLabel(fallbackReport.model, fallbackModelName)} · <time dateTime={fallbackReport.checkedAt}>{new Date(fallbackReport.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</time></p>
      <TrustChecks report={fallbackReport} />
      <p className="text-[10px] text-muted-foreground">此参考结果不作为所选模型的可信分。</p>
    </section>}
    <Button asChild variant="link" size="sm" className="h-auto px-0"><Link href={reportLink(channelId, model)}>查看检测报告区域<ArrowRight /></Link></Button>
  </div>;

  const tone = report.verdict === 'genuine' ? 'text-success' : report.verdict === 'suspect' ? 'text-warning' : report.verdict === 'fake' ? 'text-danger' : 'text-unknown';
  const checkedAt = new Date(report.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return <div className="space-y-3 p-1">
    <header className="space-y-2">
      <div className="flex items-center justify-between gap-3"><div className={`font-mono text-3xl font-semibold tabular-nums ${tone}`}>{report.score ?? '—'}<span className="ml-1 text-xs font-normal text-muted-foreground">/ 100</span></div><TrustStatus score={report.score} verdict={report.verdict} /></div>
      <p className="break-words text-[11px] leading-relaxed text-muted-foreground">{basis === 'model' ? '基于所选模型' : '基于主测模型'} · <span className="text-foreground">{modelLabel(report.model, modelName)}</span> · <time dateTime={report.checkedAt}>{checkedAt}</time></p>
    </header>
    <Separator />
    <TrustChecks report={report} />
    <Separator />
    <footer className="space-y-2"><p className="text-[10px] leading-relaxed text-muted-foreground">得分 = 通过项权重 / 已执行项权重 × 100<br />部分得分按比例计入；检测结论为多项信号综合判断。</p><Button asChild variant="link" size="sm" className="h-auto px-0"><Link href={reportLink(channelId, report.model)}>查看完整检测报告<ArrowRight /></Link></Button></footer>
  </div>;
}

export function TrustBadge({ score, verdict, report, channelId, basis = 'primary', model, modelName, fallbackReport, fallbackModelName }: TrustBadgeProps) {
  // 摘要与聚合统计刷新可能存在时间差，徽章始终与打开的报告保持同源。
  if (report) { score = report.score; verdict = report.verdict; }
  // 所选模型没有报告时，主徽章始终显示未检测，主测结果仅作参考。
  if (basis === 'model' && !report) { score = null; verdict = 'unknown'; }
  const context = { basis, model, modelName, fallbackReport, fallbackModelName };
  const [open, setOpen] = useState(false);
  const [touch, setTouch] = useState(false);
  const id = useId();
  useEffect(() => {
    const media = window.matchMedia('(hover: none), (pointer: coarse)');
    const update = () => { setTouch(media.matches); setOpen(false); };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const description = report ? `${VERDICT_LABELS[report.verdict]}，${report.score ?? '无'}分。${AUTH_CHECKS.map(check => `${AUTH_CHECK_NAME[check.id]}${checkState(report.checks.find(item => item.id === check.id)?.passed)}`).join('；')}。未计分表示${unscoredExplanation}。` : basis === 'model' ? `所选模型 ${modelName ?? model ?? ''} 尚未完成检测。${fallbackReport ? `主测模型 ${fallbackModelName ?? fallbackReport.model} 的检测结果 ${fallbackReport.score} 分，仅供参考。` : ''}` : '该渠道尚未完成模型检测。';
  const trigger = <Button type="button" variant="ghost" className="h-auto min-h-11 rounded-full p-0 hover:bg-transparent sm:min-h-0" aria-label={`${basis === 'model' ? '所选模型' : '主测模型'}可信分 ${score ?? '未检测'}，${VERDICT_LABELS[verdict]}，查看检测项`} aria-describedby={`${id}-description`} aria-expanded={open} aria-controls={open ? `${id}-content` : undefined} data-trust-channel={channelId} data-trust-verdict={verdict} data-trust-basis={basis} data-trust-model={model ?? report?.model}
    onFocus={touch ? undefined : event => { event.preventDefault(); setOpen(true); }}
    onBlur={touch ? undefined : event => { event.preventDefault(); if (!document.getElementById(`${id}-content`)?.contains(event.relatedTarget)) setOpen(false); }}
    onClick={touch ? undefined : () => setOpen(current => !current)}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
      if (!touch && event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); requestAnimationFrame(() => document.getElementById(`${id}-content`)?.querySelector('a')?.focus()); }
    }}><TrustStatus score={score} verdict={verdict} /></Button>;
  const contentProps = { id: `${id}-content`, className: 'w-80 max-w-[calc(100vw-24px)] max-h-[var(--radix-popper-available-height)] overflow-y-auto p-3', align: 'center' as const, sideOffset: 8, collisionPadding: 12 };
  return <><span id={`${id}-description`} className="sr-only">{description}</span>{touch ? <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild>{trigger}</PopoverTrigger><PopoverContent {...contentProps} aria-label="模型检测摘要"><TrustReportCard report={report} channelId={channelId} {...context} /></PopoverContent></Popover> : <HoverCard open={open} onOpenChange={setOpen} openDelay={150} closeDelay={180}><HoverCardTrigger asChild>{trigger}</HoverCardTrigger><HoverCardContent {...contentProps} side="left" role="region" aria-label="模型检测摘要" onEscapeKeyDown={() => setOpen(false)}><TrustReportCard report={report} channelId={channelId} {...context} /></HoverCardContent></HoverCard>}</>;
}
