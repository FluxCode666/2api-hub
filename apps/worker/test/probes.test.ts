/*
 * 探测执行器测试（hub_test 隔离库 + probe mock）：
 * - 3 次失败后成功 → channel_recovered 通知
 * - 20 次连续失败 → status=invalid + channel_invalid 通知
 * - #1：error_message 写库前按真实 Key 精确替换（短 Key 也替换）
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, encryptSecret } from '@hub/db';
import { executeProbe, scrubKey, type ProbeJob } from '../src/probes';
import type { ProbeResult } from '@hub/shared';

const { db, sql: pg } = createDb(process.env.DATABASE_URL);
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

function result(success: boolean, errorMessage: string | null = null): ProbeResult {
  return {
    success, model: 'gpt-6-sol', protocol: 'openai_chat', httpStatus: success ? 200 : 503,
    errorCode: success ? null : 'http_5xx', errorMessage,
    latencyMs: success ? 100 : null, ttftMs: null, inputTokens: null, outputTokens: null,
    tokensPerSec: null, sample: null, at: new Date().toISOString(),
  };
}

function job(channelId: number, apiKey = 'sk-w-probe'): ProbeJob {
  return {
    channelId, siteId, ownerId: ownerUuid || null, channelName: 'w-probe-ch',
    baseUrl: 'http://127.0.0.1:59999/x', apiKey, protocol: 'openai_chat',
    model: 'gpt-6-sol', backupModel: null, timeoutMs: 5000, trigger: 'schedule', channelModelId: null,
  };
}

beforeAll(async () => {
  const site = await db.execute<{ id: number; owner_id: string }>(sql`
    INSERT INTO sites (owner_id, slug, name, homepage_url, status, recharge_ratio, created_at, updated_at)
    SELECT u.id, 'w-probe-site', 'w-probe-site', 'http://example.test/w', 'approved', 1, now(), now()
    FROM users u ORDER BY u.created_at ASC LIMIT 1
    RETURNING id, owner_id::text AS owner_id
  `);
  siteId = site[0]!.id;
  ownerUuid = site[0]!.owner_id;
  const enc = encryptSecret('sk-w-probe');
  for (let i = 0; i < 2; i++) {
    const ch = await db.execute<{ id: number }>(sql`
      INSERT INTO channels (site_id, name, base_url, api_key_enc, api_key_mask, protocol, primary_model,
        group_ratio, status, probe_enabled, probe_interval_sec, next_probe_at, created_at, updated_at)
      VALUES (${siteId}, ${'w-probe-ch-' + i}, 'http://127.0.0.1:59999/x', ${enc}, 'sk-****probe',
        'openai_chat', 'gpt-6-sol', 1, 'active', true, 600, now(), now(), now())
      RETURNING id
    `);
    channelIds.push(ch[0]!.id);
  }
});

afterAll(async () => {
  if (siteId) await db.execute(sql`DELETE FROM sites WHERE id = ${siteId}`);
  await pg.end();
});

describe('scrubKey（审查 #1 纯函数）', () => {
  it('任意长度 Key 精确替换（含短 Key、多次出现）', () => {
    expect(scrubKey('custom key abc rejected', 'abc')).toBe('custom key *** rejected');
    expect(scrubKey('sk-abc sk-abc', 'sk-abc')).toBe('*** ***');
    expect(scrubKey('无匹配文本', 'zzz')).toBe('无匹配文本');
    expect(scrubKey(null, 'zzz')).toBeNull();
    expect(scrubKey('text', null)).toBe('text');
  });
});

describe('executeProbe（真库 + mock）', () => {
  it('error_message 写库前按真实 Key 精确替换（短 Key 也替换，审查 #1）', async () => {
    const ch = channelIds[0]!;
    vi.mocked(probeAvailability).mockResolvedValueOnce(result(false, 'rejected custom key xyz12'));
    await executeProbe(db, job(ch, 'xyz12'));
    const rows = await db.execute<{ error_message: string | null }>(sql`
      SELECT error_message FROM probe_runs
      WHERE channel_id = ${ch} AND kind = 'availability' ORDER BY created_at DESC LIMIT 1
    `);
    expect(rows[0]!.error_message).not.toContain('xyz12');
    expect(rows[0]!.error_message).toContain('***');
  });

  it('连续 3 次失败后恢复成功 → channel_recovered 通知', async () => {
    const ch = channelIds[0]!;
    await db.execute(sql`DELETE FROM notifications WHERE user_id = ${ownerUuid}`);
    for (let i = 0; i < 3; i++) {
      vi.mocked(probeAvailability).mockResolvedValueOnce(result(false, 'err'));
      await executeProbe(db, job(ch));
    }
    vi.mocked(probeAvailability).mockResolvedValueOnce(result(true));
    await executeProbe(db, job(ch));
    const notes = await db.execute<{ type: string }>(sql`
      SELECT type FROM notifications WHERE user_id = ${ownerUuid} AND type = 'channel_recovered'
    `);
    expect(notes.length).toBe(1);
  });

  it('连续 20 次失败 → status=invalid + channel_invalid 通知', async () => {
    const ch = channelIds[1]!;
    await db.execute(sql`DELETE FROM notifications WHERE user_id = ${ownerUuid}`);
    for (let i = 0; i < 20; i++) {
      vi.mocked(probeAvailability).mockResolvedValueOnce(result(false, 'err'));
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
