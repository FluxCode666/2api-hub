/*
 * 程序化迁移：tsx src/migrate.ts
 * 读取根目录 .env 的 DATABASE_URL，执行 drizzle/ 下的迁移。
 * 复用 runMigrations（供 GLM-A 的 migrate/index.mjs 参考）。
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runMigrations } from './init';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');

await runMigrations(process.env.DATABASE_URL!, migrationsFolder);
console.log('[db] 迁移完成');
