-- 增量迁移：probe_tasks 活动任务部分唯一索引（同一 channel+kind 同时最多一个 queued/running 任务）
-- 防止并发/多入口重复入队。已有重复活动时需先清理（当前库经原子入队修复后不会产生）。
CREATE UNIQUE INDEX IF NOT EXISTS "probe_tasks_active_uq"
  ON "probe_tasks" ("channel_id", "kind")
  WHERE status IN ('queued', 'running');
