/*
 * 用户接口（SPEC §7.3）：favorites/notifications 分页；/me/reviews 契约增量。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { favorites, notifications, reviews, sites } from '@hub/db';
import type {
  ChannelListItem, MyReview, NotificationList, Paginated, Review, ReviewInput,
} from '@hub/shared';
import { notFound } from '../lib/errors';
import { queryChannels } from '../lib/channelList';

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(20).transform((v) => Math.min(Math.max(v, 1), 100)),
});

export async function meRoutes(app: FastifyInstance) {
  const db = app.db;

  // ---------- 收藏（分页；已下线渠道也返回，status 如实） ----------
  app.get('/api/v1/me/favorites', async (req): Promise<Paginated<ChannelListItem>> => {
    const user = await app.requireAuth(req);
    const q = pageQuery.parse(req.query);
    // 先分页查收藏（按收藏时间倒序），再批量取渠道
    const total = (await db.select({ c: count() }).from(favorites).where(eq(favorites.userId, user.id)))[0]?.c ?? 0;
    if (total === 0) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
    const rows = await db.select({ channelId: favorites.channelId }).from(favorites)
      .where(eq(favorites.userId, user.id))
      .orderBy(desc(favorites.createdAt))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    const ids = rows.map((r) => r.channelId);
    // page 越界时 ids 为空：直接返回空页（不调用 queryChannels，避免空 IN 子句）
    if (ids.length === 0) return { items: [], total, page: q.page, pageSize: q.pageSize };
    // includeOffline：已下线/暂停/失效的收藏也返回
    const { items } = await queryChannels(db, { ids, page: 1, pageSize: 100, sort: 'updated', order: 'desc', includeOffline: true }, user.id);
    const map = new Map(items.map((it) => [it.id, it]));
    // 按收藏顺序（时间倒序）重排，并重赋 rank = (page-1)*pageSize + index + 1
    const ordered = ids.map((id) => map.get(id)).filter((x): x is ChannelListItem => x !== undefined);
    return {
      items: ordered.map((item, i) => ({ ...item, rank: (q.page - 1) * q.pageSize + i + 1 })),
      total, page: q.page, pageSize: q.pageSize,
    };
  });

  app.post('/api/v1/me/favorites/:channelId', async (req, reply) => {
    const user = await app.requireAuth(req);
    const { channelId } = z.object({ channelId: z.coerce.number().int().positive() }).parse(req.params);
    await db.insert(favorites).values({ userId: user.id, channelId })
      .onConflictDoNothing({ target: [favorites.userId, favorites.channelId] });
    void reply.status(201);
    return { ok: true };
  });

  app.delete('/api/v1/me/favorites/:channelId', async (req) => {
    const user = await app.requireAuth(req);
    const { channelId } = z.object({ channelId: z.coerce.number().int().positive() }).parse(req.params);
    await db.delete(favorites).where(and(eq(favorites.userId, user.id), eq(favorites.channelId, channelId)));
    return { ok: true };
  });

  // ---------- 站点评价（每用户每站点 1 条，再提交为更新） ----------
  app.post('/api/v1/sites/:slug/reviews', async (req, reply): Promise<Review> => {
    const user = await app.requireAuth(req);
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const input = z.object({
      rating: z.number().int().min(1).max(5),
      content: z.string().min(1).max(2000),
    } satisfies Record<keyof ReviewInput, z.ZodTypeAny>).parse(req.body);

    const site = (await db.select().from(sites).where(and(eq(sites.slug, slug), eq(sites.status, 'approved'))).limit(1))[0];
    if (!site) throw notFound('站点不存在');

    const existing = (await db.select().from(reviews)
      .where(and(eq(reviews.siteId, site.id), eq(reviews.userId, user.id))).limit(1))[0];
    let r: typeof reviews.$inferSelect;
    if (existing) {
      const updated = await db.update(reviews)
        .set({ rating: input.rating, content: input.content, updatedAt: new Date() })
        .where(eq(reviews.id, existing.id))
        .returning();
      r = updated[0]!;
    } else {
      const inserted = await db.insert(reviews).values({
        siteId: site.id, userId: user.id, rating: input.rating, content: input.content,
      }).returning();
      r = inserted[0]!;
      void reply.status(201);
    }
    return {
      id: r.id,
      rating: r.rating,
      content: r.content,
      user: { nickname: user.nickname, avatarUrl: user.avatarUrl },
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });

  // ---------- 我的评价（契约增量） ----------
  app.get('/api/v1/me/reviews', async (req): Promise<Paginated<MyReview>> => {
    const user = await app.requireAuth(req);
    const q = pageQuery.parse(req.query);
    const where = eq(reviews.userId, user.id);
    const total = (await db.select({ c: count() }).from(reviews).where(where))[0]?.c ?? 0;
    const rows = await db
      .select({ r: reviews, siteId: sites.id, siteSlug: sites.slug, siteName: sites.name })
      .from(reviews)
      .innerJoin(sites, eq(reviews.siteId, sites.id))
      .where(where)
      .orderBy(desc(reviews.updatedAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return {
      items: rows.map(({ r, siteId, siteSlug, siteName }) => ({
        id: r.id,
        rating: r.rating,
        content: r.content,
        user: { nickname: user.nickname, avatarUrl: user.avatarUrl },
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        status: r.status,
        site: { id: siteId, slug: siteSlug, name: siteName },
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  app.delete('/api/v1/me/reviews/:id', async (req) => {
    const user = await app.requireAuth(req);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const deleted = await db.delete(reviews)
      .where(and(eq(reviews.id, id), eq(reviews.userId, user.id)))
      .returning({ id: reviews.id });
    if (!deleted[0]) throw notFound('评价不存在');
    return { ok: true };
  });

  // ---------- 通知（分页 + unreadCount + unread 筛选） ----------
  app.get('/api/v1/me/notifications', async (req): Promise<NotificationList> => {
    const user = await app.requireAuth(req);
    const q = pageQuery.extend({
      unread: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').optional(),
    }).parse(req.query);
    const baseWhere = eq(notifications.userId, user.id);
    const where = q.unread ? and(baseWhere, sql`${notifications.readAt} IS NULL`) : baseWhere;
    const [total, unreadCount] = await Promise.all([
      db.select({ c: count() }).from(notifications).where(where),
      db.select({ c: count() }).from(notifications).where(and(baseWhere, sql`${notifications.readAt} IS NULL`)),
    ]);
    const rows = await db.select().from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return {
      items: rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        link: n.link,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      total: total[0]?.c ?? 0,
      page: q.page,
      pageSize: q.pageSize,
      unreadCount: unreadCount[0]?.c ?? 0,
    };
  });

  app.post('/api/v1/me/notifications/read', async (req) => {
    const user = await app.requireAuth(req);
    const input = z.object({ ids: z.array(z.number().int()).optional() }).parse(req.body ?? {});
    if (input.ids && input.ids.length > 0) {
      await db.execute(sql`
        UPDATE notifications SET read_at = now()
        WHERE user_id = ${user.id} AND read_at IS NULL
          AND id IN (${sql.join(input.ids.map((i) => sql`${i}`), sql`, `)})`);
    } else {
      await db.execute(sql`UPDATE notifications SET read_at = now() WHERE user_id = ${user.id} AND read_at IS NULL`);
    }
    return { ok: true };
  });
}
