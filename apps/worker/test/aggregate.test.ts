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
  // 自建最小目录（幂等）：worker 测试不依赖其他测试套件的种子残留
  await db.execute(sql`
    INSERT INTO vendors (slug, name, color, sort_order)
    VALUES ('w-agg-vendor', 'W聚合测试', '#888888', 998)
    ON CONFLICT (slug) DO NOTHING
  `);
  for (const slug of ['gpt-6-sol', 'kimi-k3']) {
    await db.execute(sql`
      INSERT INTO models (slug, display_name, vendor_id, aliases, default_protocol)
      SELECT ${slug}, ${slug}, v.id, ARRAY[${slug}]::text[], 'openai_chat'
      FROM vendors v WHERE v.slug = 'w-agg-vendor'
      ON CONFLICT (slug) DO NOTHING
    `);
  }
  // 自建测试资源（hub_test 库）
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
  // ch-1：一条失败记录（不足 3 条，不应触发降频）；ch-2：零样本
  await db.execute(sql`
    INSERT INTO probe_runs (channel_id, model, protocol, kind, trigger, success, http_status, created_at)
    VALUES (${channelIds[1]}, 'gpt-6-sol', 'openai_chat', 'availability', 'schedule', false, 503, now())
  `);
  // ch-0 的 channel_models：两个已映射模型行，带不同的 trust_score（模型级推荐分用例）
  await db.execute(sql`
    INSERT INTO channel_models (channel_id, upstream_name, model_id, trust_score)
    SELECT ${channelIds[0]}, 'gpt-6-sol', m.id, 95 FROM models m WHERE m.slug = 'gpt-6-sol'
  `);
  await db.execute(sql`
    INSERT INTO channel_models (channel_id, upstream_name, model_id, trust_score)
    SELECT ${channelIds[0]}, 'kimi-k3', m.id, 30 FROM models m WHERE m.slug = 'kimi-k3'
  `);
  // 未映射行（model_id NULL）：不参与模型级推荐分
  await db.execute(sql`
    INSERT INTO channel_models (channel_id, upstream_name) VALUES (${channelIds[0]}, 'unknown-model-zz')
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

  it('模型级推荐分：按各模型自身 trust_score 计算，假模型封顶 40，未映射行不写', async () => {
    await runAggregation(db, { weights: WEIGHTS, minSamplesForScore: 6 });
    const rows = await db.execute<{
      upstream_name: string; trust_score: number | null; recommend_score: number | null;
      uptime_24h: string | null; samples_24h: number | null; latency_p50_24h: number | null; consecutive_failures: number | null;
    }>(sql`
      SELECT cm.upstream_name, cm.trust_score, cm.recommend_score,
             cs.uptime_24h::text, cs.samples_24h, cs.latency_p50_24h, cs.consecutive_failures
      FROM channel_models cm
      LEFT JOIN channel_stats cs ON cs.channel_id = cm.channel_id
      WHERE cm.channel_id = ${channelIds[0]}
    `);
    const byName = new Map(rows.map((r) => [r.upstream_name, r]));
    // gpt-6-sol（trust 95）：正常分，与 computeRecommendScore 一致
    const good = byName.get('gpt-6-sol')!;
    const expectedGood = computeRecommendScore({
      uptime24h: Number(good.uptime_24h), latencyP50: good.latency_p50_24h,
      trustScore: good.trust_score, consecutiveFailures: good.consecutive_failures ?? 0,
      samples24h: good.samples_24h ?? 0, weights: WEIGHTS,
    });
    expect(good.recommend_score).toBe(expectedGood);
    // uptime=0.9（uptime^8≈0.43 非线性）+ trust 95 + 低延迟 → ~71
    expect(good.recommend_score!).toBeGreaterThan(60);
    expect(good.recommend_score!).toBeLessThan(90);
    // kimi-k3（trust 30 < 50 → 判假）：封顶 40
    const fake = byName.get('kimi-k3')!;
    const expectedFake = computeRecommendScore({
      uptime24h: Number(fake.uptime_24h), latencyP50: fake.latency_p50_24h,
      trustScore: fake.trust_score, consecutiveFailures: fake.consecutive_failures ?? 0,
      samples24h: fake.samples_24h ?? 0, weights: WEIGHTS,
    });
    expect(fake.recommend_score).toBe(expectedFake);
    expect(fake.recommend_score!).toBeLessThanOrEqual(40); // FAKE_SCORE_CAP
    // 未映射行（model_id NULL）：不参与
    expect(byName.get('unknown-model-zz')!.recommend_score).toBeNull();
  });

  it('自愈同步：channel_models trust ← 最新报告；不一致时同步且推荐分按新可信分计算', async () => {
    // 人为制造不一致（模拟种子/写入方 bug）：gpt-6-sol 行写旧值 95/genuine，
    // 再插两份报告（旧 100/genuine、新 63/suspect，id 更大更新）
    await db.execute(sql`
      INSERT INTO authenticity_reports (channel_id, model, protocol, score, verdict, checks, duration_ms, trigger, created_at)
      VALUES (${channelIds[0]}, 'gpt-6-sol', 'openai_chat', 100, 'genuine', '[]'::jsonb, 100, 'schedule',
          now() - interval '2 hours'),
         (${channelIds[0]}, 'gpt-6-sol', 'openai_chat', 63, 'suspect', '[]'::jsonb, 100, 'schedule',
          now() - interval '1 hour')
    `);
    await db.execute(sql`
      UPDATE channel_models SET trust_score = 95, trust_verdict = 'genuine',
        trust_checked_at = now() - interval '3 hours'
      WHERE channel_id = ${channelIds[0]} AND upstream_name = 'gpt-6-sol'
    `);

    await runAggregation(db, { weights: WEIGHTS, minSamplesForScore: 6 });

    // 断言 1：channel_models 已同步为最新报告的 63/suspect
    const cm = await db.execute<{ trust_score: number | null; trust_verdict: string; trust_checked_at: string }>(sql`
      SELECT trust_score, trust_verdict, trust_checked_at::text FROM channel_models
      WHERE channel_id = ${channelIds[0]} AND upstream_name = 'gpt-6-sol'
    `);
    expect(cm[0]!.trust_score).toBe(63);
    expect(cm[0]!.trust_verdict).toBe('suspect');
    expect(cm[0]!.trust_checked_at).not.toBeNull();

    // 断言 2：推荐分按同步后的可信分 63 计算（非旧值 95）
    const cmScore = await db.execute<{
      recommend_score: number | null; trust_score: number | null;
      uptime_24h: string | null; samples_24h: number | null; latency_p50_24h: number | null; consecutive_failures: number | null;
    }>(sql`
      SELECT cm.recommend_score, cm.trust_score,
             cs.uptime_24h::text, cs.samples_24h, cs.latency_p50_24h, cs.consecutive_failures
      FROM channel_models cm LEFT JOIN channel_stats cs ON cs.channel_id = cm.channel_id
      WHERE cm.channel_id = ${channelIds[0]} AND cm.upstream_name = 'gpt-6-sol'
    `);
    const r = cmScore[0]!;
    const expected = computeRecommendScore({
      uptime24h: Number(r.uptime_24h), latencyP50: r.latency_p50_24h,
      trustScore: r.trust_score, consecutiveFailures: r.consecutive_failures ?? 0,
      samples24h: r.samples_24h ?? 0, weights: WEIGHTS,
    });
    expect(r.recommend_score).toBe(expected);
    expect(r.trust_score).toBe(63); // 分数基于同步后的 63，而非旧 95
    // 63 分 suspect 不触发封顶（≥50），但应低于 trust 95 时的分数
    expect(r.recommend_score!).toBeLessThan(90);

    // 断言 3：一致的数据不会被重复写（第二遍聚合无变化，用 trust_checked_at 稳定性验证）
    const checkedAtBefore = cm[0]!.trust_checked_at;
    await runAggregation(db, { weights: WEIGHTS, minSamplesForScore: 6 });
    const cm2 = await db.execute<{ trust_checked_at: string }>(sql`
      SELECT trust_checked_at::text FROM channel_models
      WHERE channel_id = ${channelIds[0]} AND upstream_name = 'gpt-6-sol'
    `);
    expect(cm2[0]!.trust_checked_at).toBe(checkedAtBefore); // 值相同 → 未重复写入
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
