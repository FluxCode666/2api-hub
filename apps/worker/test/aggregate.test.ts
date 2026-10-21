/*
 * 聚合 + 推荐分测试（hub_test 隔离库）：
 * - buildChannelStat 纯函数（fixture 驱动，验证与 computeRecommendScore 的一致性）
 * - runAggregation 真库集成：含「零样本渠道」场景（审查 #4——NOT NULL 列默认值 + 不中断）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, encryptSecret } from '@hub/db';
import { computeRecommendScore, DEFAULT_SCORING_WEIGHTS } from '@hub/shared';
import { buildChannelStat, runAggregation, type AggRow } from '../src/aggregate';

const WEIGHTS = DEFAULT_SCORING_WEIGHTS;
const { db, sql: pg } = createDb(process.env.DATABASE_URL);

let siteId = 0;
const channelIds: number[] = [];

beforeAll(async () => {
  // 自建测试资源（hub_test 库，TRUNCATE 由本文件级独占）
  const site = await db.execute<{ id: number }>(sql`
    INSERT INTO sites (owner_id, slug, name, homepage_url, status, recharge_ratio, created_at, updated_at)
    SELECT u.id, 'w-agg-site', 'w-agg-site', 'http://example.test/w', 'approved', 1, now(), now()
    FROM users u ORDER BY u.created_at ASC LIMIT 1
    RETURNING id
  `);
  siteId = site[0]!.id;
  const enc = encryptSecret('sk-w-agg');
  for (let i = 0; i < 3; i++) {
    const ch = await db.execute<{ id: number }>(sql`
      INSERT INTO channels (site_id, name, base_url, api_key_enc, api_key_mask, protocol, primary_model,
        group_ratio, status, probe_enabled, probe_interval_sec, next_probe_at, created_at, updated_at)
      VALUES (${siteId}, ${'w-agg-ch-' + i}, 'http://127.0.0.1:59999/x', ${enc}, 'sk-****agg',
        'openai_chat', 'gpt-6-sol', 1, 'active', true, 600, now(), now(), now())
      RETURNING id
    `);
    channelIds.push(ch[0]!.id);
  }
  // ch-0：正常样本；ch-1：一条失败记录（不足 3 条，不应触发降频）；ch-2：零样本
  for (let i = 0; i < 10; i++) {
    await db.execute(sql`
      INSERT INTO probe_runs (channel_id, model, protocol, kind, trigger, success,
        http_status, latency_ms, ttft_ms, created_at)
      VALUES (${channelIds[0]}, 'gpt-6-sol', 'openai_chat', 'availability', 'schedule', ${i !== 9},
        200, ${1200 + i * 10}, 500, now() - make_interval(mins => ${10 - i}))
    `);
  }
  await db.execute(sql`
    INSERT INTO probe_runs (channel_id, model, protocol, kind, trigger, success, http_status, created_at)
    VALUES (${channelIds[1]}, 'gpt-6-sol', 'openai_chat', 'availability', 'schedule', false, 503, now())
  `);
});

afterAll(async () => {
  if (siteId) await db.execute(sql`DELETE FROM sites WHERE id = ${siteId}`);
  await pg.end();
});

function fakeRow(over: Partial<AggRow> = {}): AggRow {
  return {
    channel_id: 1,
    uptime_1h: '1',
    uptime_24h: '0.99',
    uptime_7d: '0.98',
    samples_24h: 139,
    latency_p50: 1600,
    latency_p95: 2400,
    ttft_avg: 700,
    consecutive_failures: 0,
    last_success_at: '2026-10-21T17:20:25.672Z',
    last_failure_at: null,
    last_probe_at: '2026-10-21T17:20:25.672Z',
    trust_score: 90,
    trust_verdict: 'genuine',
    sparkline: [{ t: '2026-10-21T17:20:25.672Z', ok: true, ms: 1858 }],
    ...over,
  };
}

describe('buildChannelStat（纯函数）', () => {
  it('正常渠道：与 computeRecommendScore 结果一致', () => {
    const row = fakeRow();
    const stat = buildChannelStat(row, { weights: WEIGHTS, minSamplesForScore: 6 });
    const expected = computeRecommendScore({
      uptime24h: 0.99, latencyP50: 1600, trustScore: 90,
      consecutiveFailures: 0, samples24h: 139, weights: WEIGHTS,
    });
    expect(stat.recommendScore).toBe(expected);
    expect(stat.trustVerdict).toBe('genuine');
    expect(stat.uptime24h).toBeCloseTo(0.99);
  });

  it('样本不足：recommendScore 为 null；零样本 samples24h=0（审查 #4）', () => {
    const row = fakeRow({ samples_24h: 0, uptime_24h: null, uptime_1h: null, uptime_7d: null, latency_p50: null, sparkline: null });
    const stat = buildChannelStat(row, { weights: WEIGHTS, minSamplesForScore: 6 });
    expect(stat.recommendScore).toBeNull();
    expect(stat.samples24h).toBe(0);
    expect(stat.uptime24h).toBeNull();
    expect(stat.sparkline).toEqual([]);
  });

  it('连续失败拉低分数；dead 渠道得低分', () => {
    const dead = buildChannelStat(fakeRow({ uptime_24h: '0', consecutive_failures: 1008, samples_24h: 139, trust_score: null }), { weights: WEIGHTS, minSamplesForScore: 6 });
    expect(dead.recommendScore).not.toBeNull();
    expect(dead.recommendScore!).toBeLessThan(40);
    const flaky = buildChannelStat(fakeRow({ uptime_24h: '0.6', latency_p50: 2000, consecutive_failures: 2 }), { weights: WEIGHTS, minSamplesForScore: 6 });
    expect(flaky.recommendScore!).toBeGreaterThan(dead.recommendScore!);
  });

  it('低延迟比高延迟得分高', () => {
    const fast = buildChannelStat(fakeRow({ latency_p50: 300 }), { weights: WEIGHTS, minSamplesForScore: 6 });
    const slow = buildChannelStat(fakeRow({ latency_p50: 5000 }), { weights: WEIGHTS, minSamplesForScore: 6 });
    expect(fast.recommendScore!).toBeGreaterThan(slow.recommendScore!);
  });
});

describe('runAggregation（真库集成，含零样本渠道，审查 #4）', () => {
  it('零样本渠道不中断聚合：NOT NULL 列写 0、无数据列为 null', async () => {
    const result = await runAggregation(db, {
      weights: WEIGHTS, minSamplesForScore: 6,
    });
    expect(result.failedChannels).toBe(0); // 关键断言：零样本渠道不产生失败
    expect(result.durationMs).toBeLessThan(30_000);

    // 零样本渠道（ch-2）
    const zeroRows = await db.execute<{
      samples_24h: number; uptime_24h: string | null; recommend_score: number | null; sparkline: unknown;
    }>(sql`
      SELECT samples_24h, uptime_24h::text, recommend_score, sparkline
      FROM channel_stats WHERE channel_id = ${channelIds[2]}
    `);
    expect(zeroRows.length).toBe(1);
    expect(zeroRows[0]!.samples_24h).toBe(0);
    expect(zeroRows[0]!.uptime_24h).toBeNull();
    expect(zeroRows[0]!.recommend_score).toBeNull();

    // 有样本渠道（ch-0）与 computeRecommendScore 一致
    const rows = await db.execute<{
      channel_id: number; uptime_24h: string | null; samples_24h: number;
      latency_p50_24h: number | null; trust_score: number | null;
      consecutive_failures: number; recommend_score: number | null;
    }>(sql`
      SELECT channel_id, uptime_24h::text, samples_24h, latency_p50_24h, trust_score, consecutive_failures, recommend_score
      FROM channel_stats WHERE samples_24h >= 6 AND channel_id = ${channelIds[0]}
    `);
    for (const r of rows) {
      const expected = computeRecommendScore({
        uptime24h: r.uptime_24h === null ? null : Number(r.uptime_24h),
        latencyP50: r.latency_p50_24h,
        trustScore: r.trust_score,
        consecutiveFailures: r.consecutive_failures,
        samples24h: r.samples_24h,
        weights: WEIGHTS,
      });
      expect(r.recommend_score).toBe(expected);
    }
  });

  it('备用模型记录不计入渠道可用率（审查 #15：聚合只统计主测模型）', async () => {
    // 给 ch-0 追加 5 条备用模型的失败记录
    for (let i = 0; i < 5; i++) {
      await db.execute(sql`
        INSERT INTO probe_runs (channel_id, model, protocol, kind, trigger, success, http_status, created_at)
        VALUES (${channelIds[0]}, 'backup-model-x', 'openai_chat', 'availability', 'schedule', false, 503,
          now() - make_interval(mins => ${5 - i}))
      `);
    }
    const before = await db.execute<{ samples: number }>(sql`
      SELECT samples_24h AS samples FROM channel_stats WHERE channel_id = ${channelIds[0]}
    `);
    await runAggregation(db, { weights: WEIGHTS, minSamplesForScore: 6 });
    const after = await db.execute<{ samples: number; uptime: string | null }>(sql`
      SELECT samples_24h AS samples, uptime_24h::text AS uptime FROM channel_stats WHERE channel_id = ${channelIds[0]}
    `);
    // 样本数和可用率不应因备用模型失败记录而变化（仍 10 条主测记录、9 成功）
    expect(after[0]!.samples).toBe(before[0]!.samples);
    expect(Number(after[0]!.uptime)).toBeCloseTo(0.9, 2);
  });

  it('草稿站点渠道不参与聚合（审查 #4）', async () => {
    await db.execute(sql`UPDATE sites SET status = 'draft' WHERE id = ${siteId}`);
    await runAggregation(db, { weights: WEIGHTS, minSamplesForScore: 6 });
    const gone = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM channel_stats cs
      JOIN channels c ON c.id = cs.channel_id WHERE c.site_id = ${siteId}
    `);
    expect(gone[0]!.n).toBe(0); // 非 approved 站点统计行已清理
    await db.execute(sql`UPDATE sites SET status = 'approved' WHERE id = ${siteId}`);
  });
});
