import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = ReturnType<typeof createDb>['db'];

export function createDb(url = process.env.DATABASE_URL, opts: { max?: number } = {}) {
  if (!url) throw new Error('DATABASE_URL 未配置');
  const sql = postgres(url, { max: opts.max ?? 10 });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
