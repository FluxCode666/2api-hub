/*
 * initDatabase / runMigrations 测试（hub_test 独立库）。
 * 运行前：CREATE DATABASE hub_test; DATABASE_URL=postgres://hub:hub@127.0.0.1:54329/hub_test tsx src/migrate.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createDb } from './client';
import { initDatabase } from './init';
import { models, settings, users, vendors } from './schema';
import { DEFAULT_SETTINGS, SEED_MODELS, SEED_VENDORS } from '@hub/shared';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });
const TEST_URL = (process.env.DATABASE_URL ?? '').replace(/\/hub$/, '/hub_test');

const { db, sql: pg } = createDb(TEST_URL, { max: 2 });

beforeAll(async () => {
  // 清库（只清 init 涉及的表）
  await db.execute(sql`TRUNCATE users, vendors, models, settings RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await pg.end();
});

describe('initDatabase（RELEASE.md §2.3）', () => {
  it('空库首次初始化：写目录 + 补 settings + 创建管理员', async () => {
    const r = await initDatabase(db, { adminEmail: 'init@t.dev', adminPassword: 'init-password-123' });
    expect(r.catalogSeeded).toBe(true);
    expect(r.settingsAdded.length).toBe(Object.keys(DEFAULT_SETTINGS).length);
    expect(r.adminCreated).toBe(true);

    const vCount = (await db.select({ c: sql<number>`count(*)::int` }).from(vendors))[0]!.c;
    const mCount = (await db.select({ c: sql<number>`count(*)::int` }).from(models))[0]!.c;
    expect(vCount).toBe(SEED_VENDORS.length);
    expect(mCount).toBe(SEED_MODELS.length);

    const admin = await db.select().from(users).where(sql`role = 'admin'`);
    expect(admin.length).toBe(1);
    expect(admin[0]!.email).toBe('init@t.dev');
  });

  it('幂等：重复执行不写重复数据', async () => {
    const r = await initDatabase(db, { adminEmail: 'init2@t.dev', adminPassword: 'init-password-456' });
    expect(r.catalogSeeded).toBe(false); // 目录已有
    expect(r.settingsAdded.length).toBe(0); // settings 已全
    expect(r.adminCreated).toBe(false); // 已有 admin

    const vCount = (await db.select({ c: sql<number>`count(*)::int` }).from(vendors))[0]!.c;
    expect(vCount).toBe(SEED_VENDORS.length);
    const adminCount = (await db.select({ c: sql<number>`count(*)::int` }).from(users).where(sql`role = 'admin'`))[0]!.c;
    expect(adminCount).toBe(1); // 不重复创建
  });

  it('不覆盖已有 settings 值', async () => {
    await db.update(settings).set({ value: 999 }).where(sql`key = 'probe.concurrency'`);
    const r = await initDatabase(db, {});
    expect(r.settingsAdded.length).toBe(0);
    const row = await db.select().from(settings).where(sql`key = 'probe.concurrency'`);
    expect(row[0]!.value).toBe(999); // 未被覆盖
  });

  it('密码不足 12 位不创建管理员', async () => {
    await db.execute(sql`DELETE FROM users`);
    const r = await initDatabase(db, { adminEmail: 'weak@t.dev', adminPassword: 'short' });
    expect(r.adminCreated).toBe(false);
    const uCount = (await db.select({ c: sql<number>`count(*)::int` }).from(users))[0]!.c;
    expect(uCount).toBe(0);
  });

  it('不提供管理员变量时不创建（已有目录/settings 不受影响）', async () => {
    const r = await initDatabase(db, {});
    expect(r.adminCreated).toBe(false);
    expect(r.catalogSeeded).toBe(false); // 上次已写
  });
});
