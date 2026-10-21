/*
 * 探测执行器：调 probeAvailability、写 probe_runs、失败升级（invalid）/恢复通知。
 * - 只更新 channels 的探测时间戳，不 bump updated_at（避免榜单时间抖动）
 * - 审查 #1（防御）：probe_runs.error_message / 通知正文写库前，用渠道解密后的真实 Key
 *   再做一次精确替换（probe 包已脱敏，这里兜底防截断边界/短 Key 漏网）
 * - 审查 #15：主测模型结果回写 channel_models（last_status/last_latency_ms/last_tested_at/last_error）
 *   备用模型（backupModel 模式）单独写 probe_runs，但不更新渠道时间戳、不参与失败升级
 *   和可用率聚合（聚合只统计 model=primary_model）
 */
import { sql } from 'drizzle-orm';
import { probeAvailability } from '@hub/probe';
import type { ChannelProtocol, ProbeResult, ProbeTrigger } from '@hub/shared';
import type { Database } from '@hub/db';
import { insertNotification } from './notify';

export interface ProbeJob {
  channelId: number;
  siteId: number;
  ownerId: string | null; // 站点 owner uuid（channel_invalid 通知对象）
  channelName: string;
  baseUrl: string;
  apiKey: string;
  protocol: ChannelProtocol;
  model: string;
  /** 备用模型（非空表示本次是备用模型探测，不更新渠道级状态） */
  backupModel?: string | null;
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

/**
 * 写库前的 Key 精确替换（审查 #1 防御）。
 * 对任意非空 Key 做精确子串替换（不限长度），probe 包自身的脱敏可能因截断边界漏掉前缀。
 */
export function scrubKey(text: string | null, key: string | null): string | null {
  if (!text || !key) return text;
  let out = text;
  // 精确替换；循环处理多次出现（split/join 是字面替换，无正则转义问题）
  if (out.includes(key)) out = out.split(key).join('***');
  return out;
}

/** 执行一次可用性探测并落库（probe 包内部不抛异常） */
export async function executeProbe(db: Database, job: ProbeJob): Promise<ProbeOutcome> {
  const result = await probeAvailability(
    { baseUrl: job.baseUrl, apiKey: job.apiKey, protocol: job.protocol, model: job.model },
    { timeoutMs: job.timeoutMs },
  );

  const errorMessage = scrubKey(result.errorMessage, job.apiKey);

  await db.execute(sql`
    INSERT INTO probe_runs (channel_id, channel_model_id, model, protocol, kind, trigger, success,
      http_status, error_code, error_message, latency_ms, ttft_ms, input_tokens, output_tokens, tokens_per_sec)
    VALUES (${job.channelId}, ${job.channelModelId}, ${job.model}, ${job.protocol}, 'availability', ${job.trigger},
      ${result.success}, ${result.httpStatus}, ${result.errorCode}, ${errorMessage},
      ${result.latencyMs}, ${result.ttftMs}, ${result.inputTokens}, ${result.outputTokens}, ${result.tokensPerSec})
  `);

  const isBackup = Boolean(job.backupModel);

  if (!isBackup) {
    // 主测模型：更新渠道级时间戳（updated_at 不动）
    await db.execute(sql`
      UPDATE channels SET last_probe_at = now(), last_test_ok = ${result.success}, last_test_at = now()
      WHERE id = ${job.channelId}
    `);
    // 回写 channel_models 主测模型行（审查 #15）
    await db.execute(sql`
      INSERT INTO channel_models (channel_id, upstream_name, last_status, last_latency_ms, last_tested_at, last_error)
      VALUES (${job.channelId}, ${job.model}, ${result.success ? 'pass' : 'fail'},
        ${result.success ? result.latencyMs : null}, now(), ${errorMessage})
      ON CONFLICT (channel_id, upstream_name) DO UPDATE SET
        last_status = EXCLUDED.last_status, last_latency_ms = EXCLUDED.last_latency_ms,
        last_tested_at = EXCLUDED.last_tested_at, last_error = EXCLUDED.last_error
    `);
  } else {
    // 备用模型：只回写该模型行，不动渠道级状态
    await db.execute(sql`
      INSERT INTO channel_models (channel_id, upstream_name, last_status, last_latency_ms, last_tested_at, last_error)
      VALUES (${job.channelId}, ${job.model}, ${result.success ? 'pass' : 'fail'},
        ${result.success ? result.latencyMs : null}, now(), ${errorMessage})
      ON CONFLICT (channel_id, upstream_name) DO UPDATE SET
        last_status = EXCLUDED.last_status, last_latency_ms = EXCLUDED.last_latency_ms,
        last_tested_at = EXCLUDED.last_tested_at, last_error = EXCLUDED.last_error
    `);
  }

  if (isBackup) {
    // 备用模型探测不参与失败升级 / 恢复通知 / 渠道时间戳
    return { channelId: job.channelId, success: result.success, result };
  }

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

/** 最近一次成功之后的连续失败次数（无成功记录则统计全部失败；只计主测模型） */
export async function countLeadingFailures(db: Database, channelId: number): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM probe_runs r
    JOIN channels c ON c.id = r.channel_id
    WHERE r.channel_id = ${channelId} AND r.kind = 'availability' AND NOT r.success
      AND r.model = c.primary_model
      AND r.created_at > COALESCE((
        SELECT MAX(r3.created_at) FROM probe_runs r3
        WHERE r3.channel_id = ${channelId} AND r3.kind = 'availability'
          AND r3.model = c.primary_model AND r3.success
      ), to_timestamp(0))
  `);
  return rows[0]?.n ?? 0;
}

/** 最近 20 条中、排除最新一条后的尾部连续失败数（恢复通知用；只计主测模型） */
async function leadingFailuresBeforeLatest(db: Database, channelId: number): Promise<number> {
  const rows = await db.execute<RecentRunRow>(sql`
    WITH recent AS (
      SELECT r.success, r.created_at FROM probe_runs r
      JOIN channels c ON c.id = r.channel_id
      WHERE r.channel_id = ${channelId} AND r.kind = 'availability' AND r.model = c.primary_model
      ORDER BY r.created_at DESC LIMIT 21
    )
    SELECT success FROM recent ORDER BY created_at DESC
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
