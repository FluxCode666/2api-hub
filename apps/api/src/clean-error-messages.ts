/*
 * 一次性清理：把 probe_runs.error_message 中出现的各渠道真实 Key 替换为 ***。
 * 用法：pnpm --filter @hub/api exec tsx src/clean-error-messages.ts（幂等，可重复执行）
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createDb, channels, decryptSecret } from '@hub/db';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (m) => '\\' + m);
}

const { db, sql: pg } = createDb(process.env.DATABASE_URL, { max: 2 });

try {
  const chs = await db.select({ id: channels.id, apiKeyEnc: channels.apiKeyEnc }).from(channels);
  let totalUpdated = 0;
  for (const c of chs) {
    let plain: string;
    try {
      plain = decryptSecret(c.apiKeyEnc);
    } catch {
      console.warn(`[clean] 渠道 ${c.id} Key 解密失败，跳过`);
      continue;
    }
    if (!plain || plain.length < 4) continue;
    // 用参数化 replace 精确替换（含 URL 编码变体）
    for (const v of [plain, encodeURIComponent(plain)]) {
      const res = await db.execute(sql`
        UPDATE probe_runs SET error_message = replace(error_message, ${v}, '***')
        WHERE channel_id = ${c.id} AND error_message IS NOT NULL
          AND error_message LIKE ${'%' + escapeLike(v) + '%'}`);
      // SAFETY: postgres.js 返回的 Result 带 count 字段（影响的行数）
      totalUpdated += (res as unknown as { count?: number }).count ?? 0;
    }
  }
  console.log(`[clean] 完成，共更新 ${totalUpdated} 行`);
} finally {
  await pg.end();
}
