/*
 * 任务队列执行器（SPEC §4.3）：probe_tasks 的 queued → running → done/failed。
 * 任务 lease（审查 P1 #3）：
 * - 领取时生成新 lease_token + 记录 locked_by（本实例 id）+ heartbeat_at
 * - 执行中每 30s 心跳续租；回收只处理 heartbeat_at 超过恢复阈值的任务
 * - 完成、失败、写报告、发通知等副作用全部带 WHERE id=$1 AND lease_token=$2 校验，
 *   校验失败（lease 已易主）放弃写入，防止旧执行者覆盖新执行者
 * - attempts 上限检查放进原子领取语句（不再单独 failExhaustedTasks）
 * kind：
 * - availability：单次探测（probe_runs 落库 + channel_models 回写 + 失败升级逻辑）
 * - authenticity：payload.models（空则主测模型）逐个 probeAuthenticity，
 *   hint 按当前 model 用 matchCatalogModel 匹配（审查 #10）
 * - discovery：listUpstreamModels + matchCatalogModel upsert channel_models
 * 审查 #1：任务 error、通知正文、authenticity 样本写库前用渠道真实 Key 精确替换兜底。
 */
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
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
import { executeProbe, scrubKey } from './probes';

export interface TaskDeps {
  db: Database;
  /** 本 worker 实例 id（lease 持有者标识） */
  workerId: string;
  maxAttempts: number;
  timeoutMs: number;
  notifyEnabled: boolean;
}

export interface ClaimedTask {
  id: number;
  leaseToken: string;
  channelId: number;
  siteId: number;
  ownerId: string | null;
  channelName: string;
  baseUrl: string;
  apiKeyEnc: string;
  apiKey: string; // 解密后（副作用脱敏用）
  protocol: ChannelProtocol;
  primaryModel: string;
  kind: 'availability' | 'authenticity' | 'discovery';
  trigger: ProbeTrigger;
  payload: { models?: string[] };
  requestedBy: string | null;
  attempts: number;
}

interface TaskRow extends Record<string, unknown> {
  id: number;
  channel_id: number;
  kind: 'availability' | 'authenticity' | 'discovery';
  trigger: ProbeTrigger;
  payload: { models?: string[] };
  requested_by: string | null;
  attempts: number;
  site_id: number;
  owner_id: string | null;
  channel_name: string;
  base_url: string;
  api_key_enc: string;
  protocol: ChannelProtocol;
  primary_model: string;
}

/**
 * 原子领取下一个任务（多实例安全）：
 * - FIFO（created_at ASC），FOR UPDATE SKIP LOCKED
 * - attempts 上限检查放进领取谓词（审查 #3）：attempts+1 > maxAttempts 的任务直接标 failed
 *   并跳过，不进入执行
 * - 领取即写 lease（locked_by / lease_token / heartbeat_at）
 */
export async function claimNextTask(
  db: Database,
  workerId: string,
  maxAttempts: number,
): Promise<ClaimedTask | null> {
  const leaseToken = randomUUID();
  // 先把超限任务标 failed（原子，只处理 queued）
  await db.execute(sql`
    UPDATE probe_tasks t SET status = 'failed', finished_at = now(), error = '尝试次数已达上限'
    WHERE t.id IN (
      SELECT id FROM probe_tasks WHERE status = 'queued' AND attempts >= ${maxAttempts}
      FOR UPDATE SKIP LOCKED
    )
  `);
  const rows = await db.execute<TaskRow>(sql`
    UPDATE probe_tasks t SET status = 'running', started_at = now(), attempts = attempts + 1,
      locked_by = ${workerId}, lease_token = ${leaseToken}, heartbeat_at = now()
    WHERE t.id IN (
      SELECT id FROM probe_tasks WHERE status = 'queued'
      ORDER BY created_at ASC LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING t.id, t.channel_id, t.kind, t.trigger, t.payload,
      t.requested_by::text AS requested_by, t.attempts
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
  const row = { ...claimed, ...(ctx[0] ?? {}) } as TaskRow;
  return {
    id: row.id,
    leaseToken,
    channelId: row.channel_id,
    siteId: row.site_id,
    ownerId: row.owner_id,
    channelName: row.channel_name,
    baseUrl: row.base_url,
    apiKeyEnc: row.api_key_enc,
    apiKey: decryptSecret(row.api_key_enc),
    // SAFETY: channels.protocol 列是 channel_protocol 枚举（4 值），与 ChannelProtocol 成员一致
    protocol: row.protocol,
    primaryModel: row.primary_model,
    kind: row.kind,
    trigger: row.trigger,
    payload: row.payload ?? {},
    requestedBy: row.requested_by,
    attempts: row.attempts,
  };
}

/** 心跳续租：lease 仍在手才续；返回 false 表示任务已被回收/易主，应停止执行 */
export async function heartbeatTask(db: Database, task: ClaimedTask): Promise<boolean> {
  const rows = await db.execute<{ id: number }>(sql`
    UPDATE probe_tasks SET heartbeat_at = now()
    WHERE id = ${task.id} AND lease_token = ${task.leaseToken} AND status = 'running'
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * 回收心跳过期的 running 任务（审查 #3）：
 * 只处理 heartbeat_at < now() - recoveryTimeout 的任务（执行者已死或卡死），
 * requeue（清 lease）后 attempts 若达上限由下一轮 claim 的超限检查标 failed。
 */
export async function reclaimStaleTasks(db: Database, olderThanMs: number): Promise<void> {
  await db.execute(sql`
    UPDATE probe_tasks SET status = 'queued', started_at = NULL,
      locked_by = NULL, lease_token = NULL, heartbeat_at = NULL
    WHERE status = 'running'
      AND heartbeat_at < now() - make_interval(secs => ${Math.round(olderThanMs / 1000)})
  `);
}

/** 优雅退出：归还本实例持有的 running 任务（审查 #3：只动自己的，不动别人的） */
export async function releaseMyTasks(db: Database, workerId: string): Promise<void> {
  await db.execute(sql`
    UPDATE probe_tasks SET status = 'queued', started_at = NULL,
      locked_by = NULL, lease_token = NULL, heartbeat_at = NULL
    WHERE status = 'running' AND locked_by = ${workerId}
  `);
}

/** lease 校验的任务终态写入：校验失败（lease 易主）返回 false，放弃写入 */
async function completeWithLease(
  db: Database,
  task: ClaimedTask,
  status: 'done' | 'failed' | 'queued',
  extra: { result?: unknown; error?: string },
): Promise<boolean> {
  const resultJson = extra.result !== undefined ? JSON.stringify(extra.result) : null;
  const rows = await db.execute<{ id: number }>(sql`
    UPDATE probe_tasks SET status = ${status},
      finished_at = CASE WHEN ${status} = 'queued' THEN NULL ELSE now() END,
      result = COALESCE(${resultJson}::jsonb, probe_tasks.result),
      error = ${extra.error ?? null},
      locked_by = NULL, lease_token = NULL, heartbeat_at = NULL
    WHERE id = ${task.id} AND lease_token = ${task.leaseToken} AND status = 'running'
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * 执行一个任务到终态。
 * - 执行中每 30s 心跳（lease 被回收时中止后续模型循环）
 * - 异常时 attempts < max → requeue；≥ max → failed + task_failed 通知
 * - 所有副作用（状态写入、报告、通知）带 lease 校验
 */
export async function runTaskToCompletion(deps: TaskDeps, task: ClaimedTask): Promise<void> {
  // 心跳定时器（30s，审查 #3）
  const hb = setInterval(() => {
    void heartbeatTask(deps.db, task).then((alive) => {
      if (!alive) console.warn(`[tasks] task ${task.id} lease lost, side effects will be skipped`);
    });
  }, 30_000);
  try {
    const result = await executeByKind(deps, task, hb);
    const ok = await completeWithLease(deps.db, task, 'done', { result });
    if (ok && deps.notifyEnabled && task.requestedBy) {
      await insertNotification(deps.db, task.requestedBy, 'task_done',
        '探测任务完成', `渠道「${task.channelName}」的${kindLabel(task.kind)}任务已完成。`);
    }
  } catch (err: unknown) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = scrubKey(rawMessage, task.apiKey) ?? 'unknown error'; // 审查 #1：任务 error 落库前兜底脱敏
    const attempts = task.attempts; // claim 时己 +1
    if (attempts >= deps.maxAttempts) {
      const ok = await completeWithLease(deps.db, task, 'failed', { error: message });
      if (ok && deps.notifyEnabled && task.requestedBy) {
        const body = scrubKey(
          `渠道「${task.channelName}」的${kindLabel(task.kind)}任务失败：${message}`, task.apiKey)
          ?? '任务失败';
        await insertNotification(deps.db, task.requestedBy, 'task_failed', '探测任务失败', body);
      }
    } else {
      await completeWithLease(deps.db, task, 'queued', { error: message });
    }
  } finally {
    clearInterval(hb);
  }
}

function kindLabel(kind: string): string {
  if (kind === 'authenticity') return '真伪检测';
  if (kind === 'discovery') return '模型发现';
  return '可用性探测';
}

async function executeByKind(
  deps: TaskDeps,
  task: ClaimedTask,
  hb: ReturnType<typeof setInterval>,
): Promise<unknown> {
  const target = {
    baseUrl: task.baseUrl,
    apiKey: task.apiKey,
    protocol: task.protocol,
    model: task.primaryModel,
  };
  if (task.kind === 'availability') {
    const job: ProbeJob = {
      channelId: task.channelId,
      siteId: task.siteId,
      ownerId: task.ownerId,
      channelName: task.channelName,
      baseUrl: task.baseUrl,
      apiKey: task.apiKey,
      protocol: task.protocol,
      model: task.primaryModel,
      backupModel: null,
      timeoutMs: deps.timeoutMs,
      trigger: task.trigger,
      channelModelId: null,
    };
    const outcome = await executeProbe(deps.db, job);
    return outcome.result;
  }
  if (task.kind === 'authenticity') {
    return runAuthenticity(deps, task, target, hb);
  }
  return runDiscovery(deps, task, target);
}

/** 真伪检测：对 models 列表（空则主测模型）逐个检测；hint 按当前 model 匹配（审查 #10） */
async function runAuthenticity(
  deps: TaskDeps,
  task: ClaimedTask,
  target: { baseUrl: string; apiKey: string; protocol: ChannelProtocol; model: string },
  hb: ReturnType<typeof setInterval>,
): Promise<{ reports: number }> {
  const models = task.payload?.models?.length ? task.payload.models : [task.primaryModel];
  // 目录：匹配表 + 提示表（同一次查询）
  const catalog = await loadCatalog(deps.db);
  let count = 0;
  for (const model of models) {
    // lease 已丢失则停止后续模型（副作用会被跳过）
    const alive = await heartbeatTask(deps.db, task);
    if (!alive) break;
    // 审查 #10：按当前 model 匹配目录，取该模型的 hint
    const modelId = matchCatalogModel(model, catalog.map((c) => ({ id: c.id, slug: c.slug, aliases: c.aliases })));
    const hint = modelId !== null ? catalog.find((c) => c.id === modelId)?.hint ?? null : null;
    const result = await probeAuthenticity({ ...target, model }, hint, { timeoutMs: deps.timeoutMs });
    // 报告写入带 lease 校验（审查 #3）
    await deps.db.execute(sql`
      INSERT INTO authenticity_reports (channel_id, task_id, model, protocol, score, verdict, checks, duration_ms, trigger, created_at)
      SELECT ${task.channelId}, ${task.id}, ${model}, ${task.protocol}, ${result.score}, ${result.verdict},
        ${JSON.stringify(result.checks)}::jsonb, ${result.durationMs}, ${task.trigger}, now()
      WHERE EXISTS (
        SELECT 1 FROM probe_tasks WHERE id = ${task.id} AND lease_token = ${task.leaseToken} AND status = 'running'
      )
    `);
    // 回写 channel_models trust 字段（同样带 lease 校验）
    await deps.db.execute(sql`
      INSERT INTO channel_models (channel_id, upstream_name, trust_score, trust_verdict, trust_checked_at)
      SELECT ${task.channelId}, ${model}, ${result.score}, ${result.verdict}, now()
      WHERE EXISTS (
        SELECT 1 FROM probe_tasks WHERE id = ${task.id} AND lease_token = ${task.leaseToken} AND status = 'running'
      )
      ON CONFLICT (channel_id, upstream_name) DO UPDATE SET
        trust_score = EXCLUDED.trust_score, trust_verdict = EXCLUDED.trust_verdict,
        trust_checked_at = EXCLUDED.trust_checked_at
    `);
    count += 1;
  }
  void hb; // 心跳由 runTaskToCompletion 的 setInterval 负责
  return { reports: count };
}

/** 模型发现：listUpstreamModels + matchCatalogModel upsert channel_models */
async function runDiscovery(
  deps: TaskDeps,
  task: ClaimedTask,
  target: { baseUrl: string; apiKey: string; protocol: ChannelProtocol },
): Promise<unknown> {
  const list: UpstreamModelList = await listUpstreamModels(
    { baseUrl: target.baseUrl, apiKey: target.apiKey, protocol: target.protocol },
    { timeoutMs: deps.timeoutMs },
  );
  if (!list.ok) {
    throw new Error(list.errorMessage ?? list.errorCode ?? 'listUpstreamModels failed');
  }
  const catalog = await loadCatalog(deps.db);
  const matchable = catalog.map((c) => ({ id: c.id, slug: c.slug, aliases: c.aliases }));
  let matched = 0;
  for (const upstreamName of list.models) {
    const modelId = matchCatalogModel(upstreamName, matchable);
    if (modelId !== null) matched += 1;
    // model_id 用 COALESCE：保留已有映射，避免 discovery 抹掉人工映射
    await deps.db.execute(sql`
      INSERT INTO channel_models (channel_id, upstream_name, model_id)
      VALUES (${task.channelId}, ${upstreamName}, ${modelId})
      ON CONFLICT (channel_id, upstream_name) DO UPDATE SET
        model_id = COALESCE(EXCLUDED.model_id, channel_models.model_id)
    `);
  }
  return { total: list.models.length, matched };
}

interface CatalogEntry {
  id: number;
  slug: string;
  aliases: string[];
  hint: CatalogHint;
}

/** 目录（一次查询同时供 hint 与 matchCatalogModel 使用） */
async function loadCatalog(db: Database): Promise<CatalogEntry[]> {
  const rows = await db.execute<CatalogRow>(sql`
    SELECT m.id, m.slug, m.aliases, v.slug AS vendor_slug, m.tier,
      m.knowledge_cutoff, m.expected_tps
    FROM models m JOIN vendors v ON v.id = m.vendor_id
  `);
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    aliases: r.aliases ?? [],
    hint: {
      slug: r.slug,
      vendorSlug: r.vendor_slug,
      // SAFETY: models.tier 列是 model_tier 枚举，成员与 shared 的 ModelTier 一致
      tier: r.tier as CatalogHint['tier'],
      knowledgeCutoff: r.knowledge_cutoff,
      expectedTps: r.expected_tps,
    },
  }));
}

interface CatalogRow extends Record<string, unknown> {
  id: number;
  slug: string;
  aliases: string[] | null;
  vendor_slug: string;
  tier: string;
  knowledge_cutoff: string | null;
  expected_tps: number | null;
}
