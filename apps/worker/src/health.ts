/*
 * 健康检查与指标：/healthz 和 /metrics（JSON）。
 * 监听地址从 WORKER_HOST 读取（默认 127.0.0.1），端口 WORKER_HEALTH_PORT（默认 8713）。
 */
import http from 'node:http';
import type { Database } from '@hub/db';
import type { WorkerConfig, WorkerMetrics } from './config';
import { sql } from 'drizzle-orm';

export interface HealthDeps {
  db: Database;
  config: WorkerConfig;
  metrics: WorkerMetrics;
  limiter: { inFlight: number };
}

/** 队列积压 + 24h 探测量（每次 /metrics 实时查询） */
async function snapshot(db: Database, config: WorkerConfig, metrics: WorkerMetrics) {
  const backlog = await db.execute<{ queued: number; running: number }>(sql`
    SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
           COUNT(*) FILTER (WHERE status = 'running')::int AS running
    FROM probe_tasks
  `);
  const probe24h = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM probe_runs WHERE created_at > now() - interval '24 hours'
  `);
  metrics.lastQueueBacklog = backlog[0] ?? { queued: 0, running: 0 };
  return {
    queueBacklog: backlog[0] ?? { queued: 0, running: 0 },
    probes24h: probe24h[0]?.n ?? 0,
  };
}

export function startHealthServer(deps: HealthDeps): http.Server {
  const { db, config, metrics } = deps;
  const host = process.env.WORKER_HOST ?? '127.0.0.1';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${config.healthPort}`);
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000) }));
      return;
    }
    if (url.pathname === '/metrics') {
      try {
        const snap = await snapshot(db, config, metrics);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          aggregatesRun: metrics.aggregatesRun,
          lastAggregateMs: metrics.lastAggregateMs,
          lastAggregateAt: metrics.lastAggregateAt ? new Date(metrics.lastAggregateAt).toISOString() : null,
          probesStarted: metrics.probesStarted,
          probesFinished: metrics.probesFinished,
          inFlight: deps.limiter.inFlight,
          tasksDone: metrics.tasksDone,
          tasksFailed: metrics.tasksFailed,
          ...snap,
        }));
      } catch (err: unknown) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'metrics failed' }));
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(config.healthPort, host, () => {
    console.log(`[worker] health server on http://${host}:${config.healthPort}/healthz`);
  });
  return server;
}
