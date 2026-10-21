/*
 * 任务队列执行器测试（真库 + probe mock）：
 * - availability 任务：probe_runs 写入、task done、task_done 通知
 * - authenticity 任务：authenticity_reports 写入、channel_models trust 回写
 * - discovery 任务：channel_models upsert（matchCatalogModel 映射）
 * - 失败重试到 attempts>=3 → failed + task_failed 通知
 * 预存的 queued 任务（API 测试遗留）在 beforeAll 临时置为 running 隐藏，afterAll 恢复。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, encryptSecret } from '@hub/db';
import type { AuthenticityResult, UpstreamModelList } from '@hub/probe';
import { claimNextTask, runTaskToCompletion, type TaskDeps } from '../src/tasks';

const { db, sql: pg } = createDb();
let siteId = 0;
let ownerUuid = '';
let channelId = 0;
const hiddenTaskIds: number[] = [];

vi.mock('@hub/probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hub/probe')>();
  return {
    ...actual,
    probeAvailability: vi.fn(async () => ({
      success: true, model: 'test-model', protocol: 'openai_chat', httpStatus: 200,
      errorCode: null, errorMessage: null, latencyMs: 123, ttftMs: 50,
      inputTokens: 10, outputTokens: 20, tokensPerSec: 30, sample: 'ok', at: new Date().toISOString(),
    })),
    probeAuthenticity: vi.fn(async (): Promise<AuthenticityResult> => ({
      model: 'test-model', protocol: 'openai_chat', score: 88, verdict: 'genuine',
      checks: [], durationMs: 1500,
    })),
    listUpstreamModels: vi.fn(async (): Promise<UpstreamModelList> => ({
      ok: true, models: ['gpt-6-sol', 'unknown-model-xyz'], errorCode: null, errorMessage: null,
    })),
  };
});

const deps: TaskDeps = {
  db, maxAttempts: 3, timeoutMs: 5000, notifyEnabled: true,
};

beforeAll(async () => {
  // 1) 清理历史运行残留的本测试通知（notifications 不随 site 级联删除）
  await db.execute(sql`DELETE FROM notifications WHERE body LIKE '%worker-test%'`);
  // 2) 临时藏起预存 queued 任务，避免 FIFO 领到非本测试任务
  const pre = await db.execute<{ id: number }>(sql`
    SELECT id FROM probe_tasks WHERE status = 'queued'
  `);
  for (const r of pre) hiddenTaskIds.push(r.id);
  if (hiddenTaskIds.length > 0) {
    await db.execute(sql`
      UPDATE probe_tasks SET status = 'running', started_at = now()
      WHERE id IN (${sql.join(hiddenTaskIds.map((id) => sql`${id}`), sql`, `)})
    `);
  }
  // 3) 建测试站点/渠道/任务
  const site = await db.execute<{ id: number; owner_id: string }>(sql`
    INSERT INTO sites (owner_id, slug, name, homepage_url, status, recharge_ratio, created_at, updated_at)
    SELECT u.id, 'worker-test-tasks-site', 'worker-test-tasks-site', 'http://example.test/worker', 'approved', 1, now(), now()
    FROM users u ORDER BY u.created_at ASC LIMIT 1
    RETURNING id, owner_id::text AS owner_id
  `);
  siteId = site[0]!.id;
  ownerUuid = site[0]!.owner_id;
  const enc = encryptSecret('sk-test-worker');
  const ch = await db.execute<{ id: number }>(sql`
    INSERT INTO channels (site_id, name, base_url, api_key_enc, api_key_mask, protocol, primary_model,
      group_ratio, status, probe_enabled, probe_interval_sec, next_probe_at, created_at, updated_at)
    VALUES (${siteId}, 'worker-test-tasks-ch', 'http://127.0.0.1:59999/x', ${enc}, 'sk-****test',
      'openai_chat', 'gpt-6-sol', 1, 'active', true, 600, now(), now(), now())
    RETURNING id
  `);
  channelId = ch[0]!.id;
  await db.execute(sql`
    INSERT INTO probe_tasks (channel_id, kind, trigger, payload, status, requested_by)
    VALUES (${channelId}, 'availability', 'merchant', '{}'::jsonb, 'queued', ${ownerUuid}),
           (${channelId}, 'authenticity', 'merchant', '{}'::jsonb, 'queued', NULL),
           (${channelId}, 'discovery', 'onboarding', '{}'::jsonb, 'queued', NULL)
  `);
});

afterAll(async () => {
  // 恢复预存任务
  if (hiddenTaskIds.length > 0) {
    await db.execute(sql`
      UPDATE probe_tasks SET status = 'queued', started_at = NULL
      WHERE id IN (${sql.join(hiddenTaskIds.map((id) => sql`${id}`), sql`, `)})
    `);
  }
  if (siteId) await db.execute(sql`DELETE FROM sites WHERE id = ${siteId}`);
  await pg.end();
});

describe('任务队列（真库 + probe mock）', () => {
  it('FIFO 领取 availability 任务并执行：probe_runs 写入、done、task_done 通知', async () => {
    const t = await claimNextTask(db);
    expect(t, '应领到本测试插入的 availability 任务').not.toBeNull();
    expect(t!.channel_id).toBe(channelId);
    expect(t!.kind).toBe('availability');
    expect(t!.attempts).toBe(1);
    expect(t!.status).toBe('running');

    await runTaskToCompletion(deps, t!);
    const rows = await db.execute<{ status: string }>(sql`
      SELECT status FROM probe_tasks WHERE id = ${t!.id}
    `);
    expect(rows[0]!.status).toBe('done');
    const runs = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM probe_runs WHERE channel_id = ${channelId} AND kind = 'availability'
    `);
    expect(runs[0]!.n).toBeGreaterThanOrEqual(1);
    const notes = await db.execute<{ type: string }>(sql`
      SELECT type FROM notifications WHERE user_id = ${ownerUuid} AND type = 'task_done'
    `);
    expect(notes.length).toBe(1);
  });

  it('authenticity 任务：写 authenticity_reports + 回写 channel_models trust', async () => {
    const t = await claimNextTask(db);
    expect(t!.kind).toBe('authenticity');
    await runTaskToCompletion(deps, t!);
    const reports = await db.execute<{ score: number; verdict: string; task_id: string }>(sql`
      SELECT score, verdict, task_id FROM authenticity_reports WHERE channel_id = ${channelId}
    `);
    expect(reports.length).toBe(1);
    expect(reports[0]!.score).toBe(88);
    expect(reports[0]!.verdict).toBe('genuine');
    expect(Number(reports[0]!.task_id)).toBe(Number(t!.id));
    const cm = await db.execute<{ trust_score: number; trust_verdict: string }>(sql`
      SELECT trust_score, trust_verdict FROM channel_models
      WHERE channel_id = ${channelId} AND upstream_name = 'gpt-6-sol'
    `);
    expect(cm[0]!.trust_score).toBe(88);
    expect(cm[0]!.trust_verdict).toBe('genuine');
  });

  it('discovery 任务：upsert channel_models 并做目录匹配', async () => {
    const t = await claimNextTask(db);
    expect(t!.kind).toBe('discovery');
    await runTaskToCompletion(deps, t!);
    const models = await db.execute<{ upstream_name: string; model_id: number | null }>(sql`
      SELECT upstream_name, model_id FROM channel_models WHERE channel_id = ${channelId}
      ORDER BY upstream_name
    `);
    expect(models.length).toBe(2);
    const byName = new Map(models.map((m) => [m.upstream_name, m.model_id]));
    // gpt-6-sol 应匹配到目录模型
    expect(byName.get('gpt-6-sol')).not.toBeNull();
    // 未知名保留 null
    expect(byName.get('unknown-model-xyz')).toBeNull();
  });

  it('失败任务 attempts 已达上限 → failed + task_failed 通知', async () => {
    const { listUpstreamModels } = await import('@hub/probe');
    vi.mocked(listUpstreamModels).mockResolvedValueOnce({
      ok: false, models: [], errorCode: 'http_404', errorMessage: 'list not found',
    });
    const ins = await db.execute<{ id: number }>(sql`
      INSERT INTO probe_tasks (channel_id, kind, trigger, payload, status, requested_by, attempts)
      VALUES (${channelId}, 'discovery', 'merchant', '{}'::jsonb, 'queued', ${ownerUuid}, 2)
      RETURNING id
    `);
    const taskId = ins[0]!.id;
    const t = await claimNextTask(db);
    expect(t!.id).toBe(taskId);
    expect(t!.attempts).toBe(3);
    await runTaskToCompletion(deps, t!);
    const rows = await db.execute<{ status: string; error: string }>(sql`
      SELECT status, error FROM probe_tasks WHERE id = ${taskId}
    `);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.error).toContain('list not found');
    const notes = await db.execute<{ type: string }>(sql`
      SELECT type FROM notifications WHERE user_id = ${ownerUuid} AND type = 'task_failed'
    `);
    expect(notes.length).toBe(1);
  });
});
