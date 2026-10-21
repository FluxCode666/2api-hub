/*
 * 定时可用性探测调度（SPEC §4.2）：
 * - 每 5s 扫描到期渠道（approved 站点 + active 渠道 + probe_enabled + next_probe_at <= now）
 * - 事务内 FOR UPDATE SKIP LOCKED 领取，领取时立即推进 next_probe_at（±10% 抖动；连续失败 ≥3 → 300s）
 * - 并发受全局 probe.concurrency / 单站点 probe.perSiteConcurrency 限制；
 *   limiter 满时进入持久 pending 队列，后续 tick 补位（领取时已推进 next_probe_at，不会被重复领取）
 */
import { sql } from 'drizzle-orm';
import type { Database } from '@hub/db';
import type { ConcurrencyLimiter } from './limiter';
import type { ProbeJob } from './probes';
import { executeProbe } from './probes';
import type { WorkerConfig, WorkerMetrics } from './config';

export interface SchedulerDeps {
  db: Database;
  limiter: ConcurrencyLimiter;
  config: WorkerConfig;
  metrics: WorkerMetrics;
  /** 通知回调（默认只记指标；测试可注入断言） */
  onProbeDone?: (outcome: { channelId: number; success: boolean }) => void;
}

interface DueRow extends Record<string, unknown> {
  channel_id: number;
  site_id: number;
  owner_id: number | null;
  channel_name: string;
  base_url: string;
  api_key: string;
  protocol: 'openai' | 'anthropic';
  model: string;
  probe_enabled: boolean;
  interval_sec: number;
  recent_all_fail: boolean; // 最近 3 次全失败（实时降频判断）
}

const DUE_SQL = sql`
  SELECT c.id AS channel_id, c.site_id, s.owner_id, c.name AS channel_name,
    c.base_url, c.api_key, c.protocol, c.primary_model AS model,
    c.probe_enabled, COALESCE(c.interval_sec, 600) AS interval_sec,
    COALESCE((
      SELECT bool_and(NOT r.success) FROM (
        SELECT success FROM probe_runs
        WHERE channel_id = c.id AND kind = 'availability'
        ORDER BY created_at DESC LIMIT 3
      ) r
    ), false) AS recent_all_fail
  FROM channels c
  JOIN sites s ON s.id = c.site_id
  WHERE s.status = 'approved' AND c.status = 'active' AND c.probe_enabled
    AND c.next_probe_at <= now()
  ORDER BY c.next_probe_at ASC
  LIMIT 64
`;

/**
 * 创建调度器实例（持有持久 pending 队列）。
 * tick() 可安全地每 5s 调用一次。
 */
export function createScheduler(deps: SchedulerDeps) {
  const { db, limiter, config, metrics } = deps;
  const pending: ProbeJob[] = [];

  async function tick(): Promise<void> {
    // 1) 先消化 pending（上轮因并发满而排队的探测）
    drainPending();
    // 2) 扫描到期渠道
    const rows = await db.execute<DueRow>(DUE_SQL);
    if (rows.length === 0) return;
    // 3) 批量领取：事务内 SKIP LOCKED + 推进 next_probe_at
    const delays: Record<number, number> = {};
    for (const r of rows) delays[r.channel_id] = jitteredDelay(r, config.flakyProbeIntervalSec);
    const claimedIds = await claimChannels(db, rows.map((r) => r.channel_id), delays);
    const claimedSet = new Set(claimedIds);
    // 4) 派发：能占位就立即探测，否则入 pending（容量 200，满则丢弃，等下轮）
    for (const r of rows) {
      if (!claimedSet.has(r.channel_id)) continue;
      const job = toJob(r);
      const handle = limiter.acquire(r.site_id);
      if (handle) startProbe(job, handle);
      else if (pending.length < 200) pending.push(job);
    }
  }

  function drainPending(): void {
    while (pending.length > 0) {
      const job = pending[0];
      if (!job) break;
      const handle = limiter.acquire(job.siteId);
      if (!handle) break;
      pending.shift();
      startProbe(job, handle);
    }
  }

  function startProbe(job: ProbeJob, handle: { release(): void }): void {
    metrics.probesStarted += 1;
    void executeProbe(db, job)
      .then((outcome) => {
        deps.onProbeDone?.({ channelId: outcome.channelId, success: outcome.success });
        // 探测完成后立即尝试补位
        drainPending();
      })
      .catch((err: unknown) => {
        console.error('[scheduler] probe error', job.channelId, err);
      })
      .finally(() => {
        handle.release();
        metrics.probesFinished += 1;
      });
  }

  return { tick, pendingSize: () => pending.length };
}

/** 领取渠道：事务内 FOR UPDATE SKIP LOCKED + 立即推进 next_probe_at */
export async function claimChannels(
  db: Database,
  channelIds: number[],
  delays: Record<number, number>,
): Promise<number[]> {
  if (channelIds.length === 0) return [];
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: number; delay_sec: number }>(sql`
      SELECT c.id FROM channels c
      WHERE c.id IN (${sql.join(channelIds.map((id) => sql`${id}`), sql`, `)})
      FOR UPDATE OF c SKIP LOCKED
    `);
    if (rows.length === 0) return [] as number[];
    const values = rows.map(
      (r) => sql`(${r.id}::int, make_interval(secs => ${delays[r.id] ?? 600}))`,
    );
    await tx.execute(sql`
      UPDATE channels c SET next_probe_at = now() + v.delay
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, delay)
      WHERE c.id = v.id
    `);
    return rows.map((r) => r.id);
  });
}

function toJob(r: DueRow): ProbeJob {
  return {
    channelId: r.channel_id,
    siteId: r.site_id,
    ownerId: r.owner_id,
    channelName: r.channel_name,
    baseUrl: r.base_url,
    apiKey: r.api_key,
    // SAFETY: channels.protocol 列类型就是 enum('openai','anthropic')，与 ChannelProtocol 成员一致
    protocol: r.protocol as ProbeJob['protocol'],
    model: r.model,
    timeoutMs: 30_000,
    trigger: 'schedule',
    channelModelId: null,
  };
}

/** 基础间隔 ±10% 抖动；最近 3 次全失败改为降频间隔（±10%） */
export function jitteredDelay(r: { interval_sec: number; recent_all_fail: boolean }, flakySec: number): number {
  const base = r.recent_all_fail ? flakySec : r.interval_sec;
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.round(base * jitter);
}
