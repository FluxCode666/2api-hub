'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import type { UpdateTask, UpdateTaskStatus } from '@hub/shared';
import { ArrowSquareOut, ArrowClockwise, ArrowCounterClockwise, CheckCircle, Circle, CircleNotch, Info, WarningCircle } from '@phosphor-icons/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { isUpdating, useSystemVersion } from './use-system-version';

const steps = [
  ['checking', '检查'], ['downloading', '下载'], ['verifying', '校验'],
  ['extracting', '解压'], ['switching', '切换'], ['restarting', '重启'],
] as const;
const statusName: Record<UpdateTaskStatus, string> = { checking: '检查更新环境', downloading: '下载发布包', verifying: '校验发布包', extracting: '解压发布包', switching: '切换版本', restarting: '等待服务重启', succeeded: '更新完成', failed: '更新失败', rolled_back: '已自动回退' };
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未提供';
const percent = (task: UpdateTask) => task.progress === null ? null : Math.round(Math.min(1, Math.max(0, task.progress)) * 100);

function TaskProgress({ task }: { task: UpdateTask }) {
  const active = steps.findIndex(([key]) => key === task.status);
  const progress = percent(task);
  return <section className="rounded-xl border bg-muted/40 p-4" aria-label="版本更新进度">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm" aria-live="polite" aria-atomic="true" role="status">
      <strong className="font-medium">{task.kind === 'rollback' ? '回退至' : '更新至'} <span className="font-mono">{task.targetVersion}</span></strong>
      <span className="text-muted-foreground">{statusName[task.status]}{task.status === 'downloading' && progress !== null ? ` · ${progress}%` : ''}</span>
    </div>
    <ol className="m-0 grid list-none grid-cols-3 gap-3 p-0 sm:grid-cols-6" aria-label="更新步骤">{steps.map(([key, label], index) => {
      const completed = task.status === 'succeeded' || active > index;
      const current = key === task.status;
      return <li key={key} aria-current={current ? 'step' : undefined} className={cn('flex items-center gap-2 text-xs sm:flex-col sm:items-start', completed ? 'text-success' : current ? 'font-medium text-foreground' : 'text-muted-foreground')}>
        {completed ? <CheckCircle className="size-5 shrink-0" weight="fill" /> : current ? <CircleNotch className="size-5 shrink-0 motion-safe:animate-spin" /> : <Circle className="size-5 shrink-0" />}
        <span>{label}<span className="sr-only">{completed ? '：已完成' : current ? '：进行中' : '：等待执行'}</span></span>
      </li>;
    })}</ol>
    {task.status === 'downloading' && <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-border" role="progressbar" aria-label="发布包下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}><div className="h-full rounded-full bg-unknown transition-[width] motion-reduce:transition-none" style={{ width: `${progress ?? 0}%` }} /></div>}
    <p className="mt-4 text-xs text-muted-foreground">{task.status === 'restarting' ? '服务正在重新启动，短暂连接失败属正常情况。正在自动检测健康状态，最长等待 3 分钟。' : task.message ?? '可关闭此窗口，更新将在后台继续。请勿重复提交任务。'}</p>
  </section>;
}

function TaskResult({ task }: { task: UpdateTask }) {
  if (isUpdating(task)) return null;
  const rolledBack = task.status === 'rolled_back';
  const success = task.status === 'succeeded';
  return <Alert className={cn(success ? 'border-success/30 text-success' : rolledBack ? 'border-warning/30 text-warning' : 'border-danger/30 text-danger')}>
    {success ? <CheckCircle /> : <WarningCircle />}
    <AlertTitle>{success ? `${task.kind === 'rollback' ? '已回退' : '已更新'}至 ${task.targetVersion}` : rolledBack ? `新版本启动失败，已自动回退到 ${task.fromVersion}` : '更新失败'}</AlertTitle>
    <AlertDescription className="text-current">{task.message ?? (success ? '服务健康检查通过。' : '当前版本仍可使用，请检查服务日志后再试。')}</AlertDescription>
  </Alert>;
}

const VersionContext = createContext<ReturnType<typeof useSystemVersion> | null>(null);
export function SystemVersionProvider({ mockEnabled, children }: { mockEnabled: boolean; children: ReactNode }) {
  const version = useSystemVersion(mockEnabled);
  return <VersionContext.Provider value={version}>{children}</VersionContext.Provider>;
}

export function SystemVersionControl() {
  const version = useContext(VersionContext);
  if (!version) throw new Error('系统版本组件需要 SystemVersionProvider');
  const { info, error, busy, timedOut, refresh, start, retry } = version;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<'update' | 'rollback' | null>(null);
  const [checking, setChecking] = useState(false);
  const running = isUpdating(info?.task);
  const locked = running || busy;
  const tip = running ? `正在${info?.task?.kind === 'rollback' ? '回退' : '更新'}：${statusName[info!.task!.status]}` : info?.updateAvailable ? `有新版本 ${info.latest?.version}` : error ? '版本查询失败，点击重试' : '查看系统版本';
  const rollbackUnavailable = !info?.previousVersion || !!info.reason?.includes('开发环境');

  async function check() { if (checking) return; setChecking(true); try { await refresh(true); } finally { setChecking(false); } }
  return <>
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip><TooltipTrigger asChild><DialogTrigger asChild><Button variant="ghost" size="sm" className="mx-2 h-7 w-fit max-w-[calc(100%-1rem)] px-0 group-data-[collapsible=icon]:mx-auto" aria-label={`系统版本 ${info?.current.version ?? '查询中'}，${tip}`}>
        <Badge variant={running ? 'unknown' : 'outline'} className="gap-1.5 font-mono text-[10px] group-data-[collapsible=icon]:px-1">
          {running && <CircleNotch className="motion-safe:animate-spin" />}
          <span className="group-data-[collapsible=icon]:hidden">{info?.current.version ?? (error ? '版本查询失败' : '查询版本…')}</span>
          <span className="hidden group-data-[collapsible=icon]:inline">v</span>
          {info?.updateAvailable && !running && <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />}
        </Badge>
      </Button></DialogTrigger></TooltipTrigger><TooltipContent side="right" sideOffset={8}>{tip}</TooltipContent></Tooltip>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-[680px]">
        <DialogHeader><DialogTitle>系统版本</DialogTitle><DialogDescription>查看发布说明，更新或回退当前运行版本。</DialogDescription></DialogHeader>
        {!info && !error && <div className="space-y-3" aria-label="正在查询版本"><Skeleton className="h-28 w-full" /><Skeleton className="h-48 w-full" /></div>}
        {error && <Alert variant="destructive"><WarningCircle /><AlertTitle>{timedOut ? '暂未确认重启结果' : '版本查询暂不可用'}</AlertTitle><AlertDescription>{error}<Button variant="link" size="sm" disabled={busy || checking} onClick={() => { void (timedOut ? retry() : refresh()); }}>重新查询</Button></AlertDescription></Alert>}
        {info && <>
          <Card><CardHeader className="flex flex-row items-center justify-between"><CardTitle>当前版本</CardTitle><Badge variant="outline" className="font-mono">{info.current.version}</Badge></CardHeader><CardContent><dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-3"><div><dt className="mb-1 text-muted-foreground">构建时间</dt><dd className="tabular-nums">{date(info.current.buildDate)}</dd></div><div><dt className="mb-1 text-muted-foreground">提交</dt><dd className="font-mono">{info.current.commit?.slice(0, 7) ?? '未提供'}</dd></div><div className="col-span-2 sm:col-span-1"><dt className="mb-1 text-muted-foreground">进程启动时间</dt><dd className="tabular-nums">{date(info.current.startedAt)}</dd></div></dl></CardContent></Card>
          {info.task && (running ? <TaskProgress task={info.task} /> : <TaskResult task={info.task} />)}
          <Card><CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2"><div className="space-y-1"><CardTitle>{info.latest ? `最新版本 ${info.latest.version}` : info.latestError ? '暂未获取最新版本' : '暂无正式版本'}</CardTitle>{info.latest && <p className="text-xs text-muted-foreground">发布于 {date(info.latest.publishedAt)}</p>}</div><Button variant="outline" size="sm" className="aria-disabled:opacity-50" disabled={locked} aria-disabled={checking || undefined} aria-busy={checking} onClick={() => { void check(); }}><ArrowClockwise className={checking ? 'motion-safe:animate-spin' : ''} />{checking ? '检查中…' : '检查更新'}</Button></CardHeader>
            <CardContent className="space-y-3">
              {info.latest ? <>
                <a href={info.latest.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-4">在 GitHub 查看 Release<ArrowSquareOut /></a>
                <ScrollArea className="h-56 rounded-lg border bg-muted/35" tabIndex={0} aria-label="中文更新说明"><div className="release-notes p-4"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span className="text-muted-foreground">{alt ? `[图片：${alt}]` : '[图片]'}</span> }}>{info.latest.notesMd || '该版本未提供更新说明。'}</ReactMarkdown></div></ScrollArea>
              </> : <p className="text-sm text-muted-foreground">{info.latestError ? '请稍后重新检查，当前版本仍可正常使用。' : '仓库尚未发布正式 Release，有新版本时会在这里显示。'}</p>}
              {info.latestError && <Alert variant="destructive"><WarningCircle /><AlertTitle>检查更新失败</AlertTitle><AlertDescription>{info.latestError}</AlertDescription></Alert>}
              <p className="text-[11px] text-muted-foreground">上次检查：{date(info.checkedAt)}</p>
            </CardContent>
          </Card>
          {!info.canUpdate && info.reason && !running && <Alert><Info /><AlertDescription>{info.reason}</AlertDescription></Alert>}
          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            {info.previousVersion && <Button variant="outline" disabled={locked || rollbackUnavailable} onClick={() => setConfirm('rollback')}><ArrowCounterClockwise />回退到 {info.previousVersion}</Button>}
            <Button disabled={locked || !info.canUpdate || !info.latest} onClick={() => setConfirm('update')}>{busy ? '正在提交…' : running ? '任务进行中' : info.latest && info.updateAvailable ? `更新到 ${info.latest.version}` : '当前无可用更新'}</Button>
          </div>
        </>}
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirm !== null} onOpenChange={value => { if (!value) setConfirm(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirm === 'rollback' ? `确认回退到 ${info?.previousVersion}？` : `确认更新到 ${info?.latest?.version}？`}</AlertDialogTitle><AlertDialogDescription>操作会短暂中断服务约 10–30 秒，建议先备份数据库。新版本健康检查失败时，系统会自动回退到原版本。请勿在更新期间重复操作或关闭服务进程。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction disabled={locked} onClick={() => { const action = confirm; setConfirm(null); if (action) void start(action); }}>{confirm === 'rollback' ? '确认回退' : '确认更新'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>;
}
