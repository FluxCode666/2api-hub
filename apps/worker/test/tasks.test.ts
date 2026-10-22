/*
 * 任务队列测试（hub_test 隔离库 + probe mock）：
 * - claimNextTask：FIFO 原子领取 + lease（locked_by/lease_token/heartbeat_at）+ attempts 上限原子检查
 * - availability/authenticity/discovery 三种任务执行与库副作用
 * - lease 生命周期：副作用带 lease 校验；lease 易主后放弃写入（审查 #3）
 * - 失败重试到 attempts 上限 → failed + task_failed 通知（error 已脱敏）
 * 注意：probe_tasks_active_uq 唯一索引限制同渠道同 kind 只能有一个活动任务，
 * 因此每个测试用不同渠道或先消费完上一个任务再插入下一个（afterEach 清理）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, encryptSecret } from '@hub/db';
import type { AuthenticityResult, UpstreamModelList } from '@hub/probe';
import { claimNextTask, runTaskToCompletion, heartbeatTask, releaseMyTasks, type TaskDeps } from '../src/tasks';

const { db, sql: pg } = createDb(process.env.DATABASE_URL);
let siteId = 0;
let ownerUuid = '';
/** 每个测试用独立渠道，避免唯一索引冲突 */
let nextChannelId = 0;
const WORKER_ID = 'test-worker-a';

vi.mock('@hub/probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hub/probe')>();
  return {
    ...actual,
    probeAvailability: vi.fn(async () => ({
      success: true, model: 'gpt-6-sol', protocol: 'openai_chat', httpStatus: 200,
      errorCode: null, errorMessage: null, latencyMs: 123, ttftMs: 50,
      inputTokens: 10, outputTokens: 20, tokensPerSec: 30, sample: 'ok', at: new Date().toISOString(),
    })),
    probeAuthenticity: vi.fn(async (): Promise<AuthenticityResult> => ({
      model: 'gpt-6-sol', protocol: 'openai_chat', score: 88, verdict: 'genuine',
      checks: [], durationMs: 1500,
    })),
    listUpstreamModels: vi.fn(async (): Promise<UpstreamModelList> => ({
      ok: true, models: ['gpt-6-sol', 'unknown-model-xyz'], errorCode: null, errorMessage: null,
    })),
  };
});

const deps: TaskDeps = {
  db, workerId: WORKER_ID, maxAttempts: 3, timeoutMs: 5000, notifyEnabled: true,
};

/** 建独立渠道（每渠道最多一个 availability/authenticity/discovery 活动任务） */
async function mkChannel(name: string): Promise<number> {
  const enc = encryptSecret('sk-w-tasks');
  const ch = await db.execute<{ id: number }>(sql`
    INSERT INTO channels (site_id, name, base_url, api_key_enc, api_key_mask, protocol, primary_model,
      group_ratio, status, probe_enabled, probe_interval_sec, next_probe_at, created_at, updated_at)
    VALUES (${siteId}, ${name}, 'http://127.0.0.1:59999/x', ${enc}, 'sk-****tasks',
      'openai_chat', 'gpt-6-sol', 1, 'active', true, 600, now(), now(), now())
    RETURNING id
  `);
  return ch[0]!.id;
}

async function enqueue(channelId: number, kind: 'availability' | 'authenticity' | 'discovery', attempts = 0): Promise<number> {
  const ins = await db.execute<{ id: number }>(sql`
    INSERT INTO probe_tasks (channel_id, kind, trigger, payload, status, requested_by, attempts)
    VALUES (${channelId}, ${kind}, 'merchant', '{}'::jsonb, 'queued', ${ownerUuid}, ${attempts})
    RETURNING id
  `);
  return ins[0]!.id;
}

beforeAll(async () => {
  // 自建最小目录（幂等）：worker 测试不依赖其他测试套件的种子残留
  await db.execute(sql`
    INSERT INTO vendors (slug, name, color, sort_order)
    VALUES ('w-tasks-vendor', 'W任务测试', '#888888', 997)
    ON CONFLICT (slug) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO models (slug, display_name, vendor_id, aliases, default_protocol)
    SELECT 'gpt-6-sol', 'GPT-6 Sol', v.id, ARRAY['gpt-6-sol']::text[], 'openai_chat'
    FROM vendors v WHERE v.slug = 'w-tasks-vendor'
    ON CONFLICT (slug) DO NOTHING
  `);
  const site = await db.execute<{ id: number; owner_id: string }>(sql`
    INSERT INTO sites (owner_id, slug, name, homepage_url, status, recharge_ratio, created_at, updated_at)
    SELECT u.id, 'w-tasks-site', 'w-tasks-site', 'http://example.test/w', 'approved', 1, now(), now()
    FROM users u ORDER BY u.created_at ASC LIMIT 1
    RETURNING id, owner_id::text AS owner_id
  `);
  siteId = site[0]!.id;
  ownerUuid = site[0]!.owner_id;
  // hub_test 隔离库：清空历史遗留任务（含旧版本测试残留，避免 FIFO 领到非本测试任务）
  await db.execute(sql`DELETE FROM probe_tasks`);
  await db.execute(sql`DELETE FROM notifications WHERE user_id = ${ownerUuid}`);
});

beforeEach(async () => {
  nextChannelId = await mkChannel(`w-tasks-ch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
});

afterEach(async () => {
  // 清理本测试的渠道（级联清任务/报告/channel_models/probe_runs）
  await db.execute(sql`DELETE FROM channels WHERE id = ${nextChannelId}`);
});

afterAll(async () => {
  if (siteId) await db.execute(sql`DELETE FROM sites WHERE id = ${siteId}`);
  await pg.end();
});

describe('任务 lease（审查 #3）', () => {
  it('claim 写入 lease 字段；heartbeat 续租成功', async () => {
    const taskId = await enqueue(nextChannelId, 'availability');
    const t = await claimNextTask(db, WORKER_ID, 3);
    expect(t).not.toBeNull();
    expect(t!.id).toBe(taskId);
    expect(t!.attempts).toBe(1);
    const row = await db.execute<{ locked_by: string | null; lease_token: string | null; heartbeat_at: string | null }>(sql`
      SELECT locked_by, lease_token::text, heartbeat_at::text FROM probe_tasks WHERE id = ${taskId}
    `);
    expect(row[0]!.locked_by).toBe(WORKER_ID);
    expect(row[0]!.lease_token).toBe(t!.leaseToken);
    expect(row[0]!.heartbeat_at).not.toBeNull();
    expect(await heartbeatTask(db, t!)).toBe(true);
    await runTaskToCompletion(deps, t!);
  });

  it('lease 易主后 heartbeat 失败、终态写入被放弃', async () => {
    const taskId = await enqueue(nextChannelId, 'availability');
    const t = await claimNextTask(db, WORKER_ID, 3);
    expect(t!.id).toBe(taskId);
    // 模拟另一实例回收（lease 易主）
    await db.execute(sql`
      UPDATE probe_tasks SET status = 'queued', locked_by = NULL, lease_token = NULL, heartbeat_at = NULL
      WHERE id = ${taskId}
    `);
    expect(await heartbeatTask(db, t!)).toBe(false);
    await runTaskToCompletion(deps, t!); // 执行完成但写入应被跳过
    const row = await db.execute<{ status: string }>(sql`
      SELECT status FROM probe_tasks WHERE id = ${taskId}
    `);
    expect(row[0]!.status).toBe('queued'); // done 写入被 lease 校验拒绝
  });

  it('releaseMyTasks 只归还本实例任务', async () => {
    const mineId = await enqueue(nextChannelId, 'availability');
    const mine = await claimNextTask(db, WORKER_ID, 3);
    expect(mine!.id).toBe(mineId);
    // 别人（other-worker-b）的 running 任务：同渠道会撞唯一索引，用第二渠道
    const otherCh = await mkChannel('w-tasks-other');
    await db.execute(sql`
      INSERT INTO probe_tasks (channel_id, kind, trigger, payload, status, locked_by)
      VALUES (${otherCh}, 'availability', 'merchant', '{}'::jsonb, 'running', 'other-worker-b')
    `);
    await releaseMyTasks(db, WORKER_ID);
    const mineRow = await db.execute<{ status: string }>(sql`
      SELECT status FROM probe_tasks WHERE id = ${mineId}
    `);
    expect(mineRow[0]!.status).toBe('queued');
    const otherRow = await db.execute<{ status: string }>(sql`
      SELECT status FROM probe_tasks WHERE locked_by = 'other-worker-b'
    `);
    expect(otherRow.length).toBe(1);
    expect(otherRow[0]!.status).toBe('running');
    await db.execute(sql`DELETE FROM channels WHERE id = ${otherCh}`);
  });
});

describe('三种任务执行', () => {
  it('availability 任务：probe_runs 写入、done、task_done 通知', async () => {
    await enqueue(nextChannelId, 'availability');
    await db.execute(sql`DELETE FROM notifications WHERE user_id = ${ownerUuid}`);
    const t = await claimNextTask(db, WORKER_ID, 3);
    expect(t!.kind).toBe('availability');
    await runTaskToCompletion(deps, t!);
    const rows = await db.execute<{ status: string }>(sql`
      SELECT status FROM probe_tasks WHERE id = ${t!.id}
    `);
    expect(rows[0]!.status).toBe('done');
    const runs = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM probe_runs WHERE channel_id = ${nextChannelId} AND kind = 'availability'
    `);
    expect(runs[0]!.n).toBeGreaterThanOrEqual(1);
    const notes = await db.execute<{ type: string }>(sql`
      SELECT type FROM notifications WHERE user_id = ${ownerUuid} AND type = 'task_done'
    `);
    expect(notes.length).toBe(1);
  });

  it('authenticity 任务：写 authenticity_reports（含 channel_model_id）+ 回写 channel_models trust', async () => {
    await enqueue(nextChannelId, 'authenticity');
    // 先建一个已映射的 channel_models 行，报告应关联它的 id
    await db.execute(sql`
      INSERT INTO channel_models (channel_id, upstream_name, model_id)
      SELECT ${nextChannelId}, 'gpt-6-sol', m.id FROM models m WHERE m.slug = 'gpt-6-sol'
    `);
    const cmRow = await db.execute<{ id: number }>(sql`
      SELECT id FROM channel_models WHERE channel_id = ${nextChannelId} AND upstream_name = 'gpt-6-sol'
    `);
    const cmId = cmRow[0]!.id;
    const t = await claimNextTask(db, WORKER_ID, 3);
    expect(t!.kind).toBe('authenticity');
    await runTaskToCompletion(deps, t!);
    const reports = await db.execute<{ score: number; verdict: string; task_id: string; channel_model_id: number | null }>(sql`
      SELECT score, verdict, task_id::text, channel_model_id FROM authenticity_reports WHERE channel_id = ${nextChannelId}
    `);
    expect(reports.length).toBe(1);
    expect(reports[0]!.score).toBe(88);
    expect(Number(reports[0]!.task_id)).toBe(Number(t!.id));
    expect(reports[0]!.channel_model_id).toBe(cmId); // 报告正确关联模型行
    const cm = await db.execute<{ trust_score: number; trust_verdict: string }>(sql`
      SELECT trust_score, trust_verdict FROM channel_models
      WHERE channel_id = ${nextChannelId} AND upstream_name = 'gpt-6-sol'
    `);
    expect(cm[0]!.trust_score).toBe(88);
    expect(cm[0]!.trust_verdict).toBe('genuine');
  });

  it('discovery 任务：upsert channel_models 并做目录匹配', async () => {
    await enqueue(nextChannelId, 'discovery');
    const t = await claimNextTask(db, WORKER_ID, 3);
    expect(t!.kind).toBe('discovery');
    await runTaskToCompletion(deps, t!);
    const models = await db.execute<{ upstream_name: string; model_id: number | null }>(sql`
      SELECT upstream_name, model_id FROM channel_models WHERE channel_id = ${nextChannelId} AND model_id IS NOT NULL
    `);
    const byName = new Map(models.map((m) => [m.upstream_name, m.model_id]));
    expect(byName.get('gpt-6-sol')).not.toBeNull();
  });

  it('失败任务 attempts 已达上限 → failed + task_failed 通知（error 脱敏，审查 #1）', async () => {
    const { listUpstreamModels } = await import('@hub/probe');
    vi.mocked(listUpstreamModels).mockResolvedValueOnce({
      ok: false, models: [], errorCode: 'http_404', errorMessage: 'not found key sk-w-tasks xxx',
    });
    const taskId = await enqueue(nextChannelId, 'discovery', 2); // attempts=2，claim 后=3 达上限
    const t = await claimNextTask(db, WORKER_ID, 3);
    expect(t!.id).toBe(taskId);
    expect(t!.attempts).toBe(3);
    await runTaskToCompletion(deps, t!);
    const rows = await db.execute<{ status: string; error: string | null }>(sql`
      SELECT status, error FROM probe_tasks WHERE id = ${taskId}
    `);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.error).not.toContain('sk-w-tasks'); // Key 已脱敏
    const notes = await db.execute<{ type: string; body: string }>(sql`
      SELECT type, body FROM notifications WHERE user_id = ${ownerUuid} AND type = 'task_failed'
    `);
    expect(notes.length).toBe(1);
    expect(notes[0]!.body).not.toContain('sk-w-tasks');
  });

  it('attempts 上限原子检查：queued 且 attempts>=max 的任务在领取前标 failed', async () => {
    const overCh = await mkChannel('w-tasks-over');
    const taskId = await enqueue(overCh, 'discovery', 3); // attempts=3 ≥ max
    // 领取动作本身把超限任务标 failed
    const t = await claimNextTask(db, WORKER_ID, 3);
    const row = await db.execute<{ status: string }>(sql`
      SELECT status FROM probe_tasks WHERE id = ${taskId}
    `);
    expect(row[0]!.status).toBe('failed');
    if (t) await runTaskToCompletion(deps, t); // 若领到别任务则消费掉
    await db.execute(sql`DELETE FROM channels WHERE id = ${overCh}`);
  });
});
