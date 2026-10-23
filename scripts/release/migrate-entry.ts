/*
 * 迁移入口（发布包 migrate/index.mjs 的源码）：
 * 调用 @hub/db 的 runMigrations + initDatabase（RELEASE.md §2.3）。
 * 幂等；绝不写演示数据。
 *
 * 环境变量：
 *   DATABASE_URL        （必填）
 *   INIT_ADMIN_EMAIL     可选；无 admin 时创建管理员
 *   INIT_ADMIN_PASSWORD 可选；≥12 位
 */
import { runMigrations, initDatabase } from '../../packages/db/src/init.js';
import { createDb } from '../../packages/db/src/client.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[migrate] 缺少 DATABASE_URL');
  process.exit(1);
}

const migrationsFolder = new URL('../drizzle/', import.meta.url).pathname;

console.log('[migrate] 执行数据库迁移…');
await runMigrations(databaseUrl, migrationsFolder);

const { db, sql } = createDb(databaseUrl, { max: 2 });
try {
  const result = await initDatabase(db, {
    adminEmail: process.env.INIT_ADMIN_EMAIL,
    adminPassword: process.env.INIT_ADMIN_PASSWORD,
  });
  console.log('[migrate] 初始化完成:', JSON.stringify(result));
} finally {
  await sql.end();
}
console.log('[migrate] 完成');
