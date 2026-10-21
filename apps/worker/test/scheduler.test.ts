/*
 * 调度器测试（hub_test 隔离库，全部自建资源）：
 * - claimDueChannels：原子领取（完整谓词 + 推进 next_probe_at + lease 语义验证）
 * - #16：恰好 3 条全失败才降频（1-2 条失败仍用基础间隔）
 * - createScheduler.tick：到期渠道领取并派发探测（probe mock），主测回写 channel_models
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, encryptSecret } from '@hub/db';
import { createScheduler, claimDueChannels, jitteredDelay } from '../src/scheduler';
import { createLimiter } from '../src/limiter';
import { newMetrics, loadConfig } from '../src/config';

vi.mock('@hub/probe', () => ({
  probeAvailability: vi.fn(async () => ({
    success: true, model: 'test-model', protocol: 'openai_chat', httpStatus: 200,
    errorCode: null, errorMessage: null, latencyMs: 123, ttftMs: 50,
    inputTokens: 10, outputTokens: 20, tokensPerSec: 30, sample: 'ok', at: new Date().toISOString(),
  })),
}));

const { db, sql: pg } = createDb(process.env.DATABASE_URL);
let siteId = 0;
let mainCh = 0;
let oneFailCh = 0;
let backupCh = 0;

const NUM_SORT = (a: number, b: number) => a - b;

beforeAll(async () => {
  const site = await db.execute<{ id: number }>(sql`
    INSERT INTO sites (owner_id, slug, name, homepage_url, status, recharge_ratio, created_at, updated_at)
    SELECT u.id, 'w-sched-site', 'w-sched-site', 'http://example.test/w', 'approved', 1, now(), now()
    FROM users u ORDER BY u.created_at ASC LIMIT 1
    RETURNING id
  `);
  siteId = site[0]!.id;
  const enc = encryptSecret('sk-w-sched');
  async function mkCh(name: string, backupModel: string | null): Promise<number> {
    const ch = await db.execute<{ id: number }>(sql`
      INSERT INTO channels (site_id, name, base_url, api_key_enc, api_key_mask, protocol, primary_model,
        backup_model, group_ratio, status, probe_enabled, probe_interval_sec, next_probe_at, created_at, updated_at)
      VALUES (${siteId}, ${name}, 'http://127.0.0.1:59999/x', ${enc}, 'sk-****sch',
        'openai_chat', 'gpt-6-sol', ${backupModel}, 1, 'active', true, 600, now() - interval '1 minute', now(), now())
      RETURNING id
    `);
    return ch[0]!.id;
  }
  mainCh = await mkCh('w-sched-main', null);
  oneFailCh = await mkCh('w-sched-onefail', null);
  backupCh = await mkCh('w-sched-backup', 'glm-5.3');

  // oneFailCh：恰好 1 条失败（不足 3 条，#16：不应降频）
  await db.execute(sql`
    INSERT INTO probe_runs (channel_id, model, protocol, kind, trigger, success, http_status, created_at)
    VALUES (${oneFailCh}, 'gpt-6-sol', 'openai_chat', 'availability', 'schedule', false, 503, now())
  `);
});

afterAll(async () => {
  if (siteId) await db.execute(sql`DELETE FROM sites WHERE id = ${siteId}`);
  await pg.end();
});

describe('jitteredDelay（#16 语义的纯函数镜像）', () => {
  it('正常渠道：基础间隔 ±10%', () => {
    for (let i = 0; i < 50; i++) {
      const d = jitteredDelay({ interval_sec: 600, recent_all_fail: false }, 300);
      expect(d).toBeGreaterThanOrEqual(540);
      expect(d).toBeLessThanOrEqual(660);
    }
  });
  it('最近恰好 3 条全失败：切换到降频间隔', () => {
    for (let i = 0; i < 50; i++) {
      const d = jitteredDelay({ interval_sec: 600, recent_all_fail: true }, 300);
      expect(d).toBeGreaterThanOrEqual(270);
      expect(d).toBeLessThanOrEqual(330);
    }
  });
});

describe('claimDueChannels（原子领取，审查 #2）', () => {
  it('领取到期渠道并推进 next_probe_at；未到期/锁定谓词内判断', async () => {
    const claimed = await claimDueChannels(db, 10, 300);
    expect(claimed.length).toBeGreaterThan(0);
    const ids = claimed.map((r) => r.channel_id).sort(NUM_SORT);
    for (const id of [mainCh, oneFailCh, backupCh]) {
      if (id === oneFailCh) {
        // oneFailCh 应在领取列表中（到期）
        expect(ids).toContain(id);
      }
    }
    // 所有领取到的渠道 next_probe_at 已推进到未来
    for (const r of claimed) {
      const rows = await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM channels WHERE id = ${r.channel_id} AND next_probe_at > now()
      `);
      expect(rows[0]!.n).toBe(1);
    }
  });

  it('恰好 1 条失败的渠道使用基础间隔（600s ±10%），不降频（#16）', async () => {
    const rows = await db.execute<{ next_probe_at: string }>(sql`
      SELECT next_probe_at::text FROM channels WHERE id = ${oneFailCh}
    `);
    const diffSec = (new Date(rows[0]!.next_probe_at).getTime() - Date.now()) / 1000;
    expect(diffSec).toBeGreaterThan(530); // 基础间隔 600s × 0.9 下限（留执行余量）
    expect(diffSec).toBeLessThan(670);
  });

  it('重复领取同一渠道返回空（谓词含 next_probe_at <= now，审查 #2）', async () => {
    // 上轮已把所有测试渠道推进到未来；再调一次应领不到这些渠道
    const claimed = await claimDueChannels(db, 10, 300);
    const ids = claimed.map((r) => r.channel_id);
    for (const id of [mainCh, oneFailCh, backupCh]) {
      expect(ids).not.toContain(id);
    }
  });
});

describe('createScheduler.tick（真库 + probe mock）', () => {
  it('到期渠道被领取、派发探测、写 probe_runs 并回写 channel_models（#15）', async () => {
    // 把 mainCh 和 backupCh 拨回过去
    await db.execute(sql`
      UPDATE channels SET next_probe_at = now() - interval '1 minute'
      WHERE id IN (${mainCh}, ${backupCh})
    `);
    const config = loadConfig();
    const metrics = newMetrics();
    const done: number[] = [];
    const limiter = createLimiter(8, 2);
    const scheduler = createScheduler({
      db, limiter: () => limiter, config, metrics,
      probeTimeoutMs: () => 5000, globalMax: () => 8,
      onProbeDone: (o) => done.push(o.channelId),
    });
    await scheduler.tick();
    for (let i = 0; i < 100 && scheduler.inFlightSize() > 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(done.sort(NUM_SORT)).toContain(mainCh);
    // 主测模型 probe_runs 写入 + channel_models 回写（last_status=pass）
    const runs = await db.execute<{ model: string; n: number }>(sql`
      SELECT model, COUNT(*)::int AS n FROM probe_runs
      WHERE channel_id = ${mainCh} AND kind = 'availability' GROUP BY model
    `);
    expect(runs[0]!.model).toBe('gpt-6-sol');
    const cm = await db.execute<{ last_status: string; last_latency_ms: number | null }>(sql`
      SELECT last_status, last_latency_ms FROM channel_models
      WHERE channel_id = ${mainCh} AND upstream_name = 'gpt-6-sol'
    `);
    expect(cm[0]!.last_status).toBe('pass');
    expect(cm[0]!.last_latency_ms).toBe(123);
  });

  it('备用模型单独探测并写独立 probe_runs（#15）', async () => {
    const runs = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM probe_runs
      WHERE channel_id = ${backupCh} AND kind = 'availability' AND model = 'glm-5.3'
    `);
    expect(runs[0]!.n).toBe(1);
    // 备用模型也回写自己的 channel_models 行
    const cm = await db.execute<{ last_status: string }>(sql`
      SELECT last_status FROM channel_models
      WHERE channel_id = ${backupCh} AND upstream_name = 'glm-5.3'
    `);
    expect(cm[0]!.last_status).toBe('pass');
  });
});
