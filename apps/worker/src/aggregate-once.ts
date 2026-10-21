/*
 * aggregate:once —— 只执行一次全量聚合后退出（验证脚本）。
 */
import { createDb } from '@hub/db';
import { loadConfig, loadSettings, scoringWeights } from './config';
import { runAggregation } from './aggregate';

const config = loadConfig();
const { db, sql } = createDb(config.databaseUrl ?? process.env.DATABASE_URL);
try {
  const settings = await loadSettings(db);
  const result = await runAggregation(db, {
    weights: scoringWeights(settings),
    minSamplesForScore: config.minSamplesForScore,
  });
  console.log(`[aggregate:once] channel_stats=${result.channelStats} site_stats=${result.siteStats} duration=${result.durationMs}ms`);
} finally {
  await sql.end();
}
