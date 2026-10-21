/*
 * 原子探测任务入队（所有入口共用）：
 * - SELECT ... FOR UPDATE 锁渠道行（事务内所有查询共用同一 tx 连接，避免连接池死锁）
 * - 同一 channel+kind 已有 queued/running 任务时直接复用（不重复入队）
 * - trigger=merchant && kind=authenticity 时自动计入每日额度（超限返回 429，调用方决定是否阻止外层操作）
 * - SET LOCAL lock_timeout/statement_timeout 兜底
 */
import { and, count, eq, sql } from 'drizzle-orm';
import { channels, probeTasks, settings } from '@hub/db';
import type { Database } from '@hub/db';
import type { ProbeKind, ProbeTask, ProbeTaskPayload, ProbeTrigger } from '@hub/shared';
import { DEFAULT_SETTINGS } from '@hub/shared';

export interface EnqueueResult {
  task: ProbeTask | null;
  reused: boolean;
  /** 超每日额度时为 true，task 为 null；调用方决定是否阻止外层操作 */
  rateLimited: boolean;
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

export async function enqueueProbeTask(
  db: Database,
  opts: {
    channelId: number;
    kind: ProbeKind;
    trigger: ProbeTrigger;
    payload?: ProbeTaskPayload;
    requestedBy?: string | null;
  },
): Promise<EnqueueResult> {
  return db.transaction(async (tx) => {
    // 锁/语句超时兜底，避免连接池级死锁
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);

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
      return { task: taskView(existing[0]), reused: true, rateLimited: false };
    }

    // 站长手动真伪检测：自动计入每日额度（trigger=merchant && kind=authenticity）
    if (opts.trigger === 'merchant' && opts.kind === 'authenticity') {
      // 事务内用 tx 读 settings（不用外层 db，避免连接池死锁）
      const settingRows = await tx.select().from(settings).where(eq(settings.key, 'authenticity.merchantDailyLimit')).limit(1);
      const v = settingRows[0]?.value;
      const limit = typeof v === 'number' ? v : DEFAULT_SETTINGS['authenticity.merchantDailyLimit'];

      const today = await tx.select({ c: count() }).from(probeTasks)
        .where(and(
          eq(probeTasks.channelId, opts.channelId),
          eq(probeTasks.kind, 'authenticity'),
          eq(probeTasks.trigger, 'merchant'),
          sql`${probeTasks.createdAt} > now() - interval '24 hours'`,
        ));
      if ((today[0]?.c ?? 0) >= limit) {
        // 超额度：不抛错（PATCH 等场景外层操作照常成功），返回 rateLimited 标记
        return { task: null, reused: false, rateLimited: true };
      }
    }

    const [task] = await tx.insert(probeTasks).values({
      channelId: opts.channelId,
      kind: opts.kind,
      trigger: opts.trigger,
      payload: opts.payload ?? {},
      requestedBy: opts.requestedBy ?? null,
    }).returning();
    return { task: taskView(task!), reused: false, rateLimited: false };
  });
}
