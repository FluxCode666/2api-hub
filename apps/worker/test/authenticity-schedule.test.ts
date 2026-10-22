/*
 * 定时真伪检测范围测试（hub_test 隔离库，全部自建资源）：
 * - modelScope 三种取值的到期计算（primary=不做非主测 / featured=精选 / all=全部）
 * - 从未检测过的模型立即到期
 * - 同渠道多到期模型合并进一个任务 payload.models；已有 queued 任务时合并进现有 payload
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb } from '@hub/db';
import { scheduleAuthenticitySweep } from '../src/authenticity-schedule';

const { db, sql: pg } = createDb(process.env.DATABASE_URL);
let siteId = 0;
let ownerUuid = '';
const channelIds: number[] = [];

async function mkCatalog(): Promise<void> {
  // 目录：一个精选 + 一个非精选（幂等）
  await db.execute(sql`
    INSERT INTO vendors (slug, name, color, sort_order)
    VALUES ('w-test-vendor', 'W测试厂商', '#888888', 999)
    ON CONFLICT (slug) DO NOTHING
  `);
  const specs: { slug: string; name: string; featured: boolean }[] = [
    { slug: 'w-featured-model', name: 'W精选', featured: true },
    { slug: 'w-plain-model', name: 'W普通', featured: false },
  ];
  for (const m of specs) {
    await db.execute(sql`
      INSERT INTO models (slug, display_name, vendor_id, is_featured, aliases, default_protocol)
      SELECT ${m.slug}, ${m.name}, v.id, ${m.featured}, ARRAY[${m.slug}]::text[], 'openai_chat'
      FROM vendors v WHERE v.slug = 'w-test-vendor'
      ON CONFLICT (slug) DO NOTHING
    `);
  }
}

async function mkChannel(name: string, primaryModel: string, upstreamNames: string[]): Promise<number> {
  const ch = await db.execute<{ id: number }>(sql`
    INSERT INTO channels (site_id, name, base_url, api_key_enc, api_key_mask, protocol, primary_model,
      group_ratio, status, probe_enabled, probe_interval_sec, next_probe_at, created_at, updated_at)
    VALUES (${siteId}, ${name}, 'http://127.0.0.1:59999/x', 'v1:x', 'sk-****x',
      'openai_chat', ${primaryModel}, 1, 'active', true, 600, now(), now(), now())
    RETURNING id
  `);
  const id = ch[0]!.id;
  for (const up of upstreamNames) {
    await db.execute(sql`
      INSERT INTO channel_models (channel_id, upstream_name, model_id)
      SELECT ${id}, ${up}, m.id FROM models m WHERE m.slug = ${up}
    `);
  }
  return id;
}

/** 插入一条该模型的历史报告（时间可指定，null = 不插 → 从未检测） */
async function mkReport(channelId: number, model: string, hoursAgo: number | null): Promise<void> {
  if (hoursAgo === null) return;
  await db.execute(sql`
    INSERT INTO authenticity_reports (channel_id, model, protocol, score, verdict, checks, duration_ms, trigger, created_at)
    VALUES (${channelId}, ${model}, 'openai_chat', 90, 'genuine', '[]'::jsonb, 100, 'schedule',
      now() - make_interval(hours => ${hoursAgo}))
  `);
}

beforeAll(async () => {
  const site = await db.execute<{ id: number; owner_id: string }>(sql`
    INSERT INTO sites (owner_id, slug, name, homepage_url, status, recharge_ratio, created_at, updated_at)
    SELECT u.id, 'w-auth-sched-site', 'w-auth-sched-site', 'http://example.test/w', 'approved', 1, now(), now()
    FROM users u ORDER BY u.created_at ASC LIMIT 1
    RETURNING id, owner_id::text AS owner_id
  `);
  siteId = site[0]!.id;
  ownerUuid = site[0]!.owner_id;
  await mkCatalog();
  await db.execute(sql`DELETE FROM probe_tasks WHERE channel_id IN (SELECT id FROM channels WHERE site_id = ${siteId})`);
});

afterAll(async () => {
  if (siteId) await db.execute(sql`DELETE FROM sites WHERE id = ${siteId}`);
  await pg.end();
});

const DEPS = {
  db,
  intervalHours: 24,
  modelScope: 'all' as const,
  secondaryIntervalHours: 48,
  maxPerSweep: 10, // 测试中放宽每轮渠道数
};

async function taskPayloads(): Promise<{ channel_id: number; payload: { models?: string[] } }[]> {
  const rows = await db.execute<{ channel_id: number; payload: { models?: string[] } }>(sql`
    SELECT channel_id, payload FROM probe_tasks WHERE kind = 'authenticity' AND status IN ('queued','running')
      AND channel_id IN (SELECT id FROM channels WHERE site_id = ${siteId})
  `);
  return rows;
}

async function clearTasks(): Promise<void> {
  await db.execute(sql`DELETE FROM probe_tasks WHERE channel_id IN (SELECT id FROM channels WHERE site_id = ${siteId})`);
}

describe('modelScope 到期计算', () => {
  it('all：从未检测过的非主测模型立即到期，与主测合并进同一任务', async () => {
    await clearTasks();
    const ch = await mkChannel('w-ch-all', 'w-featured-model', ['w-featured-model', 'w-plain-model']);
    channelIds.push(ch);
    // 主测模型从未检测 → 也立即到期；两个非主测从未检测 → 立即到期
    const r = await scheduleAuthenticitySweep({ ...DEPS, modelScope: 'all' });
    expect(r.created).toBeGreaterThanOrEqual(1);
    const tasks = await taskPayloads();
    const mine = tasks.find((t) => t.channel_id === ch);
    expect(mine, '自建渠道应有合并任务').toBeDefined();
    const payload = mine!.payload?.models ?? [];
    expect(new Set(payload)).toEqual(new Set(['w-featured-model', 'w-plain-model']));
    await clearTasks();
    await db.execute(sql`DELETE FROM channels WHERE id = ${ch}`);
  });

  it('featured：只有精选非主测模型到期，非精选被排除', async () => {
    await clearTasks();
    const ch = await mkChannel('w-ch-featured', 'w-plain-model', ['w-featured-model', 'w-plain-model']);
    // 主测 = w-plain-model（从未检测，主测不受 scope 限制，立即到期）
    // 非主测：仅 w-featured-model（精选）到期
    const r = await scheduleAuthenticitySweep({ ...DEPS, modelScope: 'featured' });
    expect(r.created).toBeGreaterThanOrEqual(1);
    const tasks = await taskPayloads();
    const mine = tasks.find((t) => t.channel_id === ch);
    expect(mine).toBeDefined();
    const payload = mine!.payload?.models ?? [];
    expect(new Set(payload)).toEqual(new Set(['w-plain-model', 'w-featured-model'])); // 主测 + 精选
    await clearTasks();
    await db.execute(sql`DELETE FROM channels WHERE id = ${ch}`);
  });

  it('primary：非主测模型完全不检测（payload 只含主测）', async () => {
    await clearTasks();
    const ch = await mkChannel('w-ch-primary', 'w-featured-model', ['w-featured-model', 'w-plain-model']);
    const r = await scheduleAuthenticitySweep({ ...DEPS, modelScope: 'primary' });
    expect(r.created).toBeGreaterThanOrEqual(1);
    const tasks = await taskPayloads();
    const mine = tasks.find((t) => t.channel_id === ch);
    expect(mine).toBeDefined();
    const payload = mine!.payload?.models ?? [];
    expect(new Set(payload)).toEqual(new Set(['w-featured-model'])); // 仅主测
    await clearTasks();
    await db.execute(sql`DELETE FROM channels WHERE id = ${ch}`);
  });

  it('secondaryIntervalHours 内已检测的非主测模型不到期', async () => {
    await clearTasks();
    const ch = await mkChannel('w-ch-recent', 'w-featured-model', ['w-featured-model', 'w-plain-model']);
    // 主测 10h 前检测过（24h 内未到期）；非主测 10h 前检测过（48h 内未到期）
    await mkReport(ch, 'w-featured-model', 10);
    await mkReport(ch, 'w-plain-model', 10);
    const r = await scheduleAuthenticitySweep({ ...DEPS, modelScope: 'all' });
    const tasks = await taskPayloads();
    expect(tasks.find((t) => t.channel_id === ch)).toBeUndefined(); // 自己渠道无到期
    // 主测 30h 前检测过（> 24h 到期）；非主测 30h 前检测过（< 48h 未到期）
    await db.execute(sql`DELETE FROM authenticity_reports WHERE channel_id = ${ch}`);
    await mkReport(ch, 'w-featured-model', 30);
    await mkReport(ch, 'w-plain-model', 30);
    const r2 = await scheduleAuthenticitySweep({ ...DEPS, modelScope: 'all' });
    void r2;
    const mine2 = (await taskPayloads()).find((t) => t.channel_id === ch);
    const payload = mine2!.payload?.models ?? [];
    expect(new Set(payload)).toEqual(new Set(['w-featured-model'])); // 只有主测到期
    await clearTasks();
    await db.execute(sql`DELETE FROM channels WHERE id = ${ch}`);
  });

  it('已有 queued 任务时：新到期模型合并进现有 payload', async () => {
    await clearTasks();
    const ch = await mkChannel('w-ch-merge', 'w-featured-model', ['w-featured-model', 'w-plain-model']);
    // 手动放一个已存在的 queued 任务（payload 只有主测）
    await db.execute(sql`
      INSERT INTO probe_tasks (channel_id, kind, trigger, payload, status)
      VALUES (${ch}, 'authenticity', 'schedule', ${JSON.stringify({ models: ['w-featured-model'] })}::jsonb, 'queued')
    `);
    // 两个非主测从未检测 → 到期 → 应合并进现有任务而非新建
    const r = await scheduleAuthenticitySweep({ ...DEPS, modelScope: 'all' });
    expect(r.merged).toBeGreaterThanOrEqual(1); // w-plain-model 合并进现有任务
    const tasks = await taskPayloads();
    const mine = tasks.find((t) => t.channel_id === ch);
    expect(mine).toBeDefined();
    const payload = mine!.payload?.models ?? [];
    expect(new Set(payload)).toEqual(new Set(['w-featured-model', 'w-plain-model']));
    await clearTasks();
    await db.execute(sql`DELETE FROM channels WHERE id = ${ch}`);
  });
});
