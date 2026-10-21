/*
 * 通知辅助：写 notifications 表（SPEC §5.4 通知类型）。
 */
import { sql } from 'drizzle-orm';
import type { Database } from '@hub/db';

export type NotifyType =
  | 'channel_invalid'
  | 'channel_recovered'
  | 'task_done'
  | 'task_failed'
  | 'site_approved'
  | 'site_rejected';

/** 插入一条站内通知（幂等场景由调用方控制） */
export async function insertNotification(
  db: Database,
  userId: number,
  type: NotifyType,
  title: string,
  body: string,
  link: string | null = null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO notifications (user_id, type, title, body, link)
    VALUES (${userId}, ${type}, ${title}, ${body}, ${link})
  `);
}
