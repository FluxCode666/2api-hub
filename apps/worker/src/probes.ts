/*
 * 探测执行器：调 probeAvailability、写 probe_runs、失败升级（invalid）/恢复通知。
 * 只更新 channels 的探测时间戳，不 bump updated_at（避免榜单时间抖动）。
 */
import { sql } from 'drizzle-orm';
import { probeAvailability } from '@hub/probe';
import type { ChannelProtocol, ProbeResult, ProbeTrigger } from '@hub/shared';
import type { Database } from '@hub/db';
import { insertNotification } from './notify';

export interface ProbeJob {
  channelId: number;
  siteId: number;
  ownerId: number | null; // 站点 owner（channel_invalid 通知对象）
  channelName: string;
  baseUrl: string;
  apiKey: string;
  protocol: ChannelProtocol;
  model: string;
  timeoutMs: number;
  /** probe_runs.trigger */
  trigger: ProbeTrigger;
  channelModelId: number | null;
}

export interface ProbeOutcome {
  channelId: number;
  success: boolean;
  result: ProbeResult;
}

/** 执行一次可用性探测并落库（probe 包内部不抛异常） */
export async function executeProbe(db: Database, job: ProbeJob): Promise<ProbeOutcome> {
  const result = await probeAvailability(
    { baseUrl: job.baseUrl, apiKey: job.apiKey, protocol: job.protocol, model: job.model },
    { timeoutMs: job.timeoutMs },
  );

  await db.execute(sql`
    INSERT INTO probe_runs (channel_id, channel_model_id, model, protocol, kind, trigger, success,
      http_status, error_code, error_message, latency_ms, ttft_ms, input_tokens, output_tokens, tokens_per_sec)
    VALUES (${job.channelId}, ${job.channelModelId}, ${job.model}, ${job.protocol}, 'availability', ${job.trigger},
      ${result.success}, ${result.httpStatus}, ${result.errorCode}, ${result.errorMessage},
      ${result.latencyMs}, ${result.ttftMs}, ${result.inputTokens}, ${result.outputTokens}, ${result.tokensPerSec})
  `);

  // 只更新探测时间戳（updated_at 不动）
  await db.execute(sql`
    UPDATE channels SET last_probe_at = now(), last_test_ok = ${result.success}, last_test_at = now()
    WHERE id = ${job.channelId}
  `);

  // 失败升级：连续失败 ≥20 → invalid + 通知；成功恢复：此前连续失败 ≥3 → recovered
  const cf = await countLeadingFailures(db, job.channelId);
  if (!result.success && cf >= 20) {
    const invalidated = await db.execute<{ id: number }>(sql`
      UPDATE channels SET status = 'invalid', updated_at = now()
      WHERE id = ${job.channelId} AND status = 'active' RETURNING id
    `);
    if (invalidated.length > 0 && job.ownerId) {
      await insertNotification(db, job.ownerId, 'channel_invalid',
        `渠道「${job.channelName}」已下线`,
        `连续 ${cf} 次可用性探测失败，渠道已自动标记为失效（invalid）。如需恢复请检查后重新上线。`);
    }
  } else if (result.success && cf === 0) {
    // 本次成功——检查探测前的连续失败数是否 ≥3（读最近 20 条判断）
    const prevCf = await leadingFailuresBeforeLatest(db, job.channelId);
    if (prevCf >= 3 && job.ownerId) {
      await insertNotification(db, job.ownerId, 'channel_recovered',
        `渠道「${job.channelName}」已恢复`,
        `此前连续 ${prevCf} 次探测失败，本次探测已恢复成功。`);
    }
  }

  return { channelId: job.channelId, success: result.success, result };
}

/** 最近一次成功之后的连续失败次数（无成功记录则统计全部失败） */
export async function countLeadingFailures(db: Database, channelId: number): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM probe_runs
    WHERE channel_id = ${channelId} AND kind = 'availability' AND NOT success
      AND created_at > COALESCE((
        SELECT MAX(created_at) FROM probe_runs
        WHERE channel_id = ${channelId} AND kind = 'availability' AND success
      ), to_timestamp(0))
  `);
  return rows[0]?.n ?? 0;
}

/** 最近 20 条中、排除最新一条后的尾部连续失败数（恢复通知用） */
async function leadingFailuresBeforeLatest(db: Database, channelId: number): Promise<number> {
  const rows = await db.execute<RecentRunRow>(sql`
    SELECT success FROM (
      SELECT success FROM probe_runs
      WHERE channel_id = ${channelId} AND kind = 'availability'
      ORDER BY created_at DESC LIMIT 21
    ) t ORDER BY created_at DESC
  `);
  // rows[0] 是本次成功；从第二条开始数连续失败
  let cf = 0;
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i]?.success) cf += 1;
    else break;
  }
  return cf;
}

interface RecentRunRow extends Record<string, unknown> {
  success: boolean;
}
