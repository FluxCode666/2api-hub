/*
 * 首次初始化与迁移的公共入口（RELEASE.md §2.3）。
 * GLM-A 的 migrate/index.mjs 会调用这两个函数。
 * 幂等；绝不写演示数据（演示数据只在 pnpm db:seed）。
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { count, eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { DEFAULT_SETTINGS, SEED_MODELS, SEED_VENDORS } from '@hub/shared';
import { createDb, type Database } from './client';
import { models, settings, users, vendors } from './schema';

/** 执行 drizzle 迁移（幂等） */
export async function runMigrations(databaseUrl: string, migrationsFolder: string): Promise<void> {
  const { db, sql } = createDb(databaseUrl, { max: 1 });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await sql.end();
  }
}

export interface InitResult {
  catalogSeeded: boolean;    // vendors 为空时写入了目录
  settingsAdded: string[];   // 补写的 settings key
  adminCreated: boolean;     // 创建了管理员
}

/**
 * 首次初始化（幂等）：
 * 1. vendors 为空 → 写入 SEED_VENDORS / SEED_MODELS
 * 2. settings 缺失的 key → 补写 DEFAULT_SETTINGS（不覆盖已有值）
 * 3. 没有任何 admin 且提供了 INIT_ADMIN_EMAIL + INIT_ADMIN_PASSWORD（≥12 位）→ 创建管理员
 */
export async function initDatabase(
  db: Database,
  opts: { adminEmail?: string; adminPassword?: string } = {},
): Promise<InitResult> {
  const result: InitResult = { catalogSeeded: false, settingsAdded: [], adminCreated: false };

  // 1. 目录（厂商 + 模型）
  const vendorCount = (await db.select({ c: count() }).from(vendors))[0]?.c ?? 0;
  if (vendorCount === 0) {
    const vendorRows = await db.insert(vendors).values(
      SEED_VENDORS.map((v) => ({
        slug: v.slug, name: v.name, nameZh: v.nameZh, color: v.color,
        website: v.website, sortOrder: v.sortOrder,
      })),
    ).returning();
    const vendorIdBySlug = new Map(vendorRows.map((v) => [v.slug, v.id]));
    await db.insert(models).values(
      SEED_MODELS.map((m) => ({
        slug: m.slug,
        displayName: m.displayName,
        vendorId: vendorIdBySlug.get(m.vendor)!,
        family: m.family,
        modality: m.modality,
        tier: m.tier,
        aliases: m.aliases,
        defaultProtocol: m.defaultProtocol,
        officialInputPrice: m.input,
        officialOutputPrice: m.output,
        contextWindow: m.contextWindow,
        knowledgeCutoff: m.knowledgeCutoff,
        expectedTps: m.expectedTps,
        isFeatured: m.featured,
      })),
    );
    result.catalogSeeded = true;
  }

  // 2. settings（只补缺失）
  const existing = await db.select({ key: settings.key }).from(settings);
  const existingKeys = new Set(existing.map((r) => r.key));
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (!existingKeys.has(key)) {
      // SAFETY: DEFAULT_SETTINGS 的 value 类型与 settings.value 的 jsonb 一致
      await db.insert(settings).values({ key, value: value as unknown as never });
      result.settingsAdded.push(key);
    }
  }

  // 3. 管理员（没有 admin 且提供了 ≥12 位密码才创建）
  const adminCount = (await db.select({ c: count() }).from(users).where(eq(users.role, 'admin')))[0]?.c ?? 0;
  if (adminCount === 0 && opts.adminEmail && opts.adminPassword && opts.adminPassword.length >= 12) {
    await db.insert(users).values({
      email: opts.adminEmail.toLowerCase().trim(),
      passwordHash: bcrypt.hashSync(opts.adminPassword, 10),
      nickname: '平台管理员',
      role: 'admin',
    });
    result.adminCreated = true;
  }

  return result;
}
