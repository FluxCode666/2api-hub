-- 增量迁移：probe_tasks 任务 lease 字段（审查 P1 #3）
-- locked_by：当前持有该任务的 worker 实例 id
-- lease_token：每次领取生成新 uuid；副作用写入必须校验，防止旧执行者覆盖新执行者
-- heartbeat_at：执行中每 30s 续租；回收只处理心跳过期（超过恢复阈值）的任务
-- 全部为可空列，向后兼容；退出时只归还 locked_by = 本实例 的任务。
ALTER TABLE "probe_tasks" ADD COLUMN "locked_by" text;--> statement-breakpoint
ALTER TABLE "probe_tasks" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "probe_tasks" ADD COLUMN "heartbeat_at" timestamp with time zone;
