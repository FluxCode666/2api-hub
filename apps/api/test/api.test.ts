/*
 * API 集成测试（vitest）：使用独立测试库 hub_test（不动开发库）。
 * 运行前确保 hub_test 已执行迁移：
 *   DATABASE_URL=postgres://hub:hub@127.0.0.1:54329/hub_test pnpm --filter @hub/db migrate
 * 覆盖：入驻→提交→审核流程、越权访问、Key 不泄露、榜单筛选排序、#7 榜单去重、#5 入队去重。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

// 独立测试库（与开发库隔离）
const TEST_DATABASE_URL = process.env.DATABASE_URL?.replace(/\/hub$/, '/hub_test')
  ?? 'postgres://hub:hub@127.0.0.1:54329/hub_test';
process.env.DATABASE_URL = TEST_DATABASE_URL;

import { buildApp } from '../src/app';
import { createDb, encryptSecret, schema } from '@hub/db';
import { sql } from 'drizzle-orm';

let app: FastifyInstance;
const { db, sql: pg } = createDb(TEST_DATABASE_URL);

async function resetAll() {
  await db.execute(sql`TRUNCATE probe_runs, probe_tasks, authenticity_reports, channel_models,
    channel_stats, site_stats, favorites, reviews, notifications, channels, sites,
    verify_requests, feedback, announcements, audit_logs, settings,
    models, vendors, users RESTART IDENTITY CASCADE`);
}

async function seedMinimal() {
  const bcrypt = (await import('bcryptjs')).default;
  const hash = await bcrypt.hash('password123', 10);
  const [admin] = await db.insert(schema.users).values({
    email: 'test-admin@t.dev', passwordHash: hash, nickname: 'T管理员', role: 'admin',
  }).returning();
  const [merchant] = await db.insert(schema.users).values({
    email: 'test-merchant@t.dev', passwordHash: hash, nickname: 'T站长', role: 'merchant',
  }).returning();
  const [other] = await db.insert(schema.users).values({
    email: 'test-other@t.dev', passwordHash: hash, nickname: 'T别人', role: 'user',
  }).returning();

  const [vendor] = await db.insert(schema.vendors).values({
    slug: 'anthropic', name: 'Anthropic', color: '#D97757', sortOrder: 1,
  }).returning();
  const [model] = await db.insert(schema.models).values({
    slug: 'claude-opus-5-5', displayName: 'Opus 5.5', vendorId: vendor!.id,
    aliases: ['claude-opus-5-5'], defaultProtocol: 'anthropic',
    officialInputPrice: 15, officialOutputPrice: 75,
  }).returning();

  const [site] = await db.insert(schema.sites).values({
    ownerId: merchant!.id, slug: 't-site', name: 'T站', homepageUrl: 'https://t.dev',
    type: 'new_api', rechargeRatio: 0.5, status: 'approved', submittedAt: new Date(), approvedAt: new Date(),
  }).returning();

  const mkChannel = async (name: string, ratio: number, uptime?: number) => {
    const [c] = await db.insert(schema.channels).values({
      siteId: site!.id, name, protocol: 'anthropic', baseUrl: 'http://127.0.0.1:8712/genuine',
      apiKeyEnc: encryptSecret('sk-test-secret-key-0001'), apiKeyMask: 'sk-****0001',
      groupRatio: ratio, primaryModel: 'claude-opus-5-5', status: 'active',
      vendorId: vendor!.id,
    }).returning();
    await db.insert(schema.channelModels).values({
      channelId: c!.id, upstreamName: 'claude-opus-5-5', modelId: model!.id,
      lastStatus: 'pass', trustScore: 95, trustVerdict: 'genuine',
    });
    if (uptime !== undefined) {
      await db.insert(schema.channelStats).values({
        channelId: c!.id, uptime24h: uptime, uptime1h: uptime, uptime7d: uptime,
        samples24h: 100, latencyP50_24h: 1200, latencyP95_24h: 2000, ttftAvg24h: 600,
        consecutiveFailures: 0, trustScore: 95, trustVerdict: 'genuine',
        recommendScore: uptime * 90, sparkline: [],
      });
    }
    return c!;
  };

  const cheap = await mkChannel('T低价渠道', 0.1, 0.99);
  const dear = await mkChannel('T高价渠道', 1.0, 0.95);

  return { admin: admin!, merchant: merchant!, other: other!, site: site!, cheap, dear, vendor: vendor!, model: model! };
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? sc[0] : (sc as string);
  return raw?.split(';')[0] ?? '';
}

async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'password123' } });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

let ctx: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  await resetAll();
  ctx = await seedMinimal();
  app = await buildApp({ logger: false });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  await pg.end();
});

describe('认证', () => {
  it('注册→me→登出', async () => {
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'test-new@t.dev', password: 'password123', nickname: '新人' } });
    expect(reg.statusCode).toBe(201);
    const cookie = cookieOf(reg);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('test-new@t.dev');
  });

  it('未登录访问受保护接口返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/merchant/sites' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('密码错误返回 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'test-merchant@t.dev', password: 'wrong-password' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('榜单筛选与排序', () => {
  it('按价格升序，null 排最后', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/channels?sort=price&order=asc' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(2);
    const prices = body.items.map((i: { price: { inputCny: number } | null }) => i.price?.inputCny ?? Infinity);
    expect(prices).toEqual([...prices].sort((a: number, b: number) => a - b));
    expect(body.items[0].name).toBe('T低价渠道');
    expect(body.items[0].rank).toBe(1);
  });

  it('按可用率降序 + minUptime 筛选', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/channels?sort=uptime&minUptime=0.98' });
    const body = res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].name).toBe('T低价渠道');
  });

  it('按模型筛选价格（官方价 × 实际倍率）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/channels?model=claude-opus-5-5&sort=price' });
    const body = res.json();
    expect(body.items.length).toBe(2);
    expect(body.items[0].price.inputCny).toBeCloseTo(3, 1);
  });

  it('#7 按模型查询不重复上榜（同渠道多别名映射同一模型）', async () => {
    // 给低价渠道加第二个别名映射到同一模型
    await db.insert(schema.channelModels).values({
      channelId: ctx.cheap.id, upstreamName: 'claude-opus-5.5-alias', modelId: ctx.model.id,
      lastStatus: 'pass', trustScore: 90, trustVerdict: 'genuine',
    }).onConflictDoNothing();
    const res = await app.inject({ method: 'GET', url: '/api/v1/channels?model=claude-opus-5-5&pageSize=100' });
    const body = res.json();
    const ids = body.items.map((i: { id: number }) => i.id);
    expect(ids.length).toBe(new Set(ids).size); // 无重复
    expect(body.total).toBe(ids.length);
  });

  it('stableOnly 过滤（true/false 显式解析）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/channels?stableOnly=true' });
    expect(res.json().items.length).toBe(2);
    const res2 = await app.inject({ method: 'GET', url: '/api/v1/channels?stableOnly=false' });
    expect(res2.json().items.length).toBe(2);
  });

  it('q 搜索 + ids 批量', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/channels?q=低价' });
    expect(res.json().items.length).toBe(1);
    const res2 = await app.inject({ method: 'GET', url: `/api/v1/channels?ids=${ctx.cheap.id}` });
    expect(res2.json().items.length).toBe(1);
  });

  it('分页 rank 跨页连续', async () => {
    const p1 = await app.inject({ method: 'GET', url: '/api/v1/channels?pageSize=1&page=1&sort=ratio' });
    const p2 = await app.inject({ method: 'GET', url: '/api/v1/channels?pageSize=1&page=2&sort=ratio' });
    expect(p1.json().items[0].rank).toBe(1);
    expect(p2.json().items[0].rank).toBe(2);
  });
});

describe('入驻→提交→审核流程', () => {
  it('完整流程：注册→建站→建渠道→提交→管理员审核→角色升级→公开可见', async () => {
    const cookie = await login('test-other@t.dev');
    const siteRes = await app.inject({
      method: 'POST', url: '/api/v1/merchant/sites', headers: { cookie },
      payload: { name: '流程站', homepageUrl: 'https://flow.dev', type: 'new_api', rechargeRatio: 0.5 },
    });
    expect(siteRes.statusCode).toBe(201);
    const siteId = siteRes.json().id;

    const chRes = await app.inject({
      method: 'POST', url: `/api/v1/merchant/sites/${siteId}/channels`, headers: { cookie },
      payload: { name: '流程渠道', protocol: 'anthropic', baseUrl: 'http://127.0.0.1:8712/genuine', apiKey: 'sk-flow-test-00000002', groupRatio: 0.5, primaryModel: 'claude-opus-5-5', declaredModels: ['claude-opus-5-5'] },
    });
    expect(chRes.statusCode).toBe(201);
    const channelId = chRes.json().id;

    const early = await app.inject({ method: 'POST', url: `/api/v1/merchant/sites/${siteId}/submit`, headers: { cookie } });
    expect(early.statusCode).toBe(400);

    await db.execute(sql`UPDATE channels SET last_test_ok = true, last_test_at = now() WHERE id = ${channelId}`);

    const submit = await app.inject({ method: 'POST', url: `/api/v1/merchant/sites/${siteId}/submit`, headers: { cookie } });
    expect(submit.statusCode).toBe(200);

    const adminCookie = await login('test-admin@t.dev');
    const approve = await app.inject({
      method: 'POST', url: `/api/v1/admin/sites/${siteId}/review`, headers: { cookie: adminCookie },
      payload: { action: 'approve' },
    });
    expect(approve.statusCode).toBe(200);

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.json().role).toBe('merchant');

    const pub = await app.inject({ method: 'GET', url: '/api/v1/sites?q=流程' });
    expect(pub.json().total).toBe(1);

    const notif = await app.inject({ method: 'GET', url: '/api/v1/me/notifications', headers: { cookie } });
    expect(notif.json().some((n: { type: string }) => n.type === 'site_approved')).toBe(true);

    const rej = await app.inject({
      method: 'POST', url: `/api/v1/admin/sites/${siteId}/review`, headers: { cookie: adminCookie },
      payload: { action: 'suspend', reason: '测试下架' },
    });
    expect(rej.statusCode).toBe(200);
    const pub2 = await app.inject({ method: 'GET', url: '/api/v1/sites?q=流程' });
    expect(pub2.json().total).toBe(0);
  });
});

describe('越权访问', () => {
  it('站长不能访问别人的站点（404）', async () => {
    const cookie = await login('test-other@t.dev');
    const res = await app.inject({ method: 'GET', url: `/api/v1/merchant/sites/${ctx.site.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('普通用户不能访问管理接口（403）', async () => {
    const cookie = await login('test-other@t.dev');
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/overview', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('站长不能调用管理审核（403）', async () => {
    const cookie = await login('test-merchant@t.dev');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/sites/${ctx.site.id}/review`, headers: { cookie },
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Key 不泄露', () => {
  it('渠道详情不返回明文 Key 或密文', async () => {
    const cookie = await login('test-merchant@t.dev');
    const res = await app.inject({ method: 'GET', url: `/api/v1/merchant/sites/${ctx.site.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('sk-test-secret-key-0001');
    expect(res.body).not.toContain('apiKeyEnc');
    expect(res.body).toContain('sk-****0001');
  });

  it('公开渠道详情不含 Key 字段', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/channels/${ctx.cheap.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('apiKey');
  });
});

describe('#5 入队去重', () => {
  it('同一渠道同 kind 已有活动任务时复用（不重复入队）', async () => {
    const cookie = await login('test-merchant@t.dev');
    // 连续两次触发，第二次应复用第一个任务
    const r1 = await app.inject({ method: 'POST', url: `/api/v1/merchant/channels/${ctx.cheap.id}/authenticity`, headers: { cookie }, payload: {} });
    expect([200, 202]).toContain(r1.statusCode);
    const taskId = r1.json().id;

    const r2 = await app.inject({ method: 'POST', url: `/api/v1/merchant/channels/${ctx.cheap.id}/authenticity`, headers: { cookie }, payload: {} });
    expect(r2.statusCode).toBe(200); // 复用返回 200
    expect(r2.json().id).toBe(taskId);

    // 确认只有一个活动任务
    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT count(*)::int AS cnt FROM probe_tasks
      WHERE channel_id = ${ctx.cheap.id} AND kind = 'authenticity' AND status IN ('queued','running')`);
    expect(rows[0]?.['cnt']).toBe(1);
  });

  it('PATCH 相同 Key 不产生新任务', async () => {
    const cookie = await login('test-merchant@t.dev');
    const before = await db.execute<Record<string, unknown>>(sql`
      SELECT count(*)::int AS cnt FROM probe_tasks WHERE channel_id = ${ctx.dear.id}`);
    // 传入与当前相同的 Key
    await db.execute(sql`UPDATE channels SET api_key_enc = ${encryptSecret('sk-same-key-00000003')} WHERE id = ${ctx.dear.id}`);
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/merchant/channels/${ctx.dear.id}`, headers: { cookie },
      payload: { apiKey: 'sk-same-key-00000003' },
    });
    expect(res.statusCode).toBe(200);
    const after = await db.execute<Record<string, unknown>>(sql`
      SELECT count(*)::int AS cnt FROM probe_tasks WHERE channel_id = ${ctx.dear.id}`);
    expect(after[0]?.['cnt']).toBe(before[0]?.['cnt']);
  });
});

describe('评价', () => {
  it('发表→更新→/me/reviews→删除', async () => {
    const cookie = await login('test-other@t.dev');
    const r1 = await app.inject({
      method: 'POST', url: `/api/v1/sites/${ctx.site.slug}/reviews`, headers: { cookie },
      payload: { rating: 5, content: '很好用' },
    });
    expect(r1.statusCode).toBe(201);
    const reviewId = r1.json().id;

    const r2 = await app.inject({
      method: 'POST', url: `/api/v1/sites/${ctx.site.slug}/reviews`, headers: { cookie },
      payload: { rating: 4, content: '还行' },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().id).toBe(reviewId);
    expect(r2.json().rating).toBe(4);

    const mine = await app.inject({ method: 'GET', url: '/api/v1/me/reviews', headers: { cookie } });
    expect(mine.json().items.length).toBe(1);
    expect(mine.json().items[0].site.slug).toBe('t-site');

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/me/reviews/${reviewId}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);

    const del2 = await app.inject({ method: 'DELETE', url: `/api/v1/me/reviews/${reviewId}`, headers: { cookie } });
    expect(del2.statusCode).toBe(404);
  });
});
