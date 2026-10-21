/*
 * 探测执行器测试（真库 + probe mock）：
 * - 3 次失败后成功 → channel_recovered 通知
 * - 20 次连续失败 → status=invalid + channel_invalid 通知
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, encryptSecret } from '@hub/db';
import { executeProbe, type ProbeJob } from '../src/probes';
import type { ProbeResult } from '@hub/shared';

const { db, sql: pg } = createDb();
let siteId = 0;
let ownerUuid = '';
const channelIds: number[] = [];

vi.mock('@hub/probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hub/probe')>();
  return {
    ...actual,
    probeAvailability: vi.fn(),
  };
});

const { probeAvailability } = await import('@hub/probe');

function result(success: boolean): ProbeResult {
  return {
    success, model: 'test-model', protocol: 'openai_chat', httpStatus: success ? 200 : 503,
    errorCode: success ? null : 'http_5xx', errorMessage: success ? null : 'server error',
    latencyMs: success ? 100 : null, ttftMs: null, inputTokens: null, outputTokens: null,
    tokensPerSec: null, sample: null, at: new Date().toISOString(),
  };
}

function job(channelId: number): ProbeJob {
  return {
    channelId, siteId, ownerId: ownerUuid || null, channelName: 'worker-test-probe',
    baseUrl: 'http://127.0.0.1:59999/x', apiKey: 'sk-test', protocol: 'openai_chat',
    model: 'gpt-4o-mini', timeoutMs: 5000, trigger: 'schedule', channelModelId: null,
  };
}

beforeAll(async () => {
  // 清理历史运行残留的本测试通知（notifications 不随 site 级联删除）
  await db.execute(sql`DELETE FROM notifications WHERE body LIKE '%worker-test%' OR title LIKE '%worker-test%'`);
  const site = await db.execute<{ id: number; owner_id: string }>(sql`
    INSERT INTO sites (owner_id, slug, name, homepage_url, status, recharge_ratio, created_at, updated_at)
    SELECT u.id, 'worker-test-probe-site', 'worker-test-probe-site', 'http://example.test/worker', 'approved', 1, now(), now()
    FROM users u ORDER BY u.created_at ASC LIMIT 1
    RETURNING id, owner_id::text AS owner_id
  `);
  siteId = site[0]!.id;
  ownerUuid = site[0]!.owner_id;
  const enc = encryptSecret('sk-test-worker');
  for (let i = 0; i < 2; i++) {
    const ch = await db.execute<{ id: number }>(sql`
      INSERT INTO channels (site_id, name, base_url, api_key_enc, api_key_mask, protocol, primary_model,
        group_ratio, status, probe_enabled, probe_interval_sec, next_probe_at, created_at, updated_at)
      VALUES (${siteId}, ${'worker-test-probe-' + i}, 'http://127.0.0.1:59999/x', ${enc}, 'sk-****test',
        'openai_chat', 'gpt-4o-mini', 1, 'active', true, 600, now(), now(), now())
      RETURNING id
    `);
    channelIds.push(ch[0]!.id);
  }
});

afterAll(async () => {
  if (siteId) await db.execute(sql`DELETE FROM sites WHERE id = ${siteId}`);
  await pg.end();
});

describe('executeProbe 失败升级与恢复通知（真库）', () => {
  it('连续 3 次失败后恢复成功 → channel_recovered 通知', async () => {
    const ch = channelIds[0]!;
    // 3 次失败
    for (let i = 0; i < 3; i++) {
      vi.mocked(probeAvailability).mockResolvedValueOnce(result(false));
      await executeProbe(db, job(ch));
    }
    // 1 次成功
    vi.mocked(probeAvailability).mockResolvedValueOnce(result(true));
    await executeProbe(db, job(ch));

    const notes = await db.execute<{ type: string }>(sql`
      SELECT type FROM notifications WHERE user_id = ${ownerUuid} AND type = 'channel_recovered'
    `);
    expect(notes.length).toBe(1);
  });

  it('连续 20 次失败 → status=invalid + channel_invalid 通知', async () => {
    const ch = channelIds[1]!;
    for (let i = 0; i < 20; i++) {
      vi.mocked(probeAvailability).mockResolvedValueOnce(result(false));
      await executeProbe(db, job(ch));
    }
    const rows = await db.execute<{ status: string }>(sql`
      SELECT status FROM channels WHERE id = ${ch}
    `);
    expect(rows[0]!.status).toBe('invalid');
    const notes = await db.execute<{ type: string }>(sql`
      SELECT type FROM notifications WHERE user_id = ${ownerUuid} AND type = 'channel_invalid'
    `);
    expect(notes.length).toBe(1);
  });
});
