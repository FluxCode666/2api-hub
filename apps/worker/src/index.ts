/*
 * Worker 主入口：
 * - 启动时立即全量聚合 + 每 60s 一次
 * - 定时可用性探测调度（每 5s tick，原子领取，全局/单站点 limiter）
 * - 任务队列执行器（availability/authenticity/discovery，lease + 30s 心跳）
 *   与定时探测共享同一全局/单站点 limiter（审查 #13）
 * - 定时真伪检测（每 10min sweep）
 * - 每日清理 30 天前 probe_runs（启动 25h 后首跑，之后每 24h）
 * - /healthz 与 /metrics
 * - settings 每 60s 刷新（probe.timeoutMs 等即时生效，审查 #13）
 * - 优雅退出（SIGINT/SIGTERM，最多等 30s；等待在途探测与任务，只归还本实例任务）
 */
import { randomUUID } from 'node:crypto';
import { createDb } from '@hub/db';
import { sql as dsql } from 'drizzle-orm';
import { loadConfig, loadSettings, scoringWeights, newMetrics } from './config';
import type { SettingsMap } from '@hub/shared';
import { createLimiter, type ConcurrencyLimiter } from './limiter';
import { runAggregation } from './aggregate';
import { createScheduler } from './scheduler';
import {
  claimNextTask, runTaskToCompletion, reclaimStaleTasks, releaseMyTasks,
  type TaskDeps,
} from './tasks';
import { scheduleAuthenticitySweep } from './authenticity-schedule';
import { cleanupOldProbeRuns } from './cleanup';
import { startHealthServer } from './health';

const config = loadConfig();
const { db, sql: pg } = createDb();
const metrics = newMetrics();
const WORKER_ID = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
const state = { running: true };

/** settings 热快照（60s 刷新，审查 #13） */
const settingsRef = { settings: null as SettingsMap | null };
let limiter: ConcurrencyLimiter = createLimiter(8, 2);
let probeTimeoutMs = 30_000;
let globalMax = 8;
let perSiteMax = 2;

async function refreshSettings(): Promise<void> {
  const settings = await loadSettings(db);
  settingsRef.settings = settings;
  const gm = Number(settings['probe.concurrency']) || 8;
  const pm = Number(settings['probe.perSiteConcurrency']) || 2;
  if (gm !== globalMax || pm !== perSiteMax) {
    // 并发上限变化：替换 limiter（在途句柄仍由旧 limiter 释放，新领取用新配置；
    // 收缩时旧句柄自然到期，无需强杀在途请求）
    limiter = createLimiter(gm, pm);
  }
  globalMax = gm;
  perSiteMax = pm;
  probeTimeoutMs = Number(settings['probe.timeoutMs']) || 30_000;
}

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
  console.log(`[worker] starting... (${WORKER_ID})`);
  await refreshSettings();
  const settings = settingsRef.settings!;
  let intervalHours = Number(settings['authenticity.intervalHours']) || 24;

  const scheduler = createScheduler({
    db, limiter: () => limiter, config, metrics, probeTimeoutMs: () => probeTimeoutMs,
    globalMax: () => globalMax,
  });
  const taskDeps = (): TaskDeps => ({
    db, workerId: WORKER_ID, maxAttempts: config.taskMaxAttempts,
    timeoutMs: probeTimeoutMs, notifyEnabled: true,
  });

  startHealthServer({ db, config, metrics, limiter });

  // ---- settings 60s 刷新（审查 #13） ----
  void (async () => {
    while (state.running) {
      await sleepOrExit(60_000);
      if (!state.running) break;
      try {
        await refreshSettings();
        const s = settingsRef.settings!;
        intervalHours = Number(s['authenticity.intervalHours']) || intervalHours;
      } catch (err: unknown) {
        console.error('[settings] refresh failed:', err instanceof Error ? err.message : err);
      }
    }
  })();

  // ---- 优雅退出（审查 #3/#14：等待在途探测与任务，只归还本实例任务） ----
  let exited = false;
  let inFlightTasks = 0;
  const shutdown = async (signal: string): Promise<void> => {
    if (exited || !state.running) return;
    state.running = false;
    exited = true;
    console.log(`[worker] received ${signal}, shutting down (max ${config.gracefulShutdownMs / 1000}s)...`);
    const forceTimer = setTimeout(() => {
      console.error('[worker] graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, config.gracefulShutdownMs);
    try {
      const deadline = Date.now() + config.gracefulShutdownMs - 2000;
      // 等待在途任务与定时探测（探测自身有超时上限）
      while (inFlightTasks > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      await scheduler.drain(Math.max(deadline - Date.now(), 0));
      // 归还本实例持有的任务（审查 #3：只动自己的）
      await releaseMyTasks(db, WORKER_ID);
    } catch { /* 尽力而为 */ }
    clearTimeout(forceTimer);
    await pg.end({ timeout: 3 });
    console.log('[worker] bye');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // ---- 聚合循环 ----
  void (async () => {
    while (state.running) {
      try {
        const s = settingsRef.settings ?? (await loadSettings(db));
        const r = await runAggregation(db, {
          weights: scoringWeights(s), minSamplesForScore: config.minSamplesForScore, metrics,
        });
        console.log(`[aggregate] channels=${r.channelStats} sites=${r.siteStats} failed=${r.failedChannels} ${r.durationMs}ms`);
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

  // ---- 任务循环（与定时探测共享同一 limiter，审查 #13） ----
  void (async () => {
    while (state.running) {
      try {
        await reclaimStaleTasks(db, config.recoveryTimeoutMs);
        let launched = 0;
        while (inFlightTasks < 2) { // 任务级并发上限 2（网络请求再由 limiter 约束）
          const task = await claimNextTask(db, WORKER_ID, config.taskMaxAttempts);
          if (!task) break;
          // 任务执行也占全局/单站点 limiter 槽位（审查 #13）
          const handle = limiter.acquire(task.siteId);
          if (!handle) {
            // 并发满：归还任务（带 lease 校验在 releaseMyTasks 之外做一次原子 requeue）
            await db.execute(dsql`
              UPDATE probe_tasks SET status = 'queued', started_at = NULL,
                locked_by = NULL, lease_token = NULL, heartbeat_at = NULL
              WHERE id = ${task.id} AND lease_token = ${task.leaseToken} AND status = 'running'
            `);
            break;
          }
          inFlightTasks += 1;
          launched += 1;
          void runTaskToCompletion(taskDeps(), task)
            .catch((err: unknown) => console.error('[tasks] task crashed:', err))
            .finally(() => {
              handle.release();
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
