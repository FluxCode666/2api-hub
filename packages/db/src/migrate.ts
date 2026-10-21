/*
 * 程序化迁移：tsx src/migrate.ts
 * 读取根目录 .env 的 DATABASE_URL，执行 drizzle/ 下的迁移。
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');

const { db, sql } = createDb(process.env.DATABASE_URL, { max: 1 });
try {
  await migrate(db, { migrationsFolder });
  console.log('[db] 迁移完成');
} finally {
  await sql.end();
}
