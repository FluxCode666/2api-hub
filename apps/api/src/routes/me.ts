/*
 * 用户接口（SPEC §7.3 + 契约增量：/me/reviews、DELETE /me/reviews/:id）
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { favorites, notifications, reviews, sites } from '@hub/db';
import type {
  ChannelListItem, MyReview, Notification, Paginated, Review, ReviewInput,
} from '@hub/shared';
import { notFound } from '../lib/errors';
import { queryChannels } from '../lib/channelList';

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function meRoutes(app: FastifyInstance) {
  const db = app.db;

  // ---------- 收藏 ----------
  app.get('/api/v1/me/favorites', async (req): Promise<ChannelListItem[]> => {
    const user = await app.requireAuth(req);
    const rows = await db.select({ channelId: favorites.channelId }).from(favorites)
      .where(eq(favorites.userId, user.id)).orderBy(desc(favorites.createdAt));
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.channelId);
    const { items } = await queryChannels(db, { ids, page: 1, pageSize: 100, sort: 'updated', order: 'desc' }, user.id);
    // 按收藏顺序返回
    const map = new Map(items.map((it) => [it.id, it]));
    return ids.map((id) => map.get(id)).filter((x): x is ChannelListItem => x !== undefined);
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

  // ---------- 通知 ----------
  app.get('/api/v1/me/notifications', async (req): Promise<Notification[]> => {
    const user = await app.requireAuth(req);
    const rows = await db.select().from(notifications)
      .where(eq(notifications.userId, user.id))
      .orderBy(desc(notifications.createdAt)).limit(100);
    return rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    }));
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
