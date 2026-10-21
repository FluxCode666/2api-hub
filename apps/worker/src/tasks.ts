/*
 * 任务队列执行器（SPEC §4.3）：probe_tasks 的 queued → running → done/failed。
 * - availability：单次探测（走与定时探测相同的 probe_runs 落库 + 失败升级逻辑）
 * - authenticity：对 payload.models（空则主测模型）逐个 probeAuthenticity，
 *   写 authenticity_reports + 回写 channel_models trust 字段
 * - discovery：listUpstreamModels + matchCatalogModel upsert channel_models
 * 完成后给请求者发 task_done 通知；running 超 10 分钟回收（attempts ≥3 → failed）。
 */
import { sql } from 'drizzle-orm';
import {
  probeAuthenticity,
  listUpstreamModels,
  matchCatalogModel,
} from '@hub/probe';
import type { CatalogHint, UpstreamModelList } from '@hub/probe';
import type { ChannelProtocol, ProbeTrigger } from '@hub/shared';
import type { Database } from '@hub/db';
import { decryptSecret } from '@hub/db';
import { insertNotification } from './notify';
import type { ProbeJob } from './probes';
import { executeProbe } from './probes';

export interface TaskDeps {
  db: Database;
  maxAttempts: number;
  timeoutMs: number;
  notifyEnabled: boolean; // 测试时关掉通知断言用
}

interface TaskRow extends Record<string, unknown> {
  id: number;
  channel_id: number;
  site_id: number;
  owner_id: string | null;
  channel_name: string;
  base_url: string;
  api_key_enc: string;
  protocol: ChannelProtocol;
  primary_model: string;
  kind: 'availability' | 'authenticity' | 'discovery';
  trigger: ProbeTrigger;
  payload: { models?: string[] };
  status: string;
  requested_by: string | null;
  attempts: number;
}

/** 原子领取：UPDATE ... WHERE status='queued' RETURNING（多实例安全） */
export async function claimNextTask(db: Database): Promise<TaskRow | null> {
  const rows = await db.execute<TaskRow>(sql`
    UPDATE probe_tasks t SET status = 'running', started_at = now(), attempts = attempts + 1
    WHERE t.id IN (
      SELECT id FROM probe_tasks WHERE status = 'queued'
      ORDER BY created_at ASC LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING t.id, t.channel_id, t.kind, t.trigger, t.payload, t.status, t.requested_by::text AS requested_by, t.attempts
  `);
  if (rows.length === 0) return null;
  const claimed = rows[0];
  if (!claimed) return null;
  // 补齐执行所需的渠道上下文
  const ctx = await db.execute<TaskRow>(sql`
    SELECT c.site_id, s.owner_id::text AS owner_id, c.name AS channel_name, c.base_url, c.api_key_enc,
      c.protocol, c.primary_model
    FROM channels c JOIN sites s ON s.id = c.site_id
    WHERE c.id = ${claimed.channel_id}
  `);
  return { ...claimed, ...(ctx[0] ?? {}) };
}

/** 回收超时 running 任务（默认 10 分钟）；排除 excludeIds（本进程刚领取的） */
export async function reclaimStaleTasks(db: Database, olderThanMs: number, excludeIds: Set<number>): Promise<void> {
  const stale = await db.execute<{ id: number; attempts: number; requested_by: string | null }>(sql`
    UPDATE probe_tasks SET status = 'queued', started_at = NULL
    WHERE status = 'running' AND started_at < now() - make_interval(secs => ${Math.round(olderThanMs / 1000)})
    RETURNING id, attempts, requested_by
  `);
  for (const t of stale) {
    excludeIds.add(t.id);
  }
}

/** running 超 10 分钟且回收后 attempts ≥ maxAttempts → failed + 通知 */
export async function failExhaustedTasks(deps: TaskDeps): Promise<void> {
  const rows = await deps.db.execute<{ id: number; attempts: number; requested_by: string | null; channel_name: string }>(sql`
    UPDATE probe_tasks t SET status = 'failed', finished_at = now(),
      error = '尝试次数已达上限'
    WHERE t.status = 'queued' AND t.attempts >= ${deps.maxAttempts}
    RETURNING t.id, t.attempts, t.requested_by::text AS requested_by
  `);
  for (const t of rows) {
    if (deps.notifyEnabled && t.requested_by) {
      await insertNotification(deps.db, t.requested_by, 'task_failed',
        '探测任务失败', `任务 #${t.id} 已重试 ${t.attempts} 次仍未成功，已标记为失败。`);
    }
  }
}

/** 执行一个任务到终态（异常时 requeue 或 failed） */
export async function runTaskToCompletion(deps: TaskDeps, task: TaskRow): Promise<void> {
  try {
    const result = await executeByKind(deps, task);
    await deps.db.execute(sql`
      UPDATE probe_tasks SET status = 'done', finished_at = now(), result = ${JSON.stringify(result)}::jsonb
      WHERE id = ${task.id}
    `);
    if (deps.notifyEnabled && task.requested_by) {
      await insertNotification(deps.db, task.requested_by, 'task_done',
        '探测任务完成', `渠道「${task.channel_name}」的${kindLabel(task.kind)}任务已完成。`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = task.attempts; // claim 时已 +1
    if (attempts >= deps.maxAttempts) {
      await deps.db.execute(sql`
        UPDATE probe_tasks SET status = 'failed', finished_at = now(), error = ${message}
        WHERE id = ${task.id}
      `);
      if (deps.notifyEnabled && task.requested_by) {
        await insertNotification(deps.db, task.requested_by, 'task_failed',
          '探测任务失败', `渠道「${task.channel_name}」的${kindLabel(task.kind)}任务失败：${message}`);
      }
    } else {
      await deps.db.execute(sql`
        UPDATE probe_tasks SET status = 'queued', started_at = NULL, error = ${message}
        WHERE id = ${task.id}
      `);
    }
  }
}

function kindLabel(kind: string): string {
  if (kind === 'authenticity') return '真伪检测';
  if (kind === 'discovery') return '模型发现';
  return '可用性探测';
}

async function executeByKind(deps: TaskDeps, task: TaskRow): Promise<unknown> {
  const target = {
    baseUrl: task.base_url,
    apiKey: decryptSecret(task.api_key_enc),
    // SAFETY: channels.protocol 列是 channel_protocol 枚举（openai_chat/openai_responses/anthropic/gemini），
    // 与 shared 的 ChannelProtocol 成员完全一致
    protocol: task.protocol as ChannelProtocol,
    model: task.primary_model,
  };
  if (task.kind === 'availability') {
    const job: ProbeJob = {
      channelId: task.channel_id,
      siteId: task.site_id,
      ownerId: task.owner_id,
      channelName: task.channel_name,
      baseUrl: task.base_url,
      apiKey: decryptSecret(task.api_key_enc),
      protocol: target.protocol,
      model: task.primary_model,
      timeoutMs: deps.timeoutMs,
      trigger: task.trigger,
      channelModelId: null,
    };
    const outcome = await executeProbe(deps.db, job);
    return outcome.result;
  }
  if (task.kind === 'authenticity') {
    return runAuthenticity(deps, task, target);
  }
  return runDiscovery(deps, task, target);
}

/** 真伪检测：对 models 列表（空则主测模型）逐个检测 */
async function runAuthenticity(
  deps: TaskDeps,
  task: TaskRow,
  target: { baseUrl: string; apiKey: string; protocol: ChannelProtocol; model: string },
): Promise<{ reports: number }> {
  const models = task.payload?.models?.length ? task.payload.models : [task.primary_model];
  const catalog = await loadCatalogHints(deps.db);
  let count = 0;
  for (const model of models) {
    const hint = catalog.find((h) => h.slug && models.includes(h.slug)) ?? null;
    const result = await probeAuthenticity({ ...target, model }, hint, { timeoutMs: deps.timeoutMs });
    await deps.db.execute(sql`
      INSERT INTO authenticity_reports (channel_id, task_id, model, protocol, score, verdict, checks, duration_ms, trigger, created_at)
      VALUES (${task.channel_id}, ${task.id}, ${model}, ${target.protocol}, ${result.score}, ${result.verdict},
        ${JSON.stringify(result.checks)}::jsonb, ${result.durationMs}, ${task.trigger}, now())
    `);
    // 回写 channel_models trust 字段（该渠道此模型行不存在则插入）
    await deps.db.execute(sql`
      INSERT INTO channel_models (channel_id, upstream_name, trust_score, trust_verdict, trust_checked_at)
      VALUES (${task.channel_id}, ${model}, ${result.score}, ${result.verdict}, now())
      ON CONFLICT (channel_id, upstream_name) DO UPDATE SET
        trust_score = EXCLUDED.trust_score, trust_verdict = EXCLUDED.trust_verdict,
        trust_checked_at = EXCLUDED.trust_checked_at
    `);
    count += 1;
  }
  return { reports: count };
}

/** 模型发现：listUpstreamModels + matchCatalogModel upsert channel_models */
async function runDiscovery(
  deps: TaskDeps,
  task: TaskRow,
  target: { baseUrl: string; apiKey: string; protocol: ChannelProtocol },
): Promise<unknown> {
  const list: UpstreamModelList = await listUpstreamModels(
    { baseUrl: target.baseUrl, apiKey: target.apiKey, protocol: target.protocol },
    { timeoutMs: deps.timeoutMs },
  );
  if (!list.ok) {
    throw new Error(list.errorMessage ?? list.errorCode ?? 'listUpstreamModels failed');
  }
  const catalog = await loadCatalogForMatch(deps.db);
  let matched = 0;
  for (const upstreamName of list.models) {
    const modelId = matchCatalogModel(upstreamName, catalog);
    if (modelId !== null) matched += 1;
    // model_id 用 COALESCE：保留已有映射，避免 discovery 抹掉人工映射
    await deps.db.execute(sql`
      INSERT INTO channel_models (channel_id, upstream_name, model_id)
      VALUES (${task.channel_id}, ${upstreamName}, ${modelId})
      ON CONFLICT (channel_id, upstream_name) DO UPDATE SET
        model_id = COALESCE(EXCLUDED.model_id, channel_models.model_id)
    `);
  }
  return { total: list.models.length, matched };
}

/** 目录提示（authenticity 用） */
async function loadCatalogHints(db: Database): Promise<CatalogHint[]> {
  const rows = await db.execute<CatalogRow>(sql`
    SELECT m.slug, v.slug AS vendor_slug, m.tier, m.knowledge_cutoff, m.expected_tps
    FROM models m JOIN vendors v ON v.id = m.vendor_id
  `);
  return rows.map((r) => ({
    slug: r.slug,
    vendorSlug: r.vendor_slug,
    // SAFETY: models.tier 列是 model_tier 枚举，成员与 shared 的 ModelTier 一致
    tier: r.tier as CatalogHint['tier'],
    knowledgeCutoff: r.knowledge_cutoff,
    expectedTps: r.expected_tps,
  }));
}

interface CatalogRow extends Record<string, unknown> {
  slug: string;
  vendor_slug: string;
  tier: string;
  knowledge_cutoff: string | null;
  expected_tps: number | null;
}

/** 目录匹配表（discovery 用） */
async function loadCatalogForMatch(db: Database): Promise<{ id: number; slug: string; aliases: string[] }[]> {
  const rows = await db.execute<CatalogMatchRow>(sql`
    SELECT id, slug, aliases FROM models
  `);
  return rows.map((r) => ({ id: r.id, slug: r.slug, aliases: r.aliases ?? [] }));
}

interface CatalogMatchRow extends Record<string, unknown> {
  id: number;
  slug: string;
  aliases: string[] | null;
}
