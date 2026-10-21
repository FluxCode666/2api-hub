/*
 * 统计聚合（SPEC §5.5）：从 probe_runs 计算 channel_stats / site_stats。
 * 全部用 SQL 聚合（percentile_cont 等），不把 probe_runs 全量读进内存。
 */
import { sql } from 'drizzle-orm';
import { computeRecommendScore } from '@hub/shared';
import type { SparkPoint, ScoringWeights, TrustVerdict } from '@hub/shared';
import type { Database } from '@hub/db';
import type { WorkerMetrics } from './config';

export interface AggregateOptions {
  weights: ScoringWeights;
  minSamplesForScore: number;
  metrics?: WorkerMetrics;
}

export interface AggregateResult {
  channelStats: number;
  siteStats: number;
  durationMs: number;
}

/** percentile_cont 需要的行类型（db.execute 要求 Record 索引签名） */
interface AggRow extends Record<string, unknown> {
  channel_id: number;
  uptime_1h: string | null;
  uptime_24h: string | null;
  uptime_7d: string | null;
  samples_24h: number;
  latency_p50: number | null;
  latency_p95: number | null;
  ttft_avg: number | null;
  consecutive_failures: number;
  last_success_at: string | Date | null;
  last_failure_at: string | Date | null;
  last_probe_at: string | Date | null;
  trust_score: number | null;
  trust_verdict: TrustVerdict | null;
  sparkline: { t: string; ok: boolean; ms: number | null }[] | null;
}

interface SiteAggRow extends Record<string, unknown> {
  site_id: number;
  channel_count: number;
  model_count: number;
  avg_uptime: string | null;
  best_recommend: number | null;
  min_actual_ratio: string | null;
  vendor_slugs: string[] | null;
  review_count: number;
  avg_rating: string | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const iso = (v: string | Date | null | undefined): string | null => {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
};

const toDate = (v: string | Date | null): Date | null => {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
};

/**
 * 单渠道聚合（导出供单元测试）：
 * 输入 SQL 聚合出的原始行，计算 recommend_score 并返回 upsert 值。
 */
export function buildChannelStat(
  r: AggRow,
  opts: { weights: ScoringWeights; minSamplesForScore: number },
) {
  const uptime24h = num(r.uptime_24h);
  const latencyP50 = num(r.latency_p50);
  const trustScore = num(r.trust_score);
  const recommendScore = computeRecommendScore({
    uptime24h,
    latencyP50: latencyP50 === null ? null : Math.round(latencyP50),
    trustScore: trustScore === null ? null : Math.round(trustScore),
    consecutiveFailures: r.consecutive_failures,
    samples24h: r.samples_24h,
    weights: opts.weights,
  });
  const sparkline: SparkPoint[] = Array.isArray(r.sparkline)
    ? r.sparkline.map((p) => ({ t: String(p.t), ok: Boolean(p.ok), ms: num(p.ms) }))
    : [];
  const round = (v: number | null, digits = 4): number | null =>
    v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits;
  return {
    channelId: r.channel_id,
    uptime1h: round(num(r.uptime_1h)),
    uptime24h: round(uptime24h),
    uptime7d: round(num(r.uptime_7d)),
    samples24h: r.samples_24h,
    latencyP50_24h: latencyP50 === null ? null : Math.round(latencyP50),
    latencyP95_24h: r.latency_p95 === null ? null : Math.round(r.latency_p95),
    ttftAvg24h: r.ttft_avg === null ? null : Math.round(r.ttft_avg),
    consecutiveFailures: r.consecutive_failures,
    lastSuccessAt: toDate(r.last_success_at),
    lastFailureAt: toDate(r.last_failure_at),
    lastProbeAt: toDate(r.last_probe_at),
    trustScore: trustScore === null ? null : Math.round(trustScore),
    trustVerdict: (r.trust_verdict ?? 'unknown') as TrustVerdict,
    recommendScore,
    sparkline,
    updatedAt: new Date(),
  };
}

const CHANNEL_AGG_SQL = sql`
  WITH latest AS (
    -- 主测模型最近一次真伪报告（channel_stats.trust_score 的来源）
    SELECT DISTINCT ON (ar.channel_id)
      ar.channel_id, ar.score, ar.verdict
    FROM authenticity_reports ar
    JOIN channels c2 ON c2.id = ar.channel_id
    WHERE ar.model = c2.primary_model
    ORDER BY ar.channel_id, ar.created_at DESC
  ),
  agg AS (
    SELECT
      r.channel_id,
      AVG(CASE WHEN r.created_at > now() - interval '1 hour' THEN CASE WHEN r.success THEN 1.0 ELSE 0 END END) AS uptime_1h,
      AVG(CASE WHEN r.created_at > now() - interval '24 hours' THEN CASE WHEN r.success THEN 1.0 ELSE 0 END END) AS uptime_24h,
      AVG(CASE WHEN r.created_at > now() - interval '7 days' THEN CASE WHEN r.success THEN 1.0 ELSE 0 END END) AS uptime_7d,
      COUNT(*) FILTER (WHERE r.created_at > now() - interval '24 hours')::int AS samples_24h,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY r.latency_ms) FILTER (WHERE r.success AND r.created_at > now() - interval '24 hours') AS latency_p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY r.latency_ms) FILTER (WHERE r.success AND r.created_at > now() - interval '24 hours') AS latency_p95,
      AVG(r.ttft_ms) FILTER (WHERE r.success AND r.created_at > now() - interval '24 hours') AS ttft_avg,
      MAX(r.created_at) FILTER (WHERE r.success) AS last_success_at,
      MAX(r.created_at) FILTER (WHERE NOT r.success) AS last_failure_at,
      MAX(r.created_at) AS last_probe_at,
      (
        SELECT COALESCE(json_agg(x ORDER BY x.t DESC), '[]'::json) FROM (
          SELECT r2.created_at AS t, r2.success AS ok, r2.latency_ms AS ms
          FROM probe_runs r2
          WHERE r2.channel_id = r.channel_id AND r2.kind = 'availability'
          ORDER BY r2.created_at DESC
          LIMIT 60
        ) x
      ) AS sparkline
    FROM probe_runs r
    WHERE r.kind = 'availability'
    GROUP BY r.channel_id
  ),
  cf AS (
    -- 连续失败次数：从最近一次成功（或全部）往前数连续失败
    SELECT r.channel_id,
      COUNT(*)::int AS consecutive_failures
    FROM probe_runs r
    WHERE r.kind = 'availability'
      AND NOT r.success
      AND r.created_at > COALESCE((
        SELECT MAX(r3.created_at) FROM probe_runs r3
        WHERE r3.channel_id = r.channel_id AND r3.kind = 'availability' AND r3.success
      ), to_timestamp(0))
    GROUP BY r.channel_id
  )
  SELECT
    c.id AS channel_id,
    agg.uptime_1h, agg.uptime_24h, agg.uptime_7d, agg.samples_24h,
    agg.latency_p50, agg.latency_p95, agg.ttft_avg,
    COALESCE(cf.consecutive_failures, 0) AS consecutive_failures,
    agg.last_success_at, agg.last_failure_at, agg.last_probe_at,
    latest.score AS trust_score, latest.verdict AS trust_verdict,
    agg.sparkline
  FROM channels c
  LEFT JOIN agg ON agg.channel_id = c.id
  LEFT JOIN cf ON cf.channel_id = c.id
  LEFT JOIN latest ON latest.channel_id = c.id
`;

const SITE_AGG_SQL = sql`
  SELECT
    s.id AS site_id,
    COUNT(c.id) FILTER (WHERE c.status = 'active')::int AS channel_count,
    COALESCE((
      SELECT COUNT(DISTINCT cm.model_id) FROM channel_models cm
      JOIN channels c2 ON c2.id = cm.channel_id
      WHERE c2.site_id = s.id AND c2.status = 'active' AND cm.model_id IS NOT NULL
    ), 0) AS model_count,
    AVG(cs.uptime_24h) AS avg_uptime,
    MAX(cs.recommend_score) AS best_recommend,
    MIN(CASE WHEN s.recharge_ratio > 0 THEN c.group_ratio / s.recharge_ratio ELSE c.group_ratio END) AS min_actual_ratio,
    COALESCE(ARRAY(
      SELECT DISTINCT v.slug FROM channels c3
      LEFT JOIN vendors v ON v.id = c3.vendor_id
      WHERE c3.site_id = s.id AND c3.status = 'active' AND v.slug IS NOT NULL
    ), ARRAY[]::text[]) AS vendor_slugs,
    (SELECT COUNT(*) FROM reviews rv WHERE rv.site_id = s.id AND rv.status = 'visible')::int AS review_count,
    (SELECT AVG(rv.rating) FROM reviews rv WHERE rv.site_id = s.id AND rv.status = 'visible') AS avg_rating
  FROM sites s
  LEFT JOIN channels c ON c.site_id = s.id AND c.status = 'active'
  LEFT JOIN channel_stats cs ON cs.channel_id = c.id
  WHERE s.status = 'approved'
  GROUP BY s.id
`;

/** 全量聚合：channel_stats + site_stats（60s 周期与 aggregate:once 共用） */
export async function runAggregation(db: Database, opts: AggregateOptions): Promise<AggregateResult> {
  const startedAt = Date.now();

  // ---- channel_stats ----
  const rows = await db.execute<AggRow>(CHANNEL_AGG_SQL);
  let channelCount = 0;
  for (const r of rows) {
    const stat = buildChannelStat(r, opts);
    await db.execute(sql`
      INSERT INTO channel_stats (channel_id, uptime_1h, uptime_24h, uptime_7d, samples_24h,
        latency_p50_24h, latency_p95_24h, ttft_avg_24h, consecutive_failures,
        last_success_at, last_failure_at, last_probe_at, trust_score, trust_verdict,
        recommend_score, sparkline, updated_at)
      VALUES (${stat.channelId}, ${stat.uptime1h}, ${stat.uptime24h}, ${stat.uptime7d}, ${stat.samples24h},
        ${stat.latencyP50_24h}, ${stat.latencyP95_24h}, ${stat.ttftAvg24h}, ${stat.consecutiveFailures},
        ${stat.lastSuccessAt}, ${stat.lastFailureAt}, ${stat.lastProbeAt}, ${stat.trustScore}, ${stat.trustVerdict},
        ${stat.recommendScore}, ${JSON.stringify(stat.sparkline)}::jsonb, now())
      ON CONFLICT (channel_id) DO UPDATE SET
        uptime_1h = EXCLUDED.uptime_1h, uptime_24h = EXCLUDED.uptime_24h, uptime_7d = EXCLUDED.uptime_7d,
        samples_24h = EXCLUDED.samples_24h, latency_p50_24h = EXCLUDED.latency_p50_24h,
        latency_p95_24h = EXCLUDED.latency_p95_24h, ttft_avg_24h = EXCLUDED.ttft_avg_24h,
        consecutive_failures = EXCLUDED.consecutive_failures, last_success_at = EXCLUDED.last_success_at,
        last_failure_at = EXCLUDED.last_failure_at, last_probe_at = EXCLUDED.last_probe_at,
        trust_score = EXCLUDED.trust_score, trust_verdict = EXCLUDED.trust_verdict,
        recommend_score = EXCLUDED.recommend_score, sparkline = EXCLUDED.sparkline,
        updated_at = EXCLUDED.updated_at
    `);
    channelCount += 1;
  }

  // ---- site_stats（依赖上面写好的 channel_stats） ----
  const siteRows = await db.execute<SiteAggRow>(SITE_AGG_SQL);
  let siteCount = 0;
  for (const r of siteRows) {
    const avgUptime = num(r.avg_uptime);
    const bestRecommend = num(r.best_recommend);
    const minRatio = num(r.min_actual_ratio);
    const avgRating = num(r.avg_rating);
    const round = (v: number | null, digits = 4): number | null =>
      v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits;
    await db.execute(sql`
      INSERT INTO site_stats (site_id, channel_count, model_count, avg_uptime_24h,
        best_recommend_score, min_actual_ratio, vendor_slugs, review_count, avg_rating, updated_at)
      VALUES (${r.site_id}, ${r.channel_count}, ${r.model_count}, ${round(avgUptime)},
        ${bestRecommend === null ? null : Math.round(bestRecommend * 10) / 10}, ${round(minRatio)},
        ${r.vendor_slugs ?? []}, ${r.review_count}, ${round(avgRating, 2)}, now())
      ON CONFLICT (site_id) DO UPDATE SET
        channel_count = EXCLUDED.channel_count, model_count = EXCLUDED.model_count,
        avg_uptime_24h = EXCLUDED.avg_uptime_24h, best_recommend_score = EXCLUDED.best_recommend_score,
        min_actual_ratio = EXCLUDED.min_actual_ratio, vendor_slugs = EXCLUDED.vendor_slugs,
        review_count = EXCLUDED.review_count, avg_rating = EXCLUDED.avg_rating,
        updated_at = EXCLUDED.updated_at
    `);
    siteCount += 1;
  }

  const durationMs = Date.now() - startedAt;
  if (opts.metrics) {
    opts.metrics.lastAggregateMs = durationMs;
    opts.metrics.lastAggregateAt = Date.now();
    opts.metrics.aggregatesRun += 1;
  }
  return { channelStats: channelCount, siteStats: siteCount, durationMs };
}

export { iso };
