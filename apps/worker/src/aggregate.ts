/*
 * 统计聚合（SPEC §5.5）：从 probe_runs 计算 channel_stats / site_stats。
 * 全部用 SQL 聚合（percentile_cont 等），不把 probe_runs 全量读进内存。
 * 注意：db.execute 的 raw 参数中 postgres.js 不序列化 Date 对象，
 * 因此所有时间参数一律传 ISO 字符串并显式 ::timestamptz。
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
  /** 单渠道聚合失败数（不中断整轮，审查 #4） */
  failedChannels: number;
}

/** 模型级推荐分 SELECT 行 */
interface ModelScoreRow extends Record<string, unknown> {
  cm_id: number;
  uptime_24h: string | null;
  samples_24h: number | null;
  latency_p50_24h: number | null;
  consecutive_failures: number | null;
  trust_score: number | null;
}

/** db.execute 的行类型（要求 Record 索引签名；时间列为 ISO 字符串） */
export interface AggRow extends Record<string, unknown> {
  channel_id: number;
  uptime_1h: string | null;
  uptime_24h: string | null;
  uptime_7d: string | null;
  samples_24h: number;
  latency_p50: number | null;
  latency_p95: number | null;
  ttft_avg: number | null;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_probe_at: string | null;
  trust_score: number | null;
  trust_verdict: TrustVerdict | null;
  sparkline: { t: string; ok: boolean; ms: number | null }[] | null;
}

export interface SiteAggRow extends Record<string, unknown> {
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

const round = (v: number | null, digits = 4): number | null =>
  v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits;

/** SQL 返回的时间列统一转 ISO 字符串（或 null） */
const isoOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * 单渠道聚合（导出供单元测试）：输入 SQL 聚合出的原始行，
 * 用 computeRecommendScore 计算推荐分，返回 upsert 所需字段。
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
    latencyP50,
    trustScore,
    consecutiveFailures: r.consecutive_failures,
    samples24h: r.samples_24h,
    weights: opts.weights,
  });
  const sparkline: SparkPoint[] = Array.isArray(r.sparkline)
    ? r.sparkline.map((p) => ({ t: isoOrNull(p.t) ?? '', ok: Boolean(p.ok), ms: num(p.ms) }))
    : [];
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
    lastSuccessAt: isoOrNull(r.last_success_at),
    lastFailureAt: isoOrNull(r.last_failure_at),
    lastProbeAt: isoOrNull(r.last_probe_at),
    trustScore: trustScore === null ? null : Math.round(trustScore),
    trustVerdict: (r.trust_verdict ?? 'unknown') as TrustVerdict,
    recommendScore,
    sparkline,
  };
}

const CHANNEL_AGG_SQL = sql`
  WITH latest AS (
    -- 主测模型最近一次真伪报告（channel_stats.trust_score 的来源；只看已上线站点）
    SELECT DISTINCT ON (ar.channel_id)
      ar.channel_id, ar.score, ar.verdict
    FROM authenticity_reports ar
    JOIN channels c2 ON c2.id = ar.channel_id
    JOIN sites s2 ON s2.id = c2.site_id
    WHERE s2.status = 'approved' AND ar.model = c2.primary_model
    ORDER BY ar.channel_id, ar.created_at DESC
  ),
  agg AS (
    -- 只统计主测模型的 availability 记录（备用模型探测不计入渠道可用率，审查 #15）
    SELECT
      r.channel_id,
      AVG(CASE WHEN r.created_at > now() - interval '1 hour' THEN CASE WHEN r.success THEN 1.0 ELSE 0 END END)::float8 AS uptime_1h,
      AVG(CASE WHEN r.created_at > now() - interval '24 hours' THEN CASE WHEN r.success THEN 1.0 ELSE 0 END END)::float8 AS uptime_24h,
      AVG(CASE WHEN r.created_at > now() - interval '7 days' THEN CASE WHEN r.success THEN 1.0 ELSE 0 END END)::float8 AS uptime_7d,
      COUNT(*) FILTER (WHERE r.created_at > now() - interval '24 hours')::int AS samples_24h,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY r.latency_ms) FILTER (WHERE r.success AND r.created_at > now() - interval '24 hours'))::int AS latency_p50,
      (percentile_cont(0.95) WITHIN GROUP (ORDER BY r.latency_ms) FILTER (WHERE r.success AND r.created_at > now() - interval '24 hours'))::int AS latency_p95,
      (AVG(r.ttft_ms) FILTER (WHERE r.success AND r.created_at > now() - interval '24 hours'))::int AS ttft_avg,
      MAX(r.created_at) FILTER (WHERE r.success) AS last_success_at,
      MAX(r.created_at) FILTER (WHERE NOT r.success) AS last_failure_at,
      MAX(r.created_at) AS last_probe_at,
      (
        SELECT COALESCE(json_agg(x ORDER BY x.t DESC), '[]'::json) FROM (
          SELECT to_char(r2.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
                 r2.success AS ok, r2.latency_ms AS ms
          FROM probe_runs r2
          WHERE r2.channel_id = r.channel_id AND r2.kind = 'availability'
            AND r2.model = c3.primary_model
          ORDER BY r2.created_at DESC
          LIMIT 60
        ) x
      ) AS sparkline
    FROM probe_runs r
    JOIN channels c3 ON c3.id = r.channel_id
    WHERE r.kind = 'availability' AND r.model = c3.primary_model
    GROUP BY r.channel_id, c3.primary_model
  ),
  cf AS (
    -- 连续失败次数（只计主测模型）：最近一次成功之后的全部失败（无成功则全部失败）
    SELECT r.channel_id,
      COUNT(*)::int AS consecutive_failures
    FROM probe_runs r
    JOIN channels c4 ON c4.id = r.channel_id
    WHERE r.kind = 'availability' AND r.model = c4.primary_model
      AND NOT r.success
      AND r.created_at > COALESCE((
        SELECT MAX(r3.created_at) FROM probe_runs r3
        WHERE r3.channel_id = r.channel_id AND r3.kind = 'availability'
          AND r3.model = c4.primary_model AND r3.success
      ), to_timestamp(0))
    GROUP BY r.channel_id
  )
  SELECT
    c.id AS channel_id,
    agg.uptime_1h, agg.uptime_24h, agg.uptime_7d,
    COALESCE(agg.samples_24h, 0) AS samples_24h,
    agg.latency_p50, agg.latency_p95, agg.ttft_avg,
    COALESCE(cf.consecutive_failures, 0) AS consecutive_failures,
    agg.last_success_at, agg.last_failure_at, agg.last_probe_at,
    latest.score AS trust_score, latest.verdict AS trust_verdict,
    agg.sparkline
  FROM channels c
  JOIN sites s ON s.id = c.site_id
  LEFT JOIN agg ON agg.channel_id = c.id
  LEFT JOIN cf ON cf.channel_id = c.id
  LEFT JOIN latest ON latest.channel_id = c.id
  WHERE s.status = 'approved'  -- 只聚合已上线站点（审查 #4：草稿/审核中站点跳过）
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

  // 先清理非 approved 站点渠道的统计行（站点下线后不再统计，审查 #4）
  await db.execute(sql`
    DELETE FROM channel_stats cs
    USING channels c JOIN sites s ON s.id = c.site_id
    WHERE cs.channel_id = c.id AND s.status <> 'approved'
  `);

  // ---- channel_stats：SQL 聚合 + JS 算推荐分后逐行 upsert ----
  const rows = await db.execute<AggRow>(CHANNEL_AGG_SQL);
  let channelCount = 0;
  let failedChannels = 0;
  for (const r of rows) {
    try {
      const stat = buildChannelStat(r, opts);
    await db.execute(sql`
      INSERT INTO channel_stats (channel_id, uptime_1h, uptime_24h, uptime_7d, samples_24h,
        latency_p50_24h, latency_p95_24h, ttft_avg_24h, consecutive_failures,
        last_success_at, last_failure_at, last_probe_at, trust_score, trust_verdict,
        recommend_score, sparkline, updated_at)
      VALUES (${stat.channelId}, ${stat.uptime1h}, ${stat.uptime24h}, ${stat.uptime7d}, ${stat.samples24h},
        ${stat.latencyP50_24h}, ${stat.latencyP95_24h}, ${stat.ttftAvg24h}, ${stat.consecutiveFailures},
        ${stat.lastSuccessAt}::timestamptz, ${stat.lastFailureAt}::timestamptz, ${stat.lastProbeAt}::timestamptz,
        ${stat.trustScore}, ${stat.trustVerdict},
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
    } catch (err: unknown) {
      // 单个渠道聚合失败不中断整轮（审查 #4）
      failedChannels += 1;
      console.error(`[aggregate] channel ${r.channel_id} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // ---- site_stats（依赖上面写好的 channel_stats） ----
  const siteRows = await db.execute<SiteAggRow>(SITE_AGG_SQL);
  let siteCount = 0;
  for (const r of siteRows) {
    const avgUptime = num(r.avg_uptime);
    const bestRecommend = num(r.best_recommend);
    const minRatio = num(r.min_actual_ratio);
    const avgRating = num(r.avg_rating);
    await db.execute(sql`
      INSERT INTO site_stats (site_id, channel_count, model_count, avg_uptime_24h,
        best_recommend_score, min_actual_ratio, vendor_slugs, review_count, avg_rating, updated_at)
      VALUES (${r.site_id}, ${r.channel_count}, ${r.model_count}, ${round(avgUptime)},
        ${bestRecommend === null ? null : Math.round(bestRecommend * 10) / 10}, ${round(minRatio)},
        ${sql.raw(
          `ARRAY[${(r.vendor_slugs ?? []).map((slug) => `'${slug.replace(/'/g, "''")}'`).join(',')}]::text[]`,
        )}, ${r.review_count}, ${round(avgRating, 2)}, now())
      ON CONFLICT (site_id) DO UPDATE SET
        channel_count = EXCLUDED.channel_count, model_count = EXCLUDED.model_count,
        avg_uptime_24h = EXCLUDED.avg_uptime_24h, best_recommend_score = EXCLUDED.best_recommend_score,
        min_actual_ratio = EXCLUDED.min_actual_ratio, vendor_slugs = EXCLUDED.vendor_slugs,
        review_count = EXCLUDED.review_count, avg_rating = EXCLUDED.avg_rating,
        updated_at = EXCLUDED.updated_at
    `);
    siteCount += 1;
  }

  // ---- 自愈同步：channel_models trust 字段 ← 最新 authenticity_report ----
  // 数据一致性保证（不依赖每个写入方都写对）：按 (channel_id, model) 取最新报告
  // （created_at DESC, id DESC），同步 trust_score/trust_verdict/trust_checked_at；
  // 只更新值不同的行，避免无谓写入。必须在「模型级推荐分」之前，
  // 保证推荐分用同步后的可信分；主测模型同步后 channel_stats.trust_score
  // 也自然一致（它原本就取主测模型最新报告）。
  try {
    await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (channel_id, model)
          channel_id, model, score, verdict, created_at
        FROM authenticity_reports
        ORDER BY channel_id, model, created_at DESC, id DESC
      )
      UPDATE channel_models cm
      SET trust_score = l.score, trust_verdict = l.verdict, trust_checked_at = l.created_at
      FROM latest l
      WHERE cm.channel_id = l.channel_id
        AND cm.upstream_name = l.model
        AND (cm.trust_score IS DISTINCT FROM l.score
             OR cm.trust_verdict <> l.verdict
             OR cm.trust_checked_at IS DISTINCT FROM l.created_at)
    `);
  } catch (err: unknown) {
    console.error('[aggregate] trust self-heal failed:', err instanceof Error ? err.message : err);
  }

  // ---- 模型级推荐分（按模型的可信分）：channel_models.recommend_score ----
  // uptime/延迟/连败/样本数沿用渠道级数据；trustScore 用该模型自己的 channel_models.trust_score。
  // SELECT 全部行 → JS computeRecommendScore → 一条批量 UPDATE（不逐行往返）。
  try {
    const modelRows = await db.execute<ModelScoreRow>(sql`
      SELECT cm.id AS cm_id, cs.uptime_24h, cs.samples_24h, cs.latency_p50_24h,
             cs.consecutive_failures, cm.trust_score
      FROM channel_models cm
      JOIN channels c ON c.id = cm.channel_id
      JOIN sites s ON s.id = c.site_id
      LEFT JOIN channel_stats cs ON cs.channel_id = c.id
      WHERE s.status = 'approved' AND c.status = 'active' AND cm.model_id IS NOT NULL
    `);
    const scored: { cmId: number; score: number | null }[] = [];
    for (const r of modelRows) {
      const score = computeRecommendScore({
        uptime24h: num(r.uptime_24h),
        latencyP50: r.latency_p50_24h,
        trustScore: r.trust_score,
        consecutiveFailures: r.consecutive_failures ?? 0,
        samples24h: r.samples_24h ?? 0,
        weights: opts.weights,
      });
      scored.push({ cmId: r.cm_id, score });
    }
    if (scored.length > 0) {
      // 批量 UPDATE ... FROM (VALUES)：一条语句写完全部行
      const values = scored.map(
        (v) => sql`(${v.cmId}::int, ${v.score}::float8)`,
      );
      // 分批（每批 500 行，避免单语句过长）
      for (let i = 0; i < values.length; i += 500) {
        const batch = values.slice(i, i + 500);
        await db.execute(sql`
          UPDATE channel_models cm SET recommend_score = v.score
          FROM (VALUES ${sql.join(batch, sql`, `)}) AS v(cm_id, score)
          WHERE cm.id = v.cm_id
        `);
      }
    }
  } catch (err: unknown) {
    // 模型级推荐分失败不中断聚合主流程
    console.error('[aggregate] model recommend_score failed:', err instanceof Error ? err.message : err);
  }

  const durationMs = Date.now() - startedAt;
  if (opts.metrics) {
    opts.metrics.lastAggregateMs = durationMs;
    opts.metrics.lastAggregateAt = Date.now();
    opts.metrics.aggregatesRun += 1;
  }
  return { channelStats: channelCount, siteStats: siteCount, durationMs, failedChannels };
}
