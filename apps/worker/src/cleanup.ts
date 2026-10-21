/*
 * 每日清理：删除 N 天前的 probe_runs（保留可用性统计所需的最近数据）。
 */
import { sql } from 'drizzle-orm';
import type { Database } from '@hub/db';

/** 删除 retentionDays 天前的 probe_runs，返回删除行数 */
export async function cleanupOldProbeRuns(db: Database, retentionDays: number): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    WITH del AS (DELETE FROM probe_runs WHERE created_at < now() - make_interval(days => ${retentionDays}) RETURNING 1)
    SELECT COUNT(*)::int AS n FROM del
  `);
  return rows[0]?.n ?? 0;
}
