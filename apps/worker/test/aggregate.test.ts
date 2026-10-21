/*
 * 聚合 + 推荐分单元测试：
 * - buildChannelStat 纯函数（fixture 驱动，验证与 computeRecommendScore 的一致性）
 * - runAggregation 真库集成（非破坏性：只读 probe_runs，upsert channel_stats 本身就是交付物）
 */
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb } from '@hub/db';
import { computeRecommendScore, DEFAULT_SCORING_WEIGHTS } from '@hub/shared';
import { buildChannelStat, runAggregation, type AggRow } from '../src/aggregate';

const WEIGHTS = DEFAULT_SCORING_WEIGHTS;

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
    expect(stat.recommendScore).toBeGreaterThan(90);
    expect(stat.trustVerdict).toBe('genuine');
    expect(stat.sparkline).toHaveLength(1);
    expect(stat.uptime24h).toBeCloseTo(0.99);
  });

  it('样本不足：recommendScore 为 null', () => {
    const row = fakeRow({ samples_24h: 3 });
    const stat = buildChannelStat(row, { weights: WEIGHTS, minSamplesForScore: 6 });
    expect(stat.recommendScore).toBeNull();
  });

  it('无数据渠道：所有统计为 null，verdict=unknown', () => {
    const row = fakeRow({
      uptime_1h: null, uptime_24h: null, uptime_7d: null, samples_24h: 0,
      latency_p50: null, latency_p95: null, ttft_avg: null,
      last_success_at: null, last_probe_at: null, trust_score: null,
      trust_verdict: null, sparkline: null,
    });
    const stat = buildChannelStat(row, { weights: WEIGHTS, minSamplesForScore: 6 });
    expect(stat.uptime24h).toBeNull();
    expect(stat.recommendScore).toBeNull();
    expect(stat.trustVerdict).toBe('unknown');
    expect(stat.sparkline).toEqual([]);
  });

  it('连续失败拉低分数；dead 渠道得低分', () => {
    const dead = buildChannelStat(fakeRow({ uptime_24h: '0', consecutive_failures: 1008, samples_24h: 139, trust_score: null }), { weights: WEIGHTS, minSamplesForScore: 6 });
    expect(dead.recommendScore).not.toBeNull();
    // uptime=0 + trust 无报告（默认 60）+ 连败 1008 → 低分
    expect(dead.recommendScore!).toBeLessThan(40);
    const flaky = buildChannelStat(fakeRow({ uptime_24h: '0.6', latency_p50: 2000, consecutive_failures: 2 }), { weights: WEIGHTS, minSamplesForScore: 6 });
    expect(flaky.recommendScore!).toBeGreaterThan(50);
    expect(flaky.recommendScore!).toBeGreaterThan(dead.recommendScore!);
  });

  it('低延迟比高延迟得分高', () => {
    const fast = buildChannelStat(fakeRow({ latency_p50: 300 }), { weights: WEIGHTS, minSamplesForScore: 6 });
    const slow = buildChannelStat(fakeRow({ latency_p50: 5000 }), { weights: WEIGHTS, minSamplesForScore: 6 });
    expect(fast.recommendScore!).toBeGreaterThan(slow.recommendScore!);
  });
});

describe('runAggregation（真库集成，非破坏性）', () => {
  it('全量聚合写入所有渠道并产出合理值', async () => {
    const { db, sql: pg } = createDb();
    try {
      const result = await runAggregation(db, {
        weights: WEIGHTS, minSamplesForScore: 6,
      });
      expect(result.channelStats).toBeGreaterThanOrEqual(30); // 34 种子 + 测试渠道
      expect(result.siteStats).toBeGreaterThanOrEqual(10);
      expect(result.durationMs).toBeLessThan(30_000);

      // spot-check：某条聚合行与 computeRecommendScore 一致
      const rows = await db.execute<{
        channel_id: number; uptime_24h: string | null; samples_24h: number;
        latency_p50_24h: number | null; trust_score: number | null;
        consecutive_failures: number; recommend_score: number | null;
      }>(sql`
        SELECT channel_id, uptime_24h, samples_24h, latency_p50_24h, trust_score, consecutive_failures, recommend_score
        FROM channel_stats WHERE samples_24h >= 6 LIMIT 3
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
    } finally {
      await pg.end();
    }
  });
});
