'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthResponse, SystemVersionInfo, UpdateTask } from '@hub/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';

export const isUpdating = (task: UpdateTask | null | undefined) => !!task && !['succeeded', 'failed', 'rolled_back'].includes(task.status);
const POLL_MS = 2000;
const IDLE_MS = 30 * 60 * 1000;
const RESTART_LIMIT_MS = 3 * 60 * 1000;

// 由后台布局持有：关闭对话框或手机侧栏均不会中断任务跟踪。
export function useSystemVersion(mockEnabled: boolean) {
  const [info, setInfo] = useState<SystemVersionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [wake, setWake] = useState(0);
  const latest = useRef<SystemVersionInfo | null>(null);
  const restart = useRef<{ id: string; since: number } | null>(null);
  const observed = useRef<string | null>(null);
  const done = useRef<string | null>(null);
  const alive = useRef(true);
  const scenario = useRef<string | null>(null);
  const refreshFlight = useRef<Promise<void> | null>(null);
  const inFlight = useRef(false);

  const accept = useCallback((next: SystemVersionInfo) => {
    if (!alive.current) return;
    latest.current = next; setInfo(next); setError(null);
    if (isUpdating(next.task)) observed.current = next.task!.id;
    if (next.task?.status !== 'restarting') restart.current = null;
  }, []);
  const complete = useCallback((task: UpdateTask) => {
    if (isUpdating(task) || done.current === task.id || observed.current !== task.id || !alive.current) return;
    done.current = task.id;
    if (task.status === 'succeeded') {
      toast.success(`${task.kind === 'rollback' ? '已回退' : '已更新'}至 ${task.targetVersion}，正在刷新页面`);
      // 给读屏与成功通知留出短暂呈现时间，再加载新版本静态资源。
      window.setTimeout(() => { if (alive.current) window.location.reload(); }, 1400);
    } else if (task.status === 'rolled_back') toast.warning(`新版本启动失败，已自动回退到 ${task.fromVersion}`);
    else if (task.status === 'failed') toast.error(task.message ?? '更新失败，当前版本仍可使用。');
  }, []);
  const refresh = useCallback((force = false) => {
    if (refreshFlight.current) return refreshFlight.current;
    const work = async () => {
      const query = new URLSearchParams();
      if (force) query.set('refresh', 'true');
      if (scenario.current) query.set('mockScenario', scenario.current);
      try {
        const next = await api<SystemVersionInfo>(`/admin/system/version?${query}`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
        accept(next); if (next.task) complete(next.task);
      } catch (cause) {
        if (alive.current) setError(cause instanceof Error ? cause.message : '暂时无法查询系统版本。');
      }
    };
    const promise = work().finally(() => { refreshFlight.current = null; });
    refreshFlight.current = promise; return promise;
  }, [accept, complete]);

  const monitorId = isUpdating(info?.task) ? info!.task!.id : null;
  useEffect(() => {
    alive.current = true;
    scenario.current = mockEnabled ? new URL(window.location.href).searchParams.get('updatePreview') : null;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      const task = latest.current?.task;
      if (task?.status === 'restarting') {
        if (restart.current?.id !== task.id) restart.current = { id: task.id, since: Date.now() };
        if (Date.now() - restart.current.since >= RESTART_LIMIT_MS) {
          setTimedOut(true); setError('等待重启已超过 3 分钟。更新可能仍在执行，请检查服务状态后重试查询。');
          return;
        }
        try {
          const health = await api<HealthResponse>('/healthz', { signal: AbortSignal.timeout(4000), cache: 'no-store' });
          if (stopped) return;
          if (health.ok && health.version === task.targetVersion) {
            const finished: UpdateTask = { ...task, status: 'succeeded', finishedAt: new Date().toISOString() };
            accept({ ...latest.current!, current: { ...latest.current!.current, version: health.version }, task: finished });
            complete(finished);
          } else if (health.ok) {
            // 旧版本健康并不代表更新失败；查询持久任务状态来区分自动回退。
            await refresh();
          }
        } catch {
          // 切换进程时连接失败属于预期情况，继续等待，不弹错误通知。
        }
      } else await refresh();
      if (!stopped) timer = setTimeout(poll, isUpdating(latest.current?.task) ? POLL_MS : IDLE_MS);
    }
    void poll();
    return () => { stopped = true; alive.current = false; clearTimeout(timer); };
  }, [mockEnabled, accept, complete, refresh, monitorId, wake]);

  async function start(kind: 'update' | 'rollback') {
    if (inFlight.current || isUpdating(latest.current?.task)) return;
    inFlight.current = true; setBusy(true); setError(null); setTimedOut(false);
    try {
      const task = await api<UpdateTask>(`/admin/system/${kind}`, { method: 'POST', body: kind === 'update' ? JSON.stringify({ targetVersion: latest.current?.latest?.version }) : undefined, signal: AbortSignal.timeout(10000) });
      if (!alive.current) return;
      observed.current = task.id;
      if (latest.current) accept({ ...latest.current, task });
      setWake(value => value + 1);
    } catch (cause) {
      if (alive.current) {
        await refresh();
        if (alive.current && !isUpdating(latest.current?.task)) setError(cause instanceof Error ? cause.message : '无法提交更新任务。');
      }
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  function retry() { restart.current = null; setTimedOut(false); setWake(value => value + 1); return refresh(); }
  return { info, error, busy, timedOut, refresh, start, retry };
}
