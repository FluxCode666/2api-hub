/*
 * worker 配置与运行期状态。
 */
import { DEFAULT_SETTINGS } from '@hub/shared';
import type { SettingsMap } from '@hub/shared';
import type { Database } from '@hub/db';
import { settings as settingsTable } from '@hub/db';
import type { ScoringWeights } from '@hub/shared';

export interface WorkerConfig {
  databaseUrl?: string;
  healthPort: number;
  schedulerIntervalSec: number;   // 调度扫描周期
  aggregationIntervalSec: number; // 统计聚合周期
  retentionDays: number;          // probe_runs 保留天数
  recoveryTimeoutMs: number;      // running 任务回收阈值
  gracefulShutdownMs: number;     // 优雅退出等待上限
  taskMaxAttempts: number;
  flakyProbeIntervalSec: number;  // 连续失败 ≥3 次后的探测间隔
  minSamplesForScore: number;
}

export function loadConfig(): WorkerConfig {
  return {
    healthPort: Number(process.env.WORKER_HEALTH_PORT ?? 8713),
    schedulerIntervalSec: Number(process.env.WORKER_SCHEDULER_INTERVAL_SEC ?? 5),
    aggregationIntervalSec: Number(process.env.WORKER_AGGREGATION_INTERVAL_SEC ?? 60),
    retentionDays: Number(process.env.WORKER_RETENTION_DAYS ?? 30),
    recoveryTimeoutMs: Number(process.env.WORKER_RECOVERY_TIMEOUT_MS ?? 10 * 60 * 1000),
    gracefulShutdownMs: Number(process.env.WORKER_GRACEFUL_SHUTDOWN_MS ?? 30 * 1000),
    taskMaxAttempts: Number(process.env.WORKER_TASK_MAX_ATTEMPTS ?? 3),
    flakyProbeIntervalSec: Number(process.env.WORKER_FLAKY_PROBE_INTERVAL_SEC ?? 300),
    minSamplesForScore: 6,
  };
}

/** 读取 settings 表，缺省回退 DEFAULT_SETTINGS */
export async function loadSettings(db: Database): Promise<SettingsMap> {
  const rows = await db.select().from(settingsTable);
  // SAFETY: 与 api 侧 loadSettings 相同口径——库中值由管理接口按 SettingsMap 类型写入，
  // 未写入的 key 用 DEFAULT_SETTINGS 兜底，类型由调用方按 SettingsMap 约定信任
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) merged[r.key] = r.value;
  // SAFETY: 与 api 侧 loadSettings 同口径——settings.value 由管理接口按 SettingsMap 类型写入 jsonb，
  // 未写入的 key 用 DEFAULT_SETTINGS 兜底，因此最终对象满足 SettingsMap 契约
  return merged as unknown as SettingsMap;
}

export function scoringWeights(s: SettingsMap): ScoringWeights {
  const w = s['scoring.weights'];
  if (!w || typeof w !== 'object') return DEFAULT_SETTINGS['scoring.weights'];
  const { uptime, latency, trust, stability } = w as ScoringWeights;
  if (![uptime, latency, trust, stability].every((v) => typeof v === 'number' && v >= 0)) {
    return DEFAULT_SETTINGS['scoring.weights'];
  }
  return { uptime, latency, trust, stability };
}

// ---------- 运行期指标（/metrics 用） ----------
export interface WorkerMetrics {
  lastAggregateMs: number | null;
  lastAggregateAt: number | null;
  aggregatesRun: number;
  probesStarted: number;
  probesFinished: number;
  tasksDone: number;
  tasksFailed: number;
  inFlight: number;
  lastQueueBacklog: { queued: number; running: number } | null;
  startedAt: number;
}

export function newMetrics(): WorkerMetrics {
  return {
    lastAggregateMs: null,
    lastAggregateAt: null,
    aggregatesRun: 0,
    probesStarted: 0,
    probesFinished: 0,
    tasksDone: 0,
    tasksFailed: 0,
    inFlight: 0,
    lastQueueBacklog: null,
    startedAt: Date.now(),
  };
}
