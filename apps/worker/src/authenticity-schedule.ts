/*
 * 定时真伪检测（SPEC §4.4）：每渠道主测模型每 authenticity.intervalHours 小时
 * 自动入队 authenticity 任务（trigger=schedule）。
 * - 每 10min sweep 一次
 * - 错峰：due = 上次报告时间 + interval + (channel_id % 12) × 5min
 * - 每轮最多入队 5 个，跳过已有 queued/running authenticity 任务的渠道
 */
import { sql } from 'drizzle-orm';
import type { Database } from '@hub/db';

export interface AuthenticityScheduleDeps {
  db: Database;
  intervalHours: number; // settings['authenticity.intervalHours']
  maxPerSweep?: number;  // 每轮最多入队数（默认 5）
}

/**
 * 扫描并入队到期的真伪检测任务。返回本轮入队数。
 * due 判断：COALESCE(上次主测报告时间, epoch) + interval + 错峰偏移 <= now
 */
export async function scheduleAuthenticitySweep(deps: AuthenticityScheduleDeps): Promise<number> {
  const { db, intervalHours } = deps;
  const max = deps.maxPerSweep ?? 5;

  const rows = await db.execute<{ channel_id: number }>(sql`
    SELECT c.id AS channel_id
    FROM channels c
    JOIN sites s ON s.id = c.site_id
    WHERE s.status = 'approved' AND c.status = 'active' AND c.probe_enabled
      -- 跳过已有 queued/running authenticity 任务的渠道
      AND NOT EXISTS (
        SELECT 1 FROM probe_tasks t
        WHERE t.channel_id = c.id AND t.kind = 'authenticity' AND t.status IN ('queued', 'running')
      )
      -- 到期判断：主测模型最近一次报告 + interval + (id % 12) * 5min <= now
      AND COALESCE((
        SELECT MAX(ar.created_at) FROM authenticity_reports ar
        WHERE ar.channel_id = c.id AND ar.model = c.primary_model
      ), to_timestamp(0)) + make_interval(hours => ${intervalHours})
        + make_interval(mins => (c.id % 12) * 5) <= now()
    ORDER BY c.id ASC
    LIMIT ${max}
  `);

  let enqueued = 0;
  for (const r of rows) {
    // NOT EXISTS 检查与 INSERT 之间存在竞态窗口（另一实例可能已入队），
    // 唯一索引 probe_tasks_active_uq 冲突时视为已入队，不中断 sweep（审查建议）
    const inserted = await db.execute<{ id: number }>(sql`
      INSERT INTO probe_tasks (channel_id, kind, trigger, payload, status)
      VALUES (${r.channel_id}, 'authenticity', 'schedule', '{}'::jsonb, 'queued')
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    enqueued += inserted.length;
  }
  return enqueued;
}
