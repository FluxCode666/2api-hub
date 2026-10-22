/*
 * 定时真伪检测（SPEC §4.4，按模型的可信分扩展）：
 * - 主测模型：每 authenticity.intervalHours（默认 24h）一次
 * - 其他已映射到目录（channel_models.model_id 非空）的声明模型：
 *   按 authenticity.modelScope（primary=不做 / featured=models.is_featured / all=全部，默认 all）
 *   每 authenticity.secondaryIntervalHours（默认 48h）一次；**从未检测过的模型立即到期**
 * - 同渠道的多个到期模型合并进一个 authenticity 任务的 payload.models；
 *   已有 queued/running 任务时把新到期模型**合并进现有任务 payload**（jsonb 去重并集）
 *   ——不丢弃到期信号、不与唯一索引 probe_tasks_active_uq 冲突
 * - 错峰：有报告的渠道加 (channel_id % 12) × 5min 偏移；每轮最多处理 3 个渠道，
 *   任务内模型串行检测且受全局/单站点并发约束，启动时不会打爆上游
 */
import { sql } from 'drizzle-orm';
import type { Database } from '@hub/db';

export type ModelScope = 'primary' | 'featured' | 'all';

export interface AuthenticityScheduleDeps {
  db: Database;
  /** 主测模型间隔（settings['authenticity.intervalHours']） */
  intervalHours: number;
  /** 非主测模型范围（settings['authenticity.modelScope']） */
  modelScope: ModelScope;
  /** 非主测模型间隔（settings['authenticity.secondaryIntervalHours']） */
  secondaryIntervalHours: number;
  /** 每轮最多处理的渠道数（默认 3） */
  maxPerSweep?: number;
}

interface DueModelRow extends Record<string, unknown> {
  channel_id: number;
  upstream_name: string;
}

/**
 * 非主测模型的 scope 谓词（代码内固定字面量，无外部输入）：
 * primary → 恒假（不做非主测检测）；featured → 目录精选；all → 全部。
 */
const SCOPE_PREDICATE: Record<ModelScope, ReturnType<typeof sql>> = {
  primary: sql`FALSE`,
  featured: sql`m.is_featured`,
  all: sql`TRUE`,
};

/**
 * 扫描到期模型并入队/合并。返回本轮新建任务数 + 合并进现有任务的模型数。
 *
 * 到期判断（每个 channel_models 行，渠道必须 approved + active + probe_enabled）：
 * - upstream_name = primary_model → due = 上次该模型报告 + intervalHours
 * - 其他已映射行（scope 命中）→ due = 上次该模型报告 + secondaryIntervalHours；
 *   从未检测（无报告）→ 立即到期
 */
export async function scheduleAuthenticitySweep(deps: AuthenticityScheduleDeps): Promise<{
  created: number;
  merged: number;
}> {
  const { db, intervalHours, modelScope, secondaryIntervalHours } = deps;
  const max = deps.maxPerSweep ?? 3;
  const scopePredicate = SCOPE_PREDICATE[modelScope] ?? SCOPE_PREDICATE.all;

  // 到期模型（按渠道分组；全部参数化）
  // 到期判断：主测 = 上次报告 + intervalHours + 错峰；非主测（scope 命中）= 上次报告
  // + secondaryIntervalHours + 错峰；从未检测（无报告）→ epoch 起算立即到期。
  // 错峰偏移 (channel_id % 12)×5min 加在各自到期时间上，避免启动时集中打爆上游。
  const rows = await db.execute<DueModelRow>(sql`
    WITH last_report AS (
      SELECT ar.channel_id, ar.model, MAX(ar.created_at) AS last_at
      FROM authenticity_reports ar
      JOIN channels c ON c.id = ar.channel_id
      JOIN sites s ON s.id = c.site_id
      WHERE s.status = 'approved' AND c.status = 'active' AND c.probe_enabled
      GROUP BY ar.channel_id, ar.model
    )
    SELECT cm.channel_id, cm.upstream_name
    FROM channel_models cm
    JOIN channels c ON c.id = cm.channel_id
    JOIN sites s ON s.id = c.site_id
    JOIN models m ON m.id = cm.model_id
    WHERE s.status = 'approved' AND c.status = 'active' AND c.probe_enabled
      AND cm.model_id IS NOT NULL
      AND (
        -- 主测模型：intervalHours + 错峰
        (cm.upstream_name = c.primary_model
          AND COALESCE((SELECT lr.last_at FROM last_report lr
            WHERE lr.channel_id = cm.channel_id AND lr.model = cm.upstream_name), to_timestamp(0))
            + make_interval(hours => ${intervalHours})
            + make_interval(mins => (cm.channel_id % 12) * 5) <= now())
        -- 非主测模型：scope 命中 + secondaryIntervalHours + 错峰（无报告 → epoch 起算即立即到期）
        OR (cm.upstream_name <> c.primary_model AND ${scopePredicate}
          AND COALESCE((SELECT lr.last_at FROM last_report lr
            WHERE lr.channel_id = cm.channel_id AND lr.model = cm.upstream_name), to_timestamp(0))
            + make_interval(hours => ${secondaryIntervalHours})
            + make_interval(mins => (cm.channel_id % 12) * 5) <= now())
      )
    ORDER BY cm.channel_id ASC
    LIMIT ${max * 6}
  `);

  // 按渠道分组
  const byChannel = new Map<number, string[]>();
  for (const r of rows) {
    const list = byChannel.get(r.channel_id) ?? [];
    list.push(r.upstream_name);
    byChannel.set(r.channel_id, list);
  }
  // 限制每轮处理的渠道数
  const channels = [...byChannel.entries()].slice(0, max);

  let created = 0;
  let merged = 0;
  for (const [channelId, models] of channels) {
    // 已有 queued/running authenticity 任务 → 合并进 payload（不冲突、不丢到期信号）
    const existing = await db.execute<{ id: number; payload: { models?: string[] } }>(sql`
      SELECT id, payload FROM probe_tasks
      WHERE channel_id = ${channelId} AND kind = 'authenticity' AND status IN ('queued', 'running')
      ORDER BY id ASC LIMIT 1
    `);
    const t = existing[0];
    if (t) {
      const current = Array.isArray(t.payload?.models) ? t.payload.models : [];
      const union = [...new Set([...current, ...models])];
      if (union.length !== current.length) {
        await db.execute(sql`
          UPDATE probe_tasks SET payload = ${JSON.stringify({ models: union })}::jsonb
          WHERE id = ${t.id}
        `);
        merged += union.length - current.length;
      }
      continue;
    }
    // 新建合并任务（ON CONFLICT DO NOTHING：竞态时另一实例已建，视为已入队）
    const inserted = await db.execute<{ id: number }>(sql`
      INSERT INTO probe_tasks (channel_id, kind, trigger, payload, status)
      VALUES (${channelId}, 'authenticity', 'schedule', ${JSON.stringify({ models })}::jsonb, 'queued')
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    created += inserted.length;
  }
  return { created, merged };
}
