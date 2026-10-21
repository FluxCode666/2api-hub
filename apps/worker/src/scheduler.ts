/*
 * 定时可用性探测调度（SPEC §4.2）：
 * - 每 5s tick；到期筛选（approved 站点 + active 渠道 + probe_enabled + next_probe_at <= now）
 *   与行锁、推进 next_probe_at 合并在一条原子 SQL 中（审查 #2：锁定阶段保留完整谓词，
 *   多实例不会用旧快照重复领取）
 * - 只领取当前有能力立即执行的数量（全局剩余容量，审查 #14）；同站点并发满时放弃本轮执行，
 *   渠道保持已推进的 next_probe_at，下轮到期自然重试——不再有内存 pending 队列
 * - 间隔 ±10% 抖动；恰好 3 条最近样本且全部失败（审查 #16）→ 降频 300s
 * - 主测模型探测回写 channel_models（审查 #15）；备用模型单独探测、单独写 probe_runs
 *   （不计入渠道可用率——聚合只统计 model=primary_model）
 * - 探测超时用 settings 的 probe.timeoutMs（审查 #13，由 index.ts 每 60s 刷新传入）
 */
import { sql } from 'drizzle-orm';
import { decryptSecret } from '@hub/db';
import type { Database } from '@hub/db';
import type { ChannelProtocol } from '@hub/shared';
import type { ConcurrencyLimiter } from './limiter';
import type { ProbeJob } from './probes';
import { executeProbe } from './probes';
import type { WorkerConfig, WorkerMetrics } from './config';

export interface SchedulerDeps {
  db: Database;
  /** 全局/单站并发限制器（getter：settings 刷新后重建，审查 #13） */
  limiter: () => ConcurrencyLimiter;
  config: WorkerConfig;
  metrics: WorkerMetrics;
  /** 探测超时（getter，settings 的 probe.timeoutMs，每 60s 刷新，审查 #13） */
  probeTimeoutMs: () => number;
  /** 全局并发上限（getter，settings 的 probe.concurrency，用于计算可领取容量） */
  globalMax: () => number;
  /** 通知回调（测试注入断言用） */
  onProbeDone?: (outcome: { channelId: number; success: boolean }) => void;
}

interface DueRow extends Record<string, unknown> {
  channel_id: number;
  site_id: number;
  owner_id: string | null;
  channel_name: string;
  base_url: string;
  api_key_enc: string;
  protocol: ChannelProtocol;
  model: string;
  backup_model: string | null;
  interval_sec: number;
}

/**
 * 原子领取到期渠道（审查 #2）：到期筛选 + 状态检查 + FOR UPDATE SKIP LOCKED + 推进
 * next_probe_at 全部在一条 SQL 中完成。锁定行上保留完整谓词，
 * 旧快照中的已领取/已下线渠道不会二次领取。
 * limit = 本轮可立即执行的数量（调用方按全局剩余容量计算）。
 */
export async function claimDueChannels(
  db: Database,
  limit: number,
  flakySec: number,
): Promise<DueRow[]> {
  if (limit <= 0) return [];
  return db.execute<DueRow>(sql`
    UPDATE channels c SET next_probe_at = now() + v.delay
    FROM (
      SELECT cc.id, s.owner_id,
        make_interval(secs => CASE
          WHEN COALESCE((
            SELECT (bool_and(NOT r.success) AND COUNT(*) = 3)::boolean FROM (
              SELECT success FROM probe_runs
              WHERE channel_id = cc.id AND kind = 'availability' AND model = cc.primary_model
              ORDER BY created_at DESC LIMIT 3
            ) r
          ), false)
          THEN ${flakySec} * (0.9 + random() * 0.2)
          ELSE COALESCE(cc.probe_interval_sec, 600) * (0.9 + random() * 0.2)
        END) AS delay
      FROM channels cc
      JOIN sites s ON s.id = cc.site_id
      WHERE s.status = 'approved' AND cc.status = 'active' AND cc.probe_enabled
        AND cc.next_probe_at <= now()
      ORDER BY cc.next_probe_at ASC
      LIMIT ${limit}
      FOR UPDATE OF cc SKIP LOCKED
    ) v
    WHERE c.id = v.id
    RETURNING c.id AS channel_id, c.site_id, v.owner_id::text AS owner_id,
      c.name AS channel_name, c.base_url, c.api_key_enc, c.protocol,
      c.primary_model AS model, c.backup_model AS backup_model,
      c.probe_interval_sec AS interval_sec
  `);
}

/**
 * 创建调度器实例。
 * tick() 可安全地每 5s 调用一次；多实例安全（领取原子）。
 */
export function createScheduler(deps: SchedulerDeps) {
  const { db, limiter, config, metrics, probeTimeoutMs, globalMax } = deps;
  /** 退出等待句柄（审查 #14）：所有在途定时探测的完成 promise */
  const inFlight = new Set<Promise<void>>();

  async function tick(): Promise<void> {
    // 只领取当前能立即执行的数量（审查 #14：全局剩余容量；单站点容量派发时判断）
    const l = limiter();
    const capacity = Math.max(globalMax() - l.inFlight, 0);
    if (capacity <= 0) return;
    const rows = await claimDueChannels(db, capacity, config.flakyProbeIntervalSec);
    for (const r of rows) {
      const handle = l.acquire(r.site_id);
      if (handle) {
        startProbe(toJob(r, probeTimeoutMs()), handle);
      }
      // 同站点并发满：本轮放弃执行，该渠道 next_probe_at 已推进——
      // 这是容量信号非错误；下轮到期自然重试。无内存 pending（审查 #14）。
    }
  }

  function startProbe(job: ProbeJob, handle: { release(): void }): void {
    metrics.probesStarted += 1;
    const p = (async () => {
      try {
        // 主测模型探测（含 channel_models 回写 + 失败升级/恢复通知）
        const outcome = await executeProbe(db, job);
        deps.onProbeDone?.({ channelId: outcome.channelId, success: outcome.success });
        // 备用模型单独探测（审查 #15）：独立 probe_runs 记录，不更新渠道级时间戳，
        // 不参与可用率聚合（聚合只统计 model=primary_model）
        if (job.backupModel) {
          await executeProbe(db, {
            ...job,
            model: job.backupModel,
            backupModel: null, // 防递归：备用探测不再嵌套探测备用
          });
        }
      } catch (err: unknown) {
        console.error('[scheduler] probe error', job.channelId, err);
      } finally {
        handle.release();
        metrics.probesFinished += 1;
      }
    })();
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  }

  /** 优雅退出：等待全部在途探测完成（审查 #14） */
  async function drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((r) => setTimeout(r, 200)),
      ]);
    }
    if (inFlight.size > 0) {
      console.warn(`[scheduler] drain timeout, ${inFlight.size} probe(s) still in flight`);
    }
  }

  return { tick, drain, inFlightSize: () => inFlight.size };
}

function toJob(r: DueRow, timeoutMs: number): ProbeJob {
  return {
    channelId: r.channel_id,
    siteId: r.site_id,
    ownerId: r.owner_id,
    channelName: r.channel_name,
    baseUrl: r.base_url,
    // api_key_enc 是 AES-256-GCM 密文，探测前解密
    apiKey: decryptSecret(r.api_key_enc),
    // SAFETY: channels.protocol 列是 channel_protocol 枚举，与 shared 的 ChannelProtocol 成员一致
    protocol: r.protocol,
    model: r.model,
    backupModel: r.backup_model ?? null,
    timeoutMs,
    trigger: 'schedule',
    channelModelId: null,
  };
}

/** 基础间隔 ±10% 抖动（纯函数，测试用）；最近恰好 3 条全失败 → 降频间隔 */
export function jitteredDelay(
  r: { interval_sec: number; recent_all_fail: boolean },
  flakySec: number,
): number {
  const base = r.recent_all_fail ? flakySec : r.interval_sec;
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.round(base * jitter);
}
