/*
 * 站长后台接口（SPEC §7.4）。只能操作自己的站点；越权一律 404。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  authenticityReports, channelModels, channels, probeRuns, probeTasks,
  sites, siteStats, vendors, models,
} from '@hub/db';
import { actualRatio } from '@hub/shared';
import type {
  ChannelInput, ChannelModelsInput, MerchantChannel, MerchantChannelModel,
  MerchantOverview, MerchantSite, MerchantSiteDetail, Paginated, ProbeResult, ProbeRun,
  ProbeTask, SiteInput, AuthenticityReport,
} from '@hub/shared';

import { badRequest, forbidden, isProbeNotImplemented, notFound, probeUnavailable, HttpError } from '../lib/errors';
import { httpUrl } from '../lib/url';
import { channelStatsView, iso, probeRunView, reportView, siteStatsView, taskView, vendorRef } from '../lib/serialize';
import { decryptSecret, encryptSecret, maskSecret } from '@hub/db';
import { sanitizeKeyFromText } from '../lib/sanitize';
import { enqueueProbeTask } from '../lib/enqueue';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const siteInputSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9-]+$/).max(100).optional(),
  homepageUrl: httpUrl(),
  inviteUrl: httpUrl().nullish(),
  logoUrl: httpUrl().nullish(),
  description: z.string().max(2000).nullish(),
  type: z.enum(['new_api', 'sub2api', 'one_api', 'custom']),
  rechargeRatio: z.number().positive().max(1000),
  contact: z.object({
    qq: z.string().max(50).optional(),
    wechat: z.string().max(50).optional(),
    telegram: z.string().max(50).optional(),
    email: z.string().max(100).optional(),
    group: z.string().max(200).optional(),
  }).optional(),
  tags: z.array(z.string().max(30)).max(10).optional(),
  paymentMethods: z.array(z.string().max(30)).max(10).optional(),
} satisfies Record<keyof SiteInput, z.ZodTypeAny>);

const channelInputSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).nullish(),
  vendorSlug: z.string().max(50).nullish(),
  protocol: z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini']),
  baseUrl: httpUrl(),
  // 更新时 '' 归一为 undefined（契约：留空表示不修改）；创建时仍要求非空
  apiKey: z.string().max(500).transform((v) => v === '' ? undefined : v).optional(),
  groupRatio: z.number().positive().max(1000),
  billingType: z.enum(['per_token', 'per_request', 'subscription']).optional(),
  primaryModel: z.string().min(1).max(200),
  backupModel: z.string().max(200).nullish(),
  rpmLimit: z.number().int().positive().nullish(),
  declaredModels: z.array(z.string().max(200)).max(100).optional(),
} satisfies Record<keyof ChannelInput, z.ZodTypeAny>);

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '');
  return base || `site-${Date.now()}`;
}

function siteToMerchant(s: typeof sites.$inferSelect, channelCount: number, stats: typeof siteStats.$inferSelect | undefined): MerchantSite {
  return {
    id: s.id, slug: s.slug, name: s.name, homepageUrl: s.homepageUrl, inviteUrl: s.inviteUrl,
    logoUrl: s.logoUrl, description: s.description, type: s.type, rechargeRatio: s.rechargeRatio,
    contact: s.contact, tags: s.tags, paymentMethods: s.paymentMethods, status: s.status,
    reviewNote: s.reviewNote, submittedAt: iso(s.submittedAt), approvedAt: iso(s.approvedAt),
    isVerified: s.isVerified, isFeatured: s.isFeatured, channelCount,
    stats: stats ? siteStatsView(stats) : null,
    createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString(),
  };
}

function channelToMerchant(
  c: typeof channels.$inferSelect,
  vendorRow: typeof vendors.$inferSelect | null,
  rechargeRatio: number,
  modelsList: MerchantChannelModel[],
  statsRow: Parameters<typeof channelStatsView>[0],
  latestReport: AuthenticityReport | null,
): MerchantChannel {
  return {
    id: c.id, siteId: c.siteId, name: c.name, description: c.description,
    vendor: vendorRow ? vendorRef(vendorRow) : null,
    protocol: c.protocol, baseUrl: c.baseUrl, apiKeyMask: c.apiKeyMask,
    groupRatio: c.groupRatio, actualRatio: actualRatio(c.groupRatio, rechargeRatio),
    billingType: c.billingType, primaryModel: c.primaryModel, backupModel: c.backupModel,
    rpmLimit: c.rpmLimit, status: c.status, probeEnabled: c.probeEnabled,
    probeIntervalSec: c.probeIntervalSec, lastTestOk: c.lastTestOk, lastTestAt: iso(c.lastTestAt),
    models: modelsList, stats: statsRow === undefined ? null : channelStatsView(statsRow),
    latestReport,
    createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
  };
}

async function loadMerchantChannelModels(db: import('@hub/db').Database, channelIds: number[]): Promise<Map<number, MerchantChannelModel[]>> {
  const map = new Map<number, MerchantChannelModel[]>();
  if (channelIds.length === 0) return map;
  const rows = await db
    .select({ cm: channelModels, modelSlug: models.slug, displayName: models.displayName })
    .from(channelModels)
    .leftJoin(models, eq(channelModels.modelId, models.id))
    .where(inArray(channelModels.channelId, channelIds))
    .orderBy(asc(channelModels.id));
  for (const r of rows) {
    const list = map.get(r.cm.channelId) ?? [];
    list.push({
      id: r.cm.id,
      upstreamName: r.cm.upstreamName,
      modelSlug: r.modelSlug ?? null,
      displayName: r.displayName ?? null,
      priceOverrideInput: r.cm.priceOverrideInput,
      priceOverrideOutput: r.cm.priceOverrideOutput,
      lastStatus: r.cm.lastStatus,
      lastLatencyMs: r.cm.lastLatencyMs,
      lastTestedAt: iso(r.cm.lastTestedAt),
      lastError: r.cm.lastError,
      trustScore: r.cm.trustScore,
      trustVerdict: r.cm.trustVerdict,
    });
    map.set(r.cm.channelId, list);
  }
  return map;
}

/** 校验站点归属，越权返回 404 */
async function ownSite(db: import('@hub/db').Database, siteId: number, ownerId: string) {
  const s = (await db.select().from(sites).where(eq(sites.id, siteId)).limit(1))[0];
  if (!s || s.ownerId !== ownerId) throw notFound('站点不存在');
  return s;
}

/** raw SQL 的 snake_case 报告行 → reportView 期望的 camelCase 输入 */
function rawToReport(r: {
  id: number; channel_id: number; model: string; protocol: string;
  score: number | null; verdict: string; checks: unknown; duration_ms: number | null;
  trigger: string; created_at: string;
}) {
  return {
    id: r.id, channelId: r.channel_id, model: r.model, protocol: r.protocol,
    score: r.score, verdict: r.verdict, checks: r.checks,
    durationMs: r.duration_ms, trigger: r.trigger, createdAt: new Date(r.created_at),
  };
}

async function ownChannel(db: import('@hub/db').Database, channelId: number, ownerId: string) {
  const rows = await db.select({ c: channels, s: sites }).from(channels)
    .innerJoin(sites, eq(channels.siteId, sites.id))
    .where(eq(channels.id, channelId)).limit(1);
  const row = rows[0];
  if (!row || row.s.ownerId !== ownerId) throw notFound('渠道不存在');
  return row;
}


export async function merchantRoutes(app: FastifyInstance) {
  const db = app.db;

  // ---------- GET /merchant/overview ----------
  app.get('/api/v1/merchant/overview', async (req): Promise<MerchantOverview> => {
    const user = await app.requireAuth(req);
    const mySites = await db.select().from(sites).where(eq(sites.ownerId, user.id));
    const siteIds = mySites.map((s) => s.id);
    const siteName = new Map(mySites.map((s) => [s.id, s.name]));

    const myChannels = siteIds.length
      ? await db.select().from(channels).where(inArray(channels.siteId, siteIds))
      : [];
    const channelIds = myChannels.map((c) => c.id);
    const statsRows = channelIds.length
      ? await db.select().from((await import('@hub/db')).channelStats).where(inArray((await import('@hub/db')).channelStats.channelId, channelIds))
      : [];
    const statsMap = new Map(statsRows.map((r) => [r.channelId, r]));

    // 告警：invalid 渠道、连续失败 ≥3、可信分 < 50
    const alerts: MerchantOverview['alerts'] = [];
    for (const c of myChannels) {
      const st = statsMap.get(c.id);
      if (c.status === 'invalid') {
        alerts.push({ channelId: c.id, channelName: c.name, siteName: siteName.get(c.siteId) ?? '', type: 'invalid', message: '渠道连续失败次数过多，已被标记为不可用', at: iso(c.updatedAt) ?? '' });
      } else if (st && st.consecutiveFailures >= 3) {
        alerts.push({ channelId: c.id, channelName: c.name, siteName: siteName.get(c.siteId) ?? '', type: 'down', message: `渠道连续探测失败 ${st.consecutiveFailures} 次`, at: iso(st.lastFailureAt) ?? '' });
      }
      if (st && st.trustScore !== null && st.trustScore < 50) {
        alerts.push({ channelId: c.id, channelName: c.name, siteName: siteName.get(c.siteId) ?? '', type: 'trust_low', message: `主测模型可信分偏低（${st.trustScore}）`, at: iso(st.updatedAt) ?? '' });
      }
    }

    const uptimes = statsRows.map((r) => r.uptime24h).filter((x): x is number => x !== null);
    return {
      siteCount: mySites.length,
      approvedSiteCount: mySites.filter((s) => s.status === 'approved').length,
      pendingSiteCount: mySites.filter((s) => s.status === 'pending').length,
      channelCount: myChannels.length,
      activeChannelCount: myChannels.filter((c) => c.status === 'active').length,
      avgUptime24h: uptimes.length ? uptimes.reduce((a, b) => a + b, 0) / uptimes.length : null,
      alerts: alerts.slice(0, 20),
      channels: myChannels.map((c) => ({
        id: c.id, name: c.name, siteId: c.siteId, siteName: siteName.get(c.siteId) ?? '',
        status: c.status, stats: statsMap.has(c.id) ? channelStatsView(statsMap.get(c.id)) : null,
      })),
    };
  });

  // ---------- 站点 CRUD ----------
  app.get('/api/v1/merchant/sites', async (req): Promise<MerchantSite[]> => {
    const user = await app.requireAuth(req);
    const mySites = await db.select().from(sites).where(eq(sites.ownerId, user.id)).orderBy(desc(sites.createdAt));
    if (mySites.length === 0) return [];
    const siteIds = mySites.map((s) => s.id);
    const channelCounts = await db.execute<Record<string, unknown>>(sql`
      SELECT site_id, count(*)::int AS cnt FROM channels
      WHERE site_id IN (${sql.join(siteIds.map((id) => sql`${id}`), sql`, `)}) GROUP BY site_id`);
    const countMap = new Map(channelCounts.map((r) => [r['site_id'] as number, r['cnt'] as number]));
    const statsRows = await db.select().from(siteStats).where(inArray(siteStats.siteId, siteIds));
    const statsMap = new Map(statsRows.map((r) => [r.siteId, r]));
    return mySites.map((s) => siteToMerchant(s, countMap.get(s.id) ?? 0, statsMap.get(s.id)));
  });

  app.post('/api/v1/merchant/sites', async (req, reply): Promise<MerchantSite> => {
    const user = await app.requireAuth(req);
    const input = siteInputSchema.parse(req.body);
    const slug = input.slug ?? slugify(input.name);
    const dup = await db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug)).limit(1);
    if (dup[0]) throw new HttpError(409, 'slug_taken', '该站点标识（slug）已被使用');
    const [s] = await db.insert(sites).values({
      ownerId: user.id, slug, name: input.name, homepageUrl: input.homepageUrl,
      inviteUrl: input.inviteUrl ?? null, logoUrl: input.logoUrl ?? null,
      description: input.description ?? null, type: input.type, rechargeRatio: input.rechargeRatio,
      contact: input.contact ?? {}, tags: input.tags ?? [], paymentMethods: input.paymentMethods ?? [],
      status: 'draft',
    }).returning();
    void reply.status(201);
    return siteToMerchant(s!, 0, undefined);
  });

  app.get('/api/v1/merchant/sites/:id', async (req): Promise<MerchantSiteDetail> => {
    const user = await app.requireAuth(req);
    const { id } = idParam.parse(req.params);
    const s = await ownSite(db, id, user.id);
    const chs = await db.select().from(channels).where(eq(channels.siteId, s.id)).orderBy(asc(channels.sortOrder), asc(channels.id));
    const channelIds = chs.map((c) => c.id);
    const modelsMap = await loadMerchantChannelModels(db, channelIds);
    const vendorIds = [...new Set(chs.map((c) => c.vendorId).filter((x): x is number => x !== null))];
    const vendorRows = vendorIds.length ? await db.select().from(vendors).where(inArray(vendors.id, vendorIds)) : [];
    const vendorMap = new Map(vendorRows.map((v) => [v.id, v]));
    const statsRows = channelIds.length
      ? await db.select().from((await import('@hub/db')).channelStats).where(inArray((await import('@hub/db')).channelStats.channelId, channelIds))
      : [];
    const statsMap = new Map(statsRows.map((r) => [r.channelId, r]));
    // 每渠道最新一条真伪报告：DISTINCT ON 在数据库中取（避免读全量历史到内存）
    interface RawReport extends Record<string, unknown> {
      id: number; channel_id: number; channel_model_id: number | null; task_id: number | null;
      model: string; protocol: string; score: number | null; verdict: string;
      checks: unknown; duration_ms: number | null; trigger: string; created_at: string;
    }
    const reportRows = channelIds.length
      ? await db.execute<RawReport>(sql`
          SELECT DISTINCT ON (channel_id)
            id, channel_id, channel_model_id, task_id, model, protocol, score, verdict,
            checks, duration_ms, trigger, created_at
          FROM authenticity_reports
          WHERE channel_id IN (${sql.join(channelIds.map((x) => sql`${x}`), sql`, `)})
          ORDER BY channel_id, created_at DESC, id DESC`)
      : [];
    const reportMap = new Map<number, RawReport>(reportRows.map((r) => [r.channel_id, r]));

    const siteStatRow = (await db.select().from(siteStats).where(eq(siteStats.siteId, s.id)).limit(1))[0];
    return {
      ...siteToMerchant(s, chs.length, siteStatRow),
      channels: chs.map((c) => channelToMerchant(
        c,
        c.vendorId !== null ? vendorMap.get(c.vendorId) ?? null : null,
        s.rechargeRatio,
        modelsMap.get(c.id) ?? [],
        statsMap.get(c.id) ?? null,
        reportMap.has(c.id) ? reportView(rawToReport(reportMap.get(c.id)!)) : null,
      )),
    };
  });

  app.patch('/api/v1/merchant/sites/:id', async (req): Promise<MerchantSite> => {
    const user = await app.requireAuth(req);
    const { id } = idParam.parse(req.params);
    const s = await ownSite(db, id, user.id);
    const input = siteInputSchema.partial().parse(req.body);
    if (input.slug && input.slug !== s.slug) {
      const dup = await db.select({ id: sites.id }).from(sites).where(eq(sites.slug, input.slug)).limit(1);
      if (dup[0]) throw new HttpError(409, 'slug_taken', '该站点标识（slug）已被使用');
    }
    const [updated] = await db.update(sites).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.homepageUrl !== undefined ? { homepageUrl: input.homepageUrl } : {}),
      ...(input.inviteUrl !== undefined ? { inviteUrl: input.inviteUrl } : {}),
      ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.rechargeRatio !== undefined ? { rechargeRatio: input.rechargeRatio } : {}),
      ...(input.contact !== undefined ? { contact: input.contact } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.paymentMethods !== undefined ? { paymentMethods: input.paymentMethods } : {}),
      updatedAt: new Date(),
    }).where(eq(sites.id, s.id)).returning();
    const cc = await db.select({ c: count() }).from(channels).where(eq(channels.siteId, s.id));
    const st = (await db.select().from(siteStats).where(eq(siteStats.siteId, s.id)).limit(1))[0];
    return siteToMerchant(updated!, cc[0]?.c ?? 0, st);
  });

  app.post('/api/v1/merchant/sites/:id/submit', async (req) => {
    const user = await app.requireAuth(req);
    const { id } = idParam.parse(req.params);
    const s = await ownSite(db, id, user.id);
    if (s.status === 'pending') throw badRequest('站点已在审核中');
    if (s.status === 'approved') throw badRequest('站点已上线，无需重复提交');
    if (s.status === 'suspended') throw forbidden('站点已被下架，请联系管理员');

    const chs = await db.select().from(channels).where(eq(channels.siteId, s.id));
    if (chs.length === 0) throw badRequest('请先添加至少一个渠道');
    if (!chs.some((c) => c.lastTestOk === true)) throw badRequest('至少需要一个渠道连接测试通过后才能提交审核');

    await db.update(sites).set({ status: 'pending', submittedAt: new Date(), updatedAt: new Date() })
      .where(eq(sites.id, s.id));
    // 为所有渠道排队真伪检测（原子入队，复用已有活动任务）
    for (const c of chs) {
      await enqueueProbeTask(db, { channelId: c.id, kind: 'authenticity', trigger: 'onboarding', requestedBy: user.id });
    }
    return { ok: true };
  });

  app.delete('/api/v1/merchant/sites/:id', async (req) => {
    const user = await app.requireAuth(req);
    const { id } = idParam.parse(req.params);
    const s = await ownSite(db, id, user.id);
    if (s.status !== 'draft' && s.status !== 'rejected') {
      throw badRequest('只能删除草稿或被驳回的站点');
    }
    await db.delete(sites).where(eq(sites.id, s.id));
    return { ok: true };
  });

  // ---------- 渠道 CRUD ----------
  app.post('/api/v1/merchant/sites/:id/channels', async (req, reply): Promise<MerchantChannel> => {
    const user = await app.requireAuth(req);
    const { id } = idParam.parse(req.params);
    const s = await ownSite(db, id, user.id);
    if (s.status === 'approved' || s.status === 'pending' || s.status === 'suspended') {
      throw badRequest('该状态下不能新增渠道；如需调整请先下架或联系管理员');
    }
    const input = channelInputSchema.parse(req.body);
    if (!input.apiKey) throw badRequest('新建渠道必须提供检测用 API Key');

    const vendorRow = input.vendorSlug
      ? (await db.select().from(vendors).where(eq(vendors.slug, input.vendorSlug)).limit(1))[0] ?? null
      : null;

    const [c] = await db.insert(channels).values({
      siteId: s.id, name: input.name, description: input.description ?? null,
      vendorId: vendorRow?.id ?? null, protocol: input.protocol, baseUrl: input.baseUrl.replace(/\/$/, ''),
      apiKeyEnc: encryptSecret(input.apiKey), apiKeyMask: maskSecret(input.apiKey),
      groupRatio: input.groupRatio, billingType: input.billingType ?? 'per_token',
      primaryModel: input.primaryModel, backupModel: input.backupModel ?? null,
      rpmLimit: input.rpmLimit ?? null, status: 'active',
    }).returning();

    // 声明模型列表 → channel_models
    if (input.declaredModels && input.declaredModels.length > 0) {
      const catalog = await db.select({ id: models.id, slug: models.slug, aliases: models.aliases }).from(models).where(eq(models.isActive, true));
      const probe = await import('@hub/probe');
      for (const name of input.declaredModels) {
        let modelId: number | null = null;
        try { modelId = probe.matchCatalogModel(name, catalog); } catch { /* probe 未实现时跳过映射 */ }
        await db.insert(channelModels).values({ channelId: c!.id, upstreamName: name, modelId })
          .onConflictDoNothing();
      }
    }
    void reply.status(201);
    return channelToMerchant(c!, vendorRow, s.rechargeRatio, [], null, null);
  });

  app.patch('/api/v1/merchant/channels/:id', async (req): Promise<MerchantChannel> => {
    const user = await app.requireAuth(req);
    const { id } = idParam.parse(req.params);
    const { c, s } = await ownChannel(db, id, user.id);
    const input = channelInputSchema.partial().parse(req.body);

    // Key 真实变化检测：解密旧 Key 比较，避免同 Key 重复入队
    let keyActuallyChanged = false;
    if (input.apiKey) {
      const oldPlain = decryptSecret(c.apiKeyEnc);
      keyActuallyChanged = input.apiKey !== oldPlain;
    }
    // 关键配置（影响连接有效性）变化：apiKey/baseUrl/protocol/primaryModel
    const connectionChanged = keyActuallyChanged
      || (input.baseUrl !== undefined && input.baseUrl.replace(/\/$/, '') !== c.baseUrl)
      || (input.protocol !== undefined && input.protocol !== c.protocol)
      || (input.primaryModel !== undefined && input.primaryModel !== c.primaryModel);

    const vendorRow = input.vendorSlug !== undefined
      ? (input.vendorSlug ? (await db.select().from(vendors).where(eq(vendors.slug, input.vendorSlug)).limit(1))[0] ?? null : null)
      : (c.vendorId !== null ? (await db.select().from(vendors).where(eq(vendors.id, c.vendorId)).limit(1))[0] ?? null : null);

    const [updated] = await db.update(channels).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.vendorSlug !== undefined ? { vendorId: vendorRow?.id ?? null } : {}),
      ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.replace(/\/$/, '') } : {}),
      ...(input.apiKey ? { apiKeyEnc: encryptSecret(input.apiKey), apiKeyMask: maskSecret(input.apiKey) } : {}),
      ...(input.groupRatio !== undefined ? { groupRatio: input.groupRatio } : {}),
      ...(input.billingType !== undefined ? { billingType: input.billingType } : {}),
      ...(input.primaryModel !== undefined ? { primaryModel: input.primaryModel } : {}),
      ...(input.backupModel !== undefined ? { backupModel: input.backupModel } : {}),
      ...(input.rpmLimit !== undefined ? { rpmLimit: input.rpmLimit } : {}),
      // 连接配置变化后，旧的测试成功记录不再有效，避免沿用到错误配置
      ...(connectionChanged ? { lastTestOk: null, lastTestAt: null } : {}),
      updatedAt: new Date(),
    }).where(eq(channels.id, c.id)).returning();

    // 连接相关字段变化 → 原子入队检测任务（倍率变化不触发）
    if (connectionChanged && s.status === 'approved') {
      await enqueueProbeTask(db, { channelId: c.id, kind: 'authenticity', trigger: 'merchant', requestedBy: user.id });
    }

    const modelsMap = await loadMerchantChannelModels(db, [c.id]);
    const statsRow = (await db.select().from((await import('@hub/db')).channelStats)
      .where(eq((await import('@hub/db')).channelStats.channelId, c.id)).limit(1))[0];
    const report = (await db.select().from(authenticityReports).where(eq(authenticityReports.channelId, c.id))
      .orderBy(desc(authenticityReports.createdAt)).limit(1))[0];
    return channelToMerchant(updated!, vendorRow, s.rechargeRatio, modelsMap.get(c.id) ?? [], statsRow ?? null, report ? reportView(report) : null);
  });

  app.delete('/api/v1/merchant/channels/:id', async (req) => {
    const user = await app.requireAuth(req);
    const { id } = idParam.parse(req.params);
    const { c, s } = await ownChannel(db, id, user.id);
    if (s.status === 'approved') throw badRequest('已上线站点的渠道请先将站点下架或联系管理员');
    await db.delete(channels).where(eq(channels.id, c.id));
    return { ok: true };
  });

  // ---------- 连接测试 ----------
  app.post('/api/v1/merchant/channels/:id/test', async (req): Promise<ProbeResult> => {
    const user = await app.requireAuth(req);
    const { id } = idParam.parse(req.params);
    const body = z.object({ model: z.string().max(200).optional() }).parse(req.body ?? {});
    const { c } = await ownChannel(db, id, user.id);
    const model = body.model ?? c.primaryModel;
    const plainKey = decryptSecret(c.apiKeyEnc);

    const probe = await import('@hub/probe');
    let result: ProbeResult;
    try {
      result = await probe.probeAvailability({
        baseUrl: c.baseUrl, apiKey: plainKey, protocol: c.protocol, model,
      });
    } catch (err) {
      if (isProbeNotImplemented(err)) throw probeUnavailable();
      throw err;
    }

    const cm = (await db.select({ id: channelModels.id }).from(channelModels)
      .where(and(eq(channelModels.channelId, c.id), eq(channelModels.upstreamName, model))).limit(1))[0];
    await db.insert(probeRuns).values({
      channelId: c.id, channelModelId: cm?.id ?? null, model, protocol: c.protocol,
      kind: 'availability', trigger: 'merchant', success: result.success,
      httpStatus: result.httpStatus, errorCode: result.errorCode,
      // 防御纵深：持久化前用真实 Key 精确替换（上游可能回显 Key）
      errorMessage: sanitizeKeyFromText(result.errorMessage, plainKey),
      latencyMs: result.latencyMs, ttftMs: result.ttftMs, inputTokens: result.inputTokens,
      outputTokens: result.outputTokens, tokensPerSec: result.tokensPerSec,
    });
    await db.update(channels).set({ lastTestOk: result.success, lastTestAt: new Date() })
      .where(eq(channels.id, c.id));
    // 返回给站长的 sample 也做 Key 脱敏
    return { ...result, errorMessage: sanitizeKeyFromText(result.errorMessage, plainKey), sample: sanitizeKeyFromText(result.sample, plainKey) };
  });

  // ---------- 获取上游模型列表并回填 ----------
  app.post('/api/v1/merchant/channels/:id/discover', async (req): Promise<MerchantChannelModel[]> => {
    const user = await app.requireAuth(req);
    const { id } = idParam.parse(req.params);
    const { c } = await ownChannel(db, id, user.id);
    const probe = await import('@hub/probe');
    let list;
    try {
      list = await probe.listUpstreamModels({
        baseUrl: c.baseUrl, apiKey: decryptSecret(c.apiKeyEnc), protocol: c.protocol,
      });
    } catch (err) {
      if (isProbeNotImplemented(err)) throw probeUnavailable();
      throw err;
    }
    if (!list.ok) throw badRequest(`获取模型列表失败：${list.errorMessage ?? list.errorCode ?? '未知错误'}`);

    const catalog = await db.select({ id: models.id, slug: models.slug, aliases: models.aliases }).from(models).where(eq(models.isActive, true));
    for (const name of list.models) {
      let modelId: number | null = null;
      try { modelId = probe.matchCatalogModel(name, catalog); } catch { modelId = null; }
      await db.insert(channelModels).values({ channelId: c.id, upstreamName: name, modelId })
        .onConflictDoNothing({ target: [channelModels.channelId, channelModels.upstreamName] });
    }
    const map = await loadMerchantChannelModels(db, [c.id]);
    return map.get(c.id) ?? [];
  });

  // ---------- 批量设置渠道模型 ----------
  app.put('/api/v1/merchant/channels/:id/models', async (req): Promise<MerchantChannelModel[]> => {
    const user = await app.requireAuth(req);
    const { id } = idParam.parse(req.params);
    const { c } = await ownChannel(db, id, user.id);
    const input = z.object({
      models: z.array(z.object({
        upstreamName: z.string().min(1).max(200),
        modelSlug: z.string().max(100).nullish(),
        priceOverrideInput: z.number().nonnegative().nullish(),
        priceOverrideOutput: z.number().nonnegative().nullish(),
      })).max(200),
    } satisfies Record<keyof ChannelModelsInput, z.ZodTypeAny>).parse(req.body);

    const catalog = await db.select({ id: models.id, slug: models.slug, aliases: models.aliases }).from(models).where(eq(models.isActive, true));
    const slugToId = new Map(catalog.map((m) => [m.slug, m.id]));

    // 按 upstreamName upsert：保留已有行的探测状态/可信分/id；仅删除不再声明的行
    const keepNames = input.models.map((m) => m.upstreamName);
    if (keepNames.length > 0) {
      await db.delete(channelModels).where(and(
        eq(channelModels.channelId, c.id),
        sql`${channelModels.upstreamName} NOT IN (${sql.join(keepNames.map((n) => sql`${n}`), sql`, `)})`,
      ));
    } else {
      await db.delete(channelModels).where(eq(channelModels.channelId, c.id));
    }
    const probe = await import('@hub/probe');
    for (const m of input.models) {
      let modelId: number | null = m.modelSlug ? slugToId.get(m.modelSlug) ?? null : null;
      if (modelId === null) {
        try { modelId = probe.matchCatalogModel(m.upstreamName, catalog); } catch { modelId = null; }
      }
      await db.insert(channelModels).values({
        channelId: c.id, upstreamName: m.upstreamName, modelId,
        priceOverrideInput: m.priceOverrideInput ?? null,
        priceOverrideOutput: m.priceOverrideOutput ?? null,
      }).onConflictDoUpdate({
        target: [channelModels.channelId, channelModels.upstreamName],
        set: {
          modelId,
          priceOverrideInput: m.priceOverrideInput ?? null,
          priceOverrideOutput: m.priceOverrideOutput ?? null,
        },
      });
    }
    const map = await loadMerchantChannelModels(db, [c.id]);
    return map.get(c.id) ?? [];
  });

  // ---------- 手动真伪检测（原子入队，同事务检查每日额度 + 复用活动任务） ----------
  app.post('/api/v1/merchant/channels/:id/authenticity', async (req, reply): Promise<ProbeTask> => {
    const user = await app.requireAuth(req);
    const { id } = idParam.parse(req.params);
    const body = z.object({ models: z.array(z.string().max(200)).max(20).optional() }).parse(req.body ?? {});
    const { c } = await ownChannel(db, id, user.id);

    const { task, reused } = await enqueueProbeTask(db, {
      channelId: c.id, kind: 'authenticity', trigger: 'merchant',
      payload: { models: body.models }, requestedBy: user.id,
      checkMerchantDailyLimit: true,
    });
    void reply.status(reused ? 200 : 202);
    return task;
  });

  // ---------- 任务状态 ----------
  app.get('/api/v1/merchant/tasks/:id', async (req): Promise<ProbeTask> => {
    const user = await app.requireAuth(req);
    const { id } = idParam.parse(req.params);
    const rows = await db.select({ t: probeTasks, s: sites }).from(probeTasks)
      .innerJoin(channels, eq(probeTasks.channelId, channels.id))
      .innerJoin(sites, eq(channels.siteId, sites.id))
      .where(eq(probeTasks.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.s.ownerId !== user.id) throw notFound('任务不存在');
    return taskView(row.t);
  });

  // ---------- 探测日志 ----------
  app.get('/api/v1/merchant/channels/:id/runs', async (req): Promise<Paginated<ProbeRun>> => {
    const user = await app.requireAuth(req);
    const { id } = idParam.parse(req.params);
    const q = pageQuery.parse(req.query);
    const { c } = await ownChannel(db, id, user.id);
    const where = eq(probeRuns.channelId, c.id);
    const total = (await db.select({ c: count() }).from(probeRuns).where(where))[0]?.c ?? 0;
    const rows = await db.select().from(probeRuns).where(where)
      .orderBy(desc(probeRuns.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return { items: rows.map((r) => probeRunView(r)), total, page: q.page, pageSize: q.pageSize };
  });
}
