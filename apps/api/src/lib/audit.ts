/*
 * 审计日志（共享）。
 */
import type { Database } from '@hub/db';
import { auditLogs } from '@hub/db';
import type { SessionUser } from '@hub/shared';

export async function audit(
  db: Database,
  actor: SessionUser | null,
  action: string,
  targetType: string,
  targetId: string | number,
  meta: Record<string, unknown> = {},
  ip?: string,
): Promise<void> {
  await db.insert(auditLogs).values({
    actorId: actor?.id ?? null, action, targetType, targetId: String(targetId), meta, ip: ip ?? null,
  });
}
