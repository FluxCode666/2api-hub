/*
 * 公开站点/厂商/模型/公告/反馈/鉴定/跳转接口（SPEC §7.1）
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import {
  announcements, channels, feedback, models, reviews,
  settings, sites, users, verifyRequests, vendors, probeRuns,
} from '@hub/db';
import type {
  Announcement, MetaResponse, ModelDetail, ModelSummary, Paginated, Review as ReviewType,
  SiteDetail, SiteListItem, VendorDetail, VendorSummary, VerifyRequest, AuthenticityReport,
  FeedbackInput, SettingsMap,
} from '@hub/shared';
import { DEFAULT_SETTINGS } from '@hub/shared';
import { badRequest, notFound, probeUnavailable, isProbeNotImplemented, HttpError } from '../lib/errors';
import { httpUrl } from '../lib/url';
import { ipHash, iso, siteStatsView, vendorRef } from '../lib/serialize';
import { queryChannels } from '../lib/channelList';
import { siteListQuery, reviewDistribution } from '../lib/sites';

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(20).transform((v) => Math.min(Math.max(v, 1), 100)),
});

// /verify 并发控制（进程内）
const VERIFY_GLOBAL_CONCURRENCY = 4;
let verifyInFlight = 0;
const verifyIpInFlight = new Set<string>();

/** 显式布尔 query 解析：只接受 'true'/'1' 与 'false'/'0'，其余视为 undefined（z.coerce.boolean 会把 'false' 转成 true） */
const boolQuery = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').optional();

export async function publicRoutes(app: FastifyInstance) {
  const db = app.db;

  // ---------- GET /meta ----------
  app.get('/api/v1/meta', async (): Promise<MetaResponse> => {
    const vendorRows = await db.select().from(vendors).orderBy(asc(vendors.sortOrder));
    const modelRows = await db.select().from(models).where(eq(models.isActive, true));
    const modelChannelCount = await channelModelChannelCounts(db);
    const vendorStats = await vendorChannelModelCounts(db);

    const vList: VendorSummary[] = vendorRows.map((v) => ({
      id: v.id,
      ...vendorRef(v),
      modelCount: vendorStats.get(v.id)?.modelCount ?? 0,
      channelCount: vendorStats.get(v.id)?.channelCount ?? 0,
    }));

    const featured = modelRows.filter((m) => m.isFeatured);
    const featuredIds = new Set(featured.map((m) => m.id));
    const priceStats = await modelPriceStats(db, [...featuredIds]);

    const featuredSummaries: ModelSummary[] = featured
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((m) => modelSummary(m, vendorRows, modelChannelCount.get(m.id) ?? 0, priceStats.get(m.id)));

    const [siteCount, channelCount, modelCount, probes, lastProbe] = await Promise.all([
      db.select({ c: count() }).from(sites).where(eq(sites.status, 'approved')),
      db.select({ c: count() }).from(channels).innerJoin(sites, eq(channels.siteId, sites.id))
        .where(and(eq(sites.status, 'approved'), eq(channels.status, 'active'))),
      db.select({ c: count() }).from(models).where(eq(models.isActive, true)),
      db.select({ c: count() }).from(probeRuns)
        .where(sql`${probeRuns.createdAt} > now() - interval '24 hours'`),
      db.select({ t: probeRuns.createdAt }).from(probeRuns).orderBy(desc(probeRuns.createdAt)).limit(1),
    ]);

    return {
      vendors: vList,
      featuredModels: featuredSummaries,
      counts: {
        sites: siteCount[0]?.c ?? 0,
        channels: channelCount[0]?.c ?? 0,
        models: modelCount[0]?.c ?? 0,
        probes24h: probes[0]?.c ?? 0,
      },
      lastProbeAt: iso(lastProbe[0]?.t),
    };
  });

  // ---------- vendors ----------
  app.get('/api/v1/vendors', async (): Promise<VendorSummary[]> => {
    const vendorRows = await db.select().from(vendors).orderBy(asc(vendors.sortOrder));
    const stats = await vendorChannelModelCounts(db);
    return vendorRows.map((v) => ({
      id: v.id,
      ...vendorRef(v),
      modelCount: stats.get(v.id)?.modelCount ?? 0,
      channelCount: stats.get(v.id)?.channelCount ?? 0,
    }));
  });

  app.get('/api/v1/vendors/:slug', async (req): Promise<VendorDetail> => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const v = (await db.select().from(vendors).where(eq(vendors.slug, slug)).limit(1))[0];
    if (!v) throw notFound('厂商不存在');
    const modelRows = await db.select().from(models)
      .where(and(eq(models.vendorId, v.id), eq(models.isActive, true)))
      .orderBy(asc(models.sortOrder));
    const channelCounts = await channelModelChannelCounts(db);
    const priceStats = await modelPriceStats(db, modelRows.map((m) => m.id));
    const stats = await vendorChannelModelCounts(db);
    const st = stats.get(v.id);
    return {
      id: v.id,
      ...vendorRef(v),
      modelCount: st?.modelCount ?? 0,
      channelCount: st?.channelCount ?? 0,
      website: v.website,
      description: v.description,
      models: modelRows.map((m) => modelSummary(m, [v], channelCounts.get(m.id) ?? 0, priceStats.get(m.id))),
    };
  });

  // ---------- models ----------
  app.get('/api/v1/models', async (req): Promise<ModelSummary[]> => {
    const q = z.object({
      vendor: z.string().optional(),
      q: z.string().optional(),
      modality: z.enum(['text', 'image', 'video', 'audio', 'embedding']).optional(),
      featured: boolQuery,
    }).parse(req.query);
    const conds = [eq(models.isActive, true)];
    if (q.vendor) {
      const v = (await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.slug, q.vendor)).limit(1))[0];
      if (!v) return [];
      conds.push(eq(models.vendorId, v.id));
    }
    if (q.q) conds.push(or(ilike(models.slug, `%${q.q}%`), ilike(models.displayName, `%${q.q}%`))!);
    if (q.modality) conds.push(eq(models.modality, q.modality));
    if (q.featured) conds.push(eq(models.isFeatured, true));

    const rows = await db.select().from(models).where(and(...conds)).orderBy(asc(models.sortOrder));
    const vendorRows = await db.select().from(vendors);
    const channelCounts = await channelModelChannelCounts(db);
    const priceStats = await modelPriceStats(db, rows.map((m) => m.id));
    return rows.map((m) => modelSummary(m, vendorRows, channelCounts.get(m.id) ?? 0, priceStats.get(m.id)));
  });

  app.get('/api/v1/models/:slug', async (req): Promise<ModelDetail> => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const m = (await db.select().from(models).where(eq(models.slug, slug)).limit(1))[0];
    if (!m || !m.isActive) throw notFound('模型不存在');
    const v = (await db.select().from(vendors).where(eq(vendors.id, m.vendorId)).limit(1))[0];
    if (!v) throw notFound('厂商不存在');
    const channelCounts = await channelModelChannelCounts(db);
    const priceStats = await modelPriceStats(db, [m.id]);
    const base = modelSummary(m, [v], channelCounts.get(m.id) ?? 0, priceStats.get(m.id));
    return {
      ...base,
      aliases: m.aliases,
      defaultProtocol: m.defaultProtocol,
      knowledgeCutoff: m.knowledgeCutoff,
      releasedAt: m.releasedAt,
      description: m.description,
      expectedTps: m.expectedTps,
    };
  });

  // ---------- sites ----------
  app.get('/api/v1/sites', async (req): Promise<Paginated<SiteListItem>> => {
    const q = pageQuery.extend({
      q: z.string().optional(),
      type: z.enum(['new_api', 'sub2api', 'one_api', 'custom']).optional(),
      vendor: z.string().optional(),
      sort: z.enum(['score', 'uptime', 'channels', 'newest']).default('score'),
    }).parse(req.query);
    return siteListQuery(db, q);
  });

  app.get('/api/v1/sites/:slug', async (req): Promise<SiteDetail> => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const s = (await db.select().from(sites).where(and(eq(sites.slug, slug), eq(sites.status, 'approved'))).limit(1))[0];
    if (!s) throw notFound('站点不存在');
    const detail = await siteDetailById(db, s.id);
    if (!detail) throw notFound('站点不存在');
    return detail;
  });

  app.get('/api/v1/sites/:slug/reviews', async (req): Promise<Paginated<ReviewType>> => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const q = pageQuery.parse(req.query);
    const s = (await db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug)).limit(1))[0];
    if (!s) throw notFound('站点不存在');
    const where = and(eq(reviews.siteId, s.id), eq(reviews.status, 'visible'));
    const total = (await db.select({ c: count() }).from(reviews).where(where))[0]?.c ?? 0;
    const rows = await db
      .select({ review: reviews, nickname: users.nickname, avatarUrl: users.avatarUrl })
      .from(reviews)
      .innerJoin(users, eq(reviews.userId, users.id))
      .where(where)
      .orderBy(desc(reviews.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    return {
      items: rows.map(({ review: r, nickname, avatarUrl }) => ({
        id: r.id,
        rating: r.rating,
        content: r.content,
        user: { nickname, avatarUrl },
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  });

  // ---------- rankings/overview ----------
  app.get('/api/v1/rankings/overview', async () => {
    const featured = await db.select().from(models)
      .where(and(eq(models.isActive, true), eq(models.isFeatured, true)))
      .orderBy(asc(models.sortOrder)).limit(6);
    const vendorRows = await db.select().from(vendors);
    const channelCounts = await channelModelChannelCounts(db);
    const priceStats = await modelPriceStats(db, featured.map((m) => m.id));
    const lastProbe = await db.select({ t: probeRuns.createdAt }).from(probeRuns)
      .orderBy(desc(probeRuns.createdAt)).limit(1);

    const result = await Promise.all(featured.map(async (m) => {
      const { items } = await queryChannels(db, { model: m.slug, sort: 'recommend', order: 'desc', page: 1, pageSize: 3 });
      return {
        model: modelSummary(m, vendorRows, channelCounts.get(m.id) ?? 0, priceStats.get(m.id)),
        top: items,
      };
    }));
    return { updatedAt: iso(lastProbe[0]?.t), models: result };
  });

  // ---------- announcements ----------
  app.get('/api/v1/announcements', async (): Promise<Announcement[]> => {
    const rows = await db.select().from(announcements)
      .where(eq(announcements.enabled, true))
      .orderBy(desc(announcements.pinned), desc(announcements.createdAt));
    return rows.map((a) => ({
      id: a.id, title: a.title, contentMd: a.contentMd,
      pinned: a.pinned, enabled: a.enabled, createdAt: a.createdAt.toISOString(),
    }));
  });

  // ---------- /verify 公开鉴定（IP 限频 + 原子预留额度 + 并发上限） ----------
  app.post('/api/v1/verify', async (req, reply): Promise<AuthenticityReport> => {
    const input = z.object({
      baseUrl: httpUrl(),
      apiKey: z.string().min(8, 'API Key 长度至少 8 位').max(500),
      model: z.string().min(1).max(200),
      protocol: z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini']),
    } satisfies Record<keyof VerifyRequest, z.ZodTypeAny>).parse(req.body);

    // 全局并发上限：同步占用信号量（第一个 await 之前），统一 finally 释放
    if (verifyInFlight >= VERIFY_GLOBAL_CONCURRENCY) {
      throw new HttpError(429, 'rate_limited', '鉴定服务繁忙，请稍后再试');
    }
    verifyInFlight++;
    const hash = ipHash(req.ip);
    try {
      const rows = await db.select().from(settings);
      // SAFETY: DEFAULT_SETTINGS 全量默认，库中覆盖值由管理接口按同一类型写入
      const settingsMap = { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) } as unknown as SettingsMap;
      const limit = settingsMap['verify.hourlyLimitPerIp'];

      // 原子预留额度：事务内先插入 pending 记录再计数（覆盖执行中的请求）
      let host: string;
      try {
        host = new URL(input.baseUrl).host;
      } catch {
        throw badRequest('baseUrl 不是合法 URL');
      }
      const reservation = await db.transaction(async (tx) => {
        const [row] = await tx.insert(verifyRequests).values({
          ipHash: hash, host, model: input.model, protocol: input.protocol,
          score: null, verdict: 'unknown',
        }).returning({ id: verifyRequests.id });
        const recent = await tx.select({ c: count() }).from(verifyRequests)
          .where(and(eq(verifyRequests.ipHash, hash), sql`${verifyRequests.createdAt} > now() - interval '1 hour'`));
        if ((recent[0]?.c ?? 0) > limit) {
          throw new HttpError(429, 'rate_limited', `鉴定请求过于频繁，每小时最多 ${limit} 次`);
        }
        return row!;
      });

      // 单 IP 并发上限 1（同步检查）
      if (verifyIpInFlight.has(hash)) {
        await db.delete(verifyRequests).where(eq(verifyRequests.id, reservation.id));
        throw new HttpError(429, 'rate_limited', '同一 IP 同时只能执行一次鉴定');
      }
      verifyIpInFlight.add(hash);

      try {
        const probe = await import('@hub/probe');
        const catalog = await db.select({ id: models.id, slug: models.slug, aliases: models.aliases }).from(models).where(eq(models.isActive, true));
        const matchedId = probe.matchCatalogModel(input.model, catalog);
        let hint = null;
        if (matchedId !== null) {
          const m = (await db.select().from(models).where(eq(models.id, matchedId)).limit(1))[0];
          if (m) {
            const v = (await db.select().from(vendors).where(eq(vendors.id, m.vendorId)).limit(1))[0];
            hint = { slug: m.slug, vendorSlug: v?.slug ?? '', tier: m.tier, knowledgeCutoff: m.knowledgeCutoff, expectedTps: m.expectedTps };
          }
        }

        let result;
        try {
          result = await probe.probeAuthenticity(
            { baseUrl: input.baseUrl, apiKey: input.apiKey, protocol: input.protocol, model: input.model },
            hint,
            { quick: true, timeoutMs: 60000 },
          );
        } catch (err) {
          if (isProbeNotImplemented(err)) throw probeUnavailable();
          if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'ssrf_blocked') {
            throw badRequest('目标地址不安全（禁止探测私网/保留地址）');
          }
          throw err;
        }

        await db.update(verifyRequests).set({ score: result.score, verdict: result.verdict })
          .where(eq(verifyRequests.id, reservation.id));

        void reply.header('cache-control', 'no-store');
        return { ...result, id: null, channelId: null, trigger: 'public', createdAt: new Date().toISOString() };
      } catch (err) {
        // 失败退还预留额度（删除占位记录）
        await db.delete(verifyRequests).where(eq(verifyRequests.id, reservation.id)).catch(() => {});
        throw err;
      } finally {
        verifyIpInFlight.delete(hash);
      }
    } finally {
      verifyInFlight--;
    }
  });

  // ---------- /feedback ----------
  app.post('/api/v1/feedback', async (req, reply) => {
    const input = z.object({
      type: z.enum(['recommend_site', 'suggestion', 'complaint', 'bug']),
      siteName: z.string().max(200).optional(),
      siteUrl: z.string().max(500).optional(),
      contact: z.string().max(200).optional(),
      content: z.string().min(1).max(5000),
    } satisfies Record<keyof FeedbackInput, z.ZodTypeAny>).parse(req.body);

    // IP 限频：每小时 10 条
    const hash = ipHash(req.ip);
    const recent = await db.select({ c: count() }).from(feedback)
      .where(and(eq(feedback.ipHash, hash), sql`${feedback.createdAt} > now() - interval '1 hour'`));
    if ((recent[0]?.c ?? 0) >= 10) throw new HttpError(429, 'rate_limited', '提交过于频繁，请稍后再试');

    const user = await app.optionalUser(req);
    const [row] = await db.insert(feedback).values({
      userId: user?.id ?? null,
      type: input.type,
      siteName: input.siteName ?? null,
      siteUrl: input.siteUrl ?? null,
      contact: input.contact ?? null,
      content: input.content,
      ipHash: hash,
    }).returning({ id: feedback.id });
    void reply.status(201);
    return { id: row!.id };
  });

  // ---------- /go/:channelId 302 ----------
  app.get('/api/v1/go/:channelId', async (req, reply) => {
    const { channelId } = z.object({ channelId: z.coerce.number().int().positive() }).parse(req.params);
    const rows = await db.select({
      inviteUrl: sites.inviteUrl, homepageUrl: sites.homepageUrl,
      siteStatus: sites.status, channelId: channels.id, siteId: sites.id,
    }).from(channels).innerJoin(sites, eq(channels.siteId, sites.id))
      .where(eq(channels.id, channelId)).limit(1);
    const r = rows[0];
    if (!r || r.siteStatus !== 'approved') throw notFound('渠道不存在');
    // 记录点击（异步，不阻塞跳转）
    void db.execute(sql`UPDATE sites SET click_count = click_count + 1 WHERE id = ${r.siteId}`);
    void db.execute(sql`UPDATE channels SET click_count = click_count + 1 WHERE id = ${channelId}`);
    // 跳转目标只允许 http/https（防御 javascript: 等危险协议）
    const rawTarget = r.inviteUrl ?? r.homepageUrl;
    let target: string;
    try {
      const u = new URL(rawTarget);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
      target = rawTarget;
    } catch {
      throw notFound('渠道跳转链接不可用');
    }
    return reply.status(302).header('location', target).send();
  });
}

// ---------- 公共查询辅助 ----------

/** 每个目录模型的已上线渠道数 */
export async function channelModelChannelCounts(db: import('@hub/db').Database): Promise<Map<number, number>> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT cm.model_id AS model_id, count(DISTINCT c.id)::int AS cnt
    FROM channel_models cm
    JOIN channels c ON c.id = cm.channel_id AND c.status = 'active'
    JOIN sites s ON s.id = c.site_id AND s.status = 'approved'
    WHERE cm.model_id IS NOT NULL
    GROUP BY cm.model_id`);
  return new Map(rows.map((r) => [r['model_id'] as number, r['cnt'] as number]));
}

/** 每个目录模型的最低 ¥ 输入价与最佳 24h 可用率 */
export async function modelPriceStats(
  db: import('@hub/db').Database,
  modelIds: number[],
): Promise<Map<number, { minInputPriceCny: number | null; bestUptime24h: number | null }>> {
  const map = new Map<number, { minInputPriceCny: number | null; bestUptime24h: number | null }>();
  if (modelIds.length === 0) return map;
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT cm.model_id,
      min(COALESCE(cm.price_override_input, m.official_input_price *
        (CASE WHEN s.recharge_ratio > 0 THEN c.group_ratio / s.recharge_ratio ELSE c.group_ratio END))) AS min_price,
      max(cs.uptime_24h) AS best_uptime
    FROM channel_models cm
    JOIN channels c ON c.id = cm.channel_id AND c.status = 'active'
    JOIN sites s ON s.id = c.site_id AND s.status = 'approved'
    JOIN models m ON m.id = cm.model_id
    LEFT JOIN channel_stats cs ON cs.channel_id = c.id
    WHERE cm.model_id IN (${sql.join(modelIds.map((id) => sql`${id}`), sql`, `)})
    GROUP BY cm.model_id`);
  for (const r of rows) {
    map.set(r['model_id'] as number, {
      minInputPriceCny: r['min_price'] === null ? null : Math.round((r['min_price'] as number) * 1000) / 1000,
      bestUptime24h: (r['best_uptime'] as number | null) ?? null,
    });
  }
  return map;
}

type ModelRow = typeof models.$inferSelect;
type VendorRow = typeof vendors.$inferSelect;

function modelSummary(
  m: ModelRow,
  vendorRows: VendorRow[],
  channelCount: number,
  priceStat?: { minInputPriceCny: number | null; bestUptime24h: number | null },
): ModelSummary {
  const v = vendorRows.find((x) => x.id === m.vendorId);
  return {
    id: m.id,
    slug: m.slug,
    displayName: m.displayName,
    vendor: vendorRef(v ?? { slug: 'unknown', name: '未知', nameZh: null, color: '#888888', iconUrl: null }),
    family: m.family,
    modality: m.modality,
    tier: m.tier,
    officialInputPrice: m.officialInputPrice,
    officialOutputPrice: m.officialOutputPrice,
    contextWindow: m.contextWindow,
    isFeatured: m.isFeatured,
    channelCount,
    minInputPriceCny: priceStat?.minInputPriceCny ?? null,
    bestUptime24h: priceStat?.bestUptime24h ?? null,
  };
}

/** 每个厂商的（active 模型数，已上线渠道数） */
async function vendorChannelModelCounts(db: import('@hub/db').Database): Promise<Map<number, { modelCount: number; channelCount: number }>> {
  const modelRows = await db.execute<Record<string, unknown>>(sql`
    SELECT vendor_id, count(*)::int AS cnt FROM models WHERE is_active = true GROUP BY vendor_id`);
  const channelRows = await db.execute<Record<string, unknown>>(sql`
    SELECT vendor_id, count(DISTINCT id)::int AS cnt FROM channels c
    WHERE c.status = 'active' AND EXISTS (SELECT 1 FROM sites s WHERE s.id = c.site_id AND s.status = 'approved')
    GROUP BY vendor_id`);
  // 也统计「声明模型属于该厂商」的渠道
  const viaModels = await db.execute<Record<string, unknown>>(sql`
    SELECT m.vendor_id, count(DISTINCT c.id)::int AS cnt
    FROM channel_models cm
    JOIN channels c ON c.id = cm.channel_id AND c.status = 'active'
    JOIN sites s ON s.id = c.site_id AND s.status = 'approved'
    JOIN models m ON m.id = cm.model_id
    GROUP BY m.vendor_id`);
  const map = new Map<number, { modelCount: number; channelCount: number }>();
  for (const r of modelRows) map.set(r['vendor_id'] as number, { modelCount: r['cnt'] as number, channelCount: 0 });
  const channelCountByVendor = new Map<number, number>();
  for (const r of channelRows) channelCountByVendor.set(r['vendor_id'] as number, r['cnt'] as number);
  for (const r of viaModels) {
    const vid = r['vendor_id'] as number;
    channelCountByVendor.set(vid, Math.max(channelCountByVendor.get(vid) ?? 0, r['cnt'] as number));
  }
  for (const [vid, cnt] of channelCountByVendor) {
    const cur = map.get(vid) ?? { modelCount: 0, channelCount: 0 };
    cur.channelCount = cnt;
    map.set(vid, cur);
  }
  return map;
}

export async function siteDetailById(db: import('@hub/db').Database, siteId: number): Promise<SiteDetail | null> {
  const s = (await db.select().from(sites).where(eq(sites.id, siteId)).limit(1))[0];
  if (!s) return null;
  const { siteStats } = await import('@hub/db');
  const statsRow = (await db.select().from(siteStats).where(eq(siteStats.siteId, s.id)).limit(1))[0];
  const { items: channelItems } = await queryChannels(db, { siteId: s.id, sort: 'recommend', order: 'desc', page: 1, pageSize: 100 });
  const dist = await reviewDistribution(db, s.id);
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    logoUrl: s.logoUrl,
    homepageUrl: s.homepageUrl,
    type: s.type,
    description: s.description,
    tags: s.tags,
    isVerified: s.isVerified,
    isFeatured: s.isFeatured,
    stats: siteStatsView(statsRow),
    createdAt: s.createdAt.toISOString(),
    contact: s.contact,
    paymentMethods: s.paymentMethods,
    rechargeRatio: s.rechargeRatio,
    approvedAt: iso(s.approvedAt),
    channels: channelItems,
    ratingSummary: dist,
  };
}
