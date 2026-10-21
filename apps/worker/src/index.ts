/*
 * Worker 主入口：
 * - 启动时立即全量聚合 + 每 60s 一次
 * - 定时可用性探测调度（每 5s tick）
 * - 任务队列执行器（availability/authenticity/discovery，并发 2）
 * - 定时真伪检测（每 10min sweep）
 * - 每日清理 30 天前 probe_runs（启动 25h 后首跑，之后每 24h）
 * - /healthz 与 /metrics
 * - 优雅退出（SIGINT/SIGTERM，最多等 30s）
 */
import { createDb } from '@hub/db';
import { sql as dsql } from 'drizzle-orm';
import { loadConfig, loadSettings, scoringWeights, newMetrics } from './config';
import { createLimiter } from './limiter';
import { runAggregation } from './aggregate';
import { createScheduler } from './scheduler';
import {
  claimNextTask, runTaskToCompletion, reclaimStaleTasks, failExhaustedTasks,
  type TaskDeps,
} from './tasks';
import { scheduleAuthenticitySweep } from './authenticity-schedule';
import { cleanupOldProbeRuns } from './cleanup';
import { startHealthServer } from './health';

const config = loadConfig();
const { db, sql: pg } = createDb();
const metrics = newMetrics();
const state = { running: true };
let inFlightTasks = 0;

function sleepOrExit(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      clearInterval(iv);
      resolve();
    }, ms);
    const iv = setInterval(() => {
      if (!state.running) {
        clearTimeout(t);
        clearInterval(iv);
        resolve();
      }
    }, 250);
  });
}

async function main(): Promise<void> {
  console.log('[worker] starting...');
  const settings = await loadSettings(db);
  const globalConc = Number(settings['probe.concurrency']) || 8;
  const perSiteConc = Number(settings['probe.perSiteConcurrency']) || 2;
  const probeTimeout = Number(settings['probe.timeoutMs']) || 30_000;
  const intervalHours = Number(settings['authenticity.intervalHours']) || 24;

  const limiter = createLimiter(globalConc, perSiteConc);
  const scheduler = createScheduler({ db, limiter, config, metrics });
  const taskDeps: TaskDeps = {
    db, maxAttempts: config.taskMaxAttempts, timeoutMs: probeTimeout, notifyEnabled: true,
  };

  startHealthServer({ db, config, metrics, limiter });

  // ---- 优雅退出 ----
  let exited = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (exited || !state.running) return;
    state.running = false;
    exited = true;
    console.log(`[worker] received ${signal}, shutting down (max ${config.gracefulShutdownMs / 1000}s)...`);
    const forceTimer = setTimeout(() => {
      console.error('[worker] graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, config.gracefulShutdownMs);
    // 等待进行中的任务完成（任务不接收中断信号）
    const deadline = Date.now() + config.gracefulShutdownMs - 2000;
    while (inFlightTasks > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    // 本进程领取且未完成的 running 任务交还队列
    await db
      .execute(
        dsql`UPDATE probe_tasks SET status = 'queued', started_at = NULL
            WHERE status = 'running' AND started_at > now() - make_interval(secs => ${Math.round(config.recoveryTimeoutMs / 1000)})`,
      )
      .catch(() => {});
    clearTimeout(forceTimer);
    await pg.end({ timeout: 3 });
    console.log('[worker] bye');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // ---- 聚合循环 ----
  void (async () => {
    const weights = scoringWeights(settings);
    while (state.running) {
      try {
        const r = await runAggregation(db, {
          weights, minSamplesForScore: config.minSamplesForScore, metrics,
        });
        console.log(`[aggregate] channels=${r.channelStats} sites=${r.siteStats} ${r.durationMs}ms`);
      } catch (err: unknown) {
        console.error('[aggregate] failed:', err instanceof Error ? err.message : err);
      }
      await sleepOrExit(config.aggregationIntervalSec * 1000);
    }
  })();

  // ---- 调度循环 ----
  void (async () => {
    while (state.running) {
      try {
        await scheduler.tick();
      } catch (err: unknown) {
        console.error('[scheduler] tick failed:', err instanceof Error ? err.message : err);
      }
      await sleepOrExit(config.schedulerIntervalSec * 1000);
    }
  })();

  // ---- 任务循环（并发 2） ----
  const TASK_CONCURRENCY = 2;
  void (async () => {
    while (state.running) {
      try {
        await reclaimStaleTasks(db, config.recoveryTimeoutMs, new Set());
        await failExhaustedTasks(taskDeps);
        let launched = 0;
        while (inFlightTasks < TASK_CONCURRENCY) {
          const task = await claimNextTask(db);
          if (!task) break;
          inFlightTasks += 1;
          launched += 1;
          void runTaskToCompletion(taskDeps, task)
            .catch((err: unknown) => console.error('[tasks] task crashed:', err))
            .finally(() => {
              inFlightTasks -= 1;
              metrics.tasksDone += 1;
            });
        }
        if (launched === 0) await sleepOrExit(2000);
      } catch (err: unknown) {
        console.error('[tasks] loop failed:', err instanceof Error ? err.message : err);
        await sleepOrExit(2000);
      }
    }
  })();

  // ---- 真伪检测定时循环（每 10min sweep） ----
  void (async () => {
    while (state.running) {
      try {
        const n = await scheduleAuthenticitySweep({ db, intervalHours });
        if (n > 0) console.log(`[authenticity] enqueued ${n} scheduled task(s)`);
      } catch (err: unknown) {
        console.error('[authenticity] sweep failed:', err instanceof Error ? err.message : err);
      }
      await sleepOrExit(10 * 60 * 1000);
    }
  })();

  // ---- 每日清理 ----
  void (async () => {
    await sleepOrExit(25 * 60 * 60 * 1000);
    while (state.running) {
      try {
        const n = await cleanupOldProbeRuns(db, config.retentionDays);
        console.log(`[cleanup] removed ${n} probe_runs older than ${config.retentionDays}d`);
      } catch (err: unknown) {
        console.error('[cleanup] failed:', err instanceof Error ? err.message : err);
      }
      await sleepOrExit(24 * 60 * 60 * 1000);
    }
  })();

  console.log('[worker] all loops started (aggregation/scheduler/tasks/authenticity/cleanup)');
}

main().catch((err: unknown) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
