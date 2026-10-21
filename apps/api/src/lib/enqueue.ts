/*
 * 原子探测任务入队（所有入口共用）：
 * - SELECT ... FOR UPDATE 锁渠道行
 * - 同一 channel+kind 已有 queued/running 任务时直接复用（不重复入队）
 * - 站长手动触发（trigger=merchant）时在同一事务内检查每日额度
 * - 返回 { task, reused }：reused=true 表示复用了已有任务
 */
import { and, count, eq, sql } from 'drizzle-orm';
import { channels, probeTasks, settings } from '@hub/db';
import type { Database } from '@hub/db';
import type { ProbeKind, ProbeTask, ProbeTaskPayload, ProbeTrigger } from '@hub/shared';
import { DEFAULT_SETTINGS } from '@hub/shared';
import { HttpError } from './errors';

export interface EnqueueResult {
  task: ProbeTask;
  reused: boolean;
}

function taskView(t: typeof probeTasks.$inferSelect): ProbeTask {
  return {
    id: t.id,
    channelId: t.channelId,
    kind: t.kind,
    trigger: t.trigger,
    status: t.status,
    payload: t.payload,
    result: t.result ?? null,
    error: t.error,
    createdAt: t.createdAt.toISOString(),
    startedAt: t.startedAt?.toISOString() ?? null,
    finishedAt: t.finishedAt?.toISOString() ?? null,
  };
}

async function merchantDailyLimit(db: Database): Promise<number> {
  const rows = await db.select().from(settings).where(eq(settings.key, 'authenticity.merchantDailyLimit'));
  const v = rows[0]?.value;
  return typeof v === 'number' ? v : DEFAULT_SETTINGS['authenticity.merchantDailyLimit'];
}

export async function enqueueProbeTask(
  db: Database,
  opts: {
    channelId: number;
    kind: ProbeKind;
    trigger: ProbeTrigger;
    payload?: ProbeTaskPayload;
    requestedBy?: string | null;
    /** 站长手动真伪检测的每日限额检查（仅 trigger=merchant & kind=authenticity 时生效） */
    checkMerchantDailyLimit?: boolean;
  },
): Promise<EnqueueResult> {
  return db.transaction(async (tx) => {
    // 锁渠道行，串行化同一渠道的入队
    await tx.execute(sql`SELECT id FROM channels WHERE id = ${opts.channelId} FOR UPDATE`);

    // 复用已有 queued/running 任务（同 channel+kind）
    const existing = await tx.select().from(probeTasks)
      .where(and(
        eq(probeTasks.channelId, opts.channelId),
        eq(probeTasks.kind, opts.kind),
        sql`${probeTasks.status} IN ('queued','running')`,
      ))
      .orderBy(sql`${probeTasks.createdAt} DESC`)
      .limit(1);
    if (existing[0]) {
      return { task: taskView(existing[0]), reused: true };
    }

    // 站长手动真伪检测：同事务内检查每日额度
    if (opts.checkMerchantDailyLimit && opts.trigger === 'merchant' && opts.kind === 'authenticity') {
      const limit = await merchantDailyLimit(db);
      const today = await tx.select({ c: count() }).from(probeTasks)
        .where(and(
          eq(probeTasks.channelId, opts.channelId),
          eq(probeTasks.kind, 'authenticity'),
          eq(probeTasks.trigger, 'merchant'),
          sql`${probeTasks.createdAt} > now() - interval '24 hours'`,
        ));
      if ((today[0]?.c ?? 0) >= limit) {
        throw new HttpError(429, 'rate_limited', `每个渠道每天最多发起 ${limit} 次真伪检测`);
      }
    }

    const [task] = await tx.insert(probeTasks).values({
      channelId: opts.channelId,
      kind: opts.kind,
      trigger: opts.trigger,
      payload: opts.payload ?? {},
      requestedBy: opts.requestedBy ?? null,
    }).returning();
    return { task: taskView(task!), reused: false };
  });
}
