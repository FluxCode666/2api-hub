/*
 * 调度器集成测试（真库，事务性破坏范围仅自建测试站点/渠道，afterAll 级联清理）：
 * - claimChannels：FOR UPDATE SKIP LOCKED 领取并推进 next_probe_at（±10% 抖动窗口）
 * - jitteredDelay：抖动范围与降频切换
 * - createScheduler.tick：到期渠道被领取并派发（probe mock）
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, encryptSecret } from '@hub/db';
import { createScheduler, claimChannels, jitteredDelay } from '../src/scheduler';
import { createLimiter } from '../src/limiter';
import { newMetrics, loadConfig } from '../src/config';

vi.mock('@hub/probe', () => ({
  probeAvailability: vi.fn(async () => ({
    success: true, model: 'test-model', protocol: 'openai_chat', httpStatus: 200,
    errorCode: null, errorMessage: null, latencyMs: 123, ttftMs: 50,
    inputTokens: 10, outputTokens: 20, tokensPerSec: 30, sample: 'ok', at: new Date().toISOString(),
  })),
}));

const { db, sql: pg } = createDb();
let siteId = 0;
let channelIds: number[] = [];

async function insertTestSite(): Promise<void> {
  const rows = await db.execute<{ id: number }>(sql`
    INSERT INTO sites (owner_id, slug, name, homepage_url, status, recharge_ratio, created_at, updated_at)
    SELECT u.id, 'worker-test-site', 'worker-test-site', 'http://example.test/worker', 'approved', 1, now(), now()
    FROM users u ORDER BY u.created_at ASC LIMIT 1
    RETURNING id
  `);
  siteId = rows[0]!.id;
}

async function insertTestChannels(): Promise<void> {
  const enc = encryptSecret('sk-test-worker');
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) {
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO channels (site_id, name, base_url, api_key_enc, api_key_mask, protocol, primary_model,
        group_ratio, status, probe_enabled, probe_interval_sec, next_probe_at, created_at, updated_at)
      VALUES (${siteId}, ${'worker-test-ch-' + i}, 'http://127.0.0.1:59999/x',
        ${enc}, 'sk-****test',
        'openai_chat', 'gpt-4o-mini',
        1, 'active', true, 600, now() - interval '1 minute', now(), now())
      RETURNING id
    `);
    ids.push(rows[0]!.id);
  }
  channelIds = ids;
}

beforeAll(async () => {
  await insertTestSite();
  await insertTestChannels();
});

afterAll(async () => {
  if (siteId) {
    await db.execute(sql`DELETE FROM sites WHERE id = ${siteId}`); // channels/probe_runs 级联删除
  }
  await pg.end();
});

describe('jitteredDelay', () => {
  it('正常渠道：基础间隔 ±10%', () => {
    for (let i = 0; i < 50; i++) {
      const d = jitteredDelay({ interval_sec: 600, recent_all_fail: false }, 300);
      expect(d).toBeGreaterThanOrEqual(540);
      expect(d).toBeLessThanOrEqual(660);
    }
  });
  it('最近 3 次全失败：切换到降频间隔', () => {
    for (let i = 0; i < 50; i++) {
      const d = jitteredDelay({ interval_sec: 600, recent_all_fail: true }, 300);
      expect(d).toBeGreaterThanOrEqual(270);
      expect(d).toBeLessThanOrEqual(330);
    }
  });
});

describe('claimChannels（真库）', () => {
  it('领取到期渠道并推进 next_probe_at', async () => {
    const delays = Object.fromEntries(channelIds.map((id) => [id, 600]));
    const claimed = await claimChannels(db, channelIds, delays);
    expect(claimed.sort((a, b) => a - b)).toEqual([...channelIds].sort((a, b) => a - b));
    const rows = await db.execute<{ id: number; next_probe_at: string }>(sql`
      SELECT id, next_probe_at FROM channels WHERE id IN (${sql.join(channelIds.map((id) => sql`${id}`), sql`, `)})
    `);
    for (const r of rows) {
      const next = new Date(r.next_probe_at).getTime();
      const diffSec = (next - Date.now()) / 1000;
      expect(diffSec).toBeGreaterThan(540); // 600 - 10% 抖动 - 执行延迟余量
      expect(diffSec).toBeLessThan(700);
    }
  });
});

describe('createScheduler.tick（真库 + probe mock）', () => {
  it('到期渠道被领取、派发探测并写入 probe_runs', async () => {
    // 先把 next_probe_at 拨回过去
    await db.execute(sql`
      UPDATE channels SET next_probe_at = now() - interval '1 minute'
      WHERE id IN (${sql.join(channelIds.map((id) => sql`${id}`), sql`, `)})
    `);
    const config = loadConfig();
    const metrics = newMetrics();
    const done: number[] = [];
    const scheduler = createScheduler({
      db, limiter: createLimiter(8, 2), config, metrics,
      onProbeDone: (o) => done.push(o.channelId),
    });
    await scheduler.tick();
    // 等待异步探测完成
    for (let i = 0; i < 100 && done.length < channelIds.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(done.sort((a, b) => a - b)).toEqual([...channelIds].sort((a, b) => a - b));
    // probe_runs 已写入（mock 成功）
    const runs = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM probe_runs
      WHERE channel_id IN (${sql.join(channelIds.map((id) => sql`${id}`), sql`, `)}) AND kind = 'availability'
    `);
    expect(runs[0]!.n).toBe(channelIds.length);
    // 渠道已重新调度到未来
    const rows = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM channels
      WHERE id IN (${sql.join(channelIds.map((id) => sql`${id}`), sql`, `)}) AND next_probe_at > now()
    `);
    expect(rows[0]!.n).toBe(channelIds.length);
  });
});
