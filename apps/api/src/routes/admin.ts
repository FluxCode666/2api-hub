/*
 * 管理后台接口（SPEC §7.5）。全部需 admin 角色。关键操作写审计日志。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import {
  announcements, auditLogs, authenticityReports, channelModels, channels, channelStats,
  feedback, models, notifications, probeRuns, probeTasks, reviews, sites, siteStats, users, vendors,
} from '@hub/db';
import type {
  AdminModel, AdminOverview, AdminReview, AdminSite, AdminSiteDetail, AdminUser, AdminVendor,
  Announcement, AuditLog, FeedbackItem, ModelInput, Paginated, ProbeRun, ProbeTask,
  SessionUser, SettingsMap, SiteReviewAction, VendorInput,
} from '@hub/shared';
import { DEFAULT_SETTINGS } from '@hub/shared';
import { badRequest, notFound, HttpError } from '../lib/errors';
import { httpUrl } from '../lib/url';
import { iso, probeRunView, reportView, siteStatsView, taskView, vendorRef, channelStatsView } from '../lib/serialize';
import { loadMerchantChannelModelsFor } from '../lib/merchant-helpers';
import { enqueueProbeTask } from '../lib/enqueue';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

async function audit(
  db: import('@hub/db').Database,
  actor: SessionUser | null,
  action: string,
  targetType: string,
  targetId: string | number,
  meta: Record<string, unknown> = {},
  ip?: string,
) {
  await db.insert(auditLogs).values({
    actorId: actor?.id ?? null, action, targetType, targetId: String(targetId), meta, ip: ip ?? null,
  });
}

async function notify(db: import('@hub/db').Database, userId: string, type: string, title: string, body?: string, link?: string) {
  await db.insert(notifications).values({ userId, type, title, body: body ?? null, link: link ?? null });
}

function adminSiteView(s: typeof sites.$inferSelect, owner: { id: string; email: string; nickname: string }, channelCount: number, stats: typeof siteStats.$inferSelect | undefined): AdminSite {
  return {
    id: s.id, slug: s.slug, name: s.name, homepageUrl: s.homepageUrl, inviteUrl: s.inviteUrl,
    logoUrl: s.logoUrl, description: s.description, type: s.type, rechargeRatio: s.rechargeRatio,
    contact: s.contact, tags: s.tags, paymentMethods: s.paymentMethods, status: s.status,
    reviewNote: s.reviewNote, submittedAt: iso(s.submittedAt), approvedAt: iso(s.approvedAt),
    isVerified: s.isVerified, isFeatured: s.isFeatured, channelCount,
    stats: stats ? siteStatsView(stats) : null,
    createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString(),
    owner, sortWeight: s.sortWeight, clickCount: s.clickCount,
  };
}

export async function adminRoutes(app: FastifyInstance) {
  const db = app.db;

  // ---------- 总览 ----------
  app.get('/api/v1/admin/overview', async (req): Promise<AdminOverview> => {
    await app.requireRole(req, 'admin');
    const [pending, siteCounts, channelCounts, userCounts, probes, queue] = await Promise.all([
      db.select({ c: count() }).from(sites).where(eq(sites.status, 'pending')),
      db.execute<Record<string, unknown>>(sql`SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status='approved')::int AS approved,
        count(*) FILTER (WHERE status='suspended')::int AS suspended FROM sites`),
      db.execute<Record<string, unknown>>(sql`SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status='active')::int AS active,
        count(*) FILTER (WHERE status='invalid')::int AS invalid FROM channels`),
      db.execute<Record<string, unknown>>(sql`SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE role='merchant')::int AS merchants FROM users`),
      db.execute<Record<string, unknown>>(sql`SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE NOT success)::int AS failed
        FROM probe_runs WHERE created_at > now() - interval '24 hours'`),
      db.execute<Record<string, unknown>>(sql`SELECT
        count(*) FILTER (WHERE status='queued')::int AS queued,
        count(*) FILTER (WHERE status='running')::int AS running FROM probe_tasks`),
    ]);
    const recentFailures = await db
      .select({ r: probeRuns, siteName: sites.name, channelName: channels.name })
      .from(probeRuns)
      .innerJoin(channels, eq(probeRuns.channelId, channels.id))
      .innerJoin(sites, eq(channels.siteId, sites.id))
      .where(eq(probeRuns.success, false))
      .orderBy(desc(probeRuns.createdAt)).limit(10);
    const sc = siteCounts[0] ?? {}; const cc = channelCounts[0] ?? {}; const uc = userCounts[0] ?? {};
    const pr = probes[0] ?? {}; const qu = queue[0] ?? {};
    return {
      pendingSites: pending[0]?.c ?? 0,
      sites: { total: Number(sc['total'] ?? 0), approved: Number(sc['approved'] ?? 0), suspended: Number(sc['suspended'] ?? 0) },
      channels: { total: Number(cc['total'] ?? 0), active: Number(cc['active'] ?? 0), invalid: Number(cc['invalid'] ?? 0) },
      users: { total: Number(uc['total'] ?? 0), merchants: Number(uc['merchants'] ?? 0) },
      probes24h: { total: Number(pr['total'] ?? 0), failed: Number(pr['failed'] ?? 0) },
      queue: { queued: Number(qu['queued'] ?? 0), running: Number(qu['running'] ?? 0) },
      recentFailures: recentFailures.map(({ r, siteName, channelName }) => ({
        ...probeRunView(r), siteName, channelName,
      })),
    };
  });

  // ---------- 站点管理 ----------
  app.get('/api/v1/admin/sites', async (req): Promise<Paginated<AdminSite>> => {
    await app.requireRole(req, 'admin');
    const q = pageQuery.extend({
      status: z.enum(['draft', 'pending', 'approved', 'rejected', 'suspended']).optional(),
      q: z.string().optional(),
    }).parse(req.query);
    const conds = [];
    if (q.status) conds.push(eq(sites.status, q.status));
    if (q.q) conds.push(or(ilike(sites.name, `%${q.q}%`), ilike(sites.slug, `%${q.q}%`))!);
    const where = conds.length ? and(...conds) : undefined;
    const total = (await db.select({ c: count() }).from(sites).where(where))[0]?.c ?? 0;
    const rows = await db.select({ s: sites, o: users }).from(sites)
      .innerJoin(users, eq(sites.ownerId, users.id))
      .where(where).orderBy(desc(sites.submittedAt), desc(sites.createdAt))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    const siteIds = rows.map((r) => r.s.id);
    const ccRows = siteIds.length ? await db.execute<Record<string, unknown>>(sql`
      SELECT site_id, count(*)::int AS cnt FROM channels
      WHERE site_id IN (${sql.join(siteIds.map((x) => sql`${x}`), sql`, `)}) GROUP BY site_id`) : [];
    const ccMap = new Map(ccRows.map((r) => [r['site_id'] as number, r['cnt'] as number]));
    const statsRows = siteIds.length ? await db.select().from(siteStats).where(inArray(siteStats.siteId, siteIds)) : [];
    const statsMap = new Map(statsRows.map((r) => [r.siteId, r]));
    return {
      items: rows.map(({ s, o }) => adminSiteView(s, { id: o.id, email: o.email, nickname: o.nickname }, ccMap.get(s.id) ?? 0, statsMap.get(s.id))),
      total, page: q.page, pageSize: q.pageSize,
    };
  });

  app.get('/api/v1/admin/sites/:id', async (req): Promise<AdminSiteDetail> => {
    await app.requireRole(req, 'admin');
    const { id } = idParam.parse(req.params);
    const rows = await db.select({ s: sites, o: users }).from(sites)
      .innerJoin(users, eq(sites.ownerId, users.id)).where(eq(sites.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound('站点不存在');
    const chs = await db.select().from(channels).where(eq(channels.siteId, id)).orderBy(asc(channels.id));
    const channelIds = chs.map((c) => c.id);
    const modelsMap = await loadMerchantChannelModelsFor(db, channelIds);
    const vendorRows = await db.select().from(vendors);
    const vendorMap = new Map(vendorRows.map((v) => [v.id, v]));
    const statsRows = channelIds.length
      ? await db.select().from(channelStats).where(inArray(channelStats.channelId, channelIds)) : [];
    const statsMap = new Map(statsRows.map((r) => [r.channelId, r]));
    const reportRows = await db.select().from(authenticityReports)
      .where(channelIds.length ? inArray(authenticityReports.channelId, channelIds) : sql`false`)
      .orderBy(desc(authenticityReports.createdAt)).limit(20);
    const latestByChannel = new Map<number, typeof authenticityReports.$inferSelect>();
    for (const r of reportRows) if (!latestByChannel.has(r.channelId)) latestByChannel.set(r.channelId, r);
    const st = (await db.select().from(siteStats).where(eq(siteStats.siteId, id)).limit(1))[0];
    return {
      ...adminSiteView(row.s, { id: row.o.id, email: row.o.email, nickname: row.o.nickname }, chs.length, st),
      channels: chs.map((c) => ({
        id: c.id, siteId: c.siteId, name: c.name, description: c.description,
        vendor: c.vendorId !== null ? vendorRef(vendorMap.get(c.vendorId)!) : null,
        protocol: c.protocol, baseUrl: c.baseUrl, apiKeyMask: c.apiKeyMask,
        groupRatio: c.groupRatio,
        actualRatio: row.s.rechargeRatio > 0 ? Math.round((c.groupRatio / row.s.rechargeRatio) * 10000) / 10000 : c.groupRatio,
        billingType: c.billingType, primaryModel: c.primaryModel, backupModel: c.backupModel,
        rpmLimit: c.rpmLimit, status: c.status, probeEnabled: c.probeEnabled,
        probeIntervalSec: c.probeIntervalSec, lastTestOk: c.lastTestOk, lastTestAt: iso(c.lastTestAt),
        models: modelsMap.get(c.id) ?? [],
        stats: statsMap.has(c.id) ? channelStatsView(statsMap.get(c.id)!) : null,
        latestReport: latestByChannel.has(c.id) ? reportView(latestByChannel.get(c.id)!) : null,
        createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
      })),
      reports: reportRows.map(reportView),
    };
  });

  // 审核：approve / reject / suspend / restore
  app.post('/api/v1/admin/sites/:id/review', async (req) => {
    const admin = await app.requireRole(req, 'admin');
    const { id } = idParam.parse(req.params);
    const input = z.object({
      action: z.enum(['approve', 'reject', 'suspend', 'restore']),
      reason: z.string().max(500).optional(),
    } satisfies Record<keyof SiteReviewAction, z.ZodTypeAny>).parse(req.body);

    const rows = await db.select({ s: sites, o: users }).from(sites)
      .innerJoin(users, eq(sites.ownerId, users.id)).where(eq(sites.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound('站点不存在');
    const { s, o } = row;

    switch (input.action) {
      case 'approve': {
        if (s.status !== 'pending') throw badRequest('只有审核中的站点可以通过');
        await db.update(sites).set({
          status: 'approved', approvedAt: new Date(), reviewedBy: admin.id,
          reviewNote: null, updatedAt: new Date(),
        }).where(eq(sites.id, s.id));
        // 首个站点审核通过 → owner user → merchant
        if (o.role === 'user') {
          await db.update(users).set({ role: 'merchant', updatedAt: new Date() }).where(eq(users.id, o.id));
        }
        await notify(db, o.id, 'site_approved', `站点「${s.name}」已通过审核`, '您的站点已上线，渠道将进入定时探测与榜单。', `/sites/${s.slug}`);
        await audit(db, admin, 'site.approve', 'site', s.id, { name: s.name }, req.ip);
        break;
      }
      case 'reject': {
        if (s.status !== 'pending') throw badRequest('只有审核中的站点可以驳回');
        if (!input.reason) throw badRequest('驳回必须填写原因');
        await db.update(sites).set({
          status: 'rejected', reviewNote: input.reason, reviewedBy: admin.id, updatedAt: new Date(),
        }).where(eq(sites.id, s.id));
        await notify(db, o.id, 'site_rejected', `站点「${s.name}」审核未通过`, input.reason, '/merchant/sites');
        await audit(db, admin, 'site.reject', 'site', s.id, { name: s.name, reason: input.reason }, req.ip);
        break;
      }
      case 'suspend': {
        if (s.status !== 'approved') throw badRequest('只有已上线站点可以下架');
        await db.update(sites).set({
          status: 'suspended', reviewNote: input.reason ?? null, reviewedBy: admin.id, updatedAt: new Date(),
        }).where(eq(sites.id, s.id));
        await notify(db, o.id, 'site_suspended', `站点「${s.name}」已被下架`, input.reason ?? undefined, '/merchant/sites');
        await audit(db, admin, 'site.suspend', 'site', s.id, { name: s.name, reason: input.reason }, req.ip);
        break;
      }
      case 'restore': {
        if (s.status !== 'suspended') throw badRequest('只有已下架站点可以恢复');
        await db.update(sites).set({
          status: 'approved', reviewNote: null, reviewedBy: admin.id, updatedAt: new Date(),
        }).where(eq(sites.id, s.id));
        await notify(db, o.id, 'site_restored', `站点「${s.name}」已恢复上线`, undefined, `/sites/${s.slug}`);
        await audit(db, admin, 'site.restore', 'site', s.id, { name: s.name }, req.ip);
        break;
      }
    }
    return { ok: true };
  });

  app.patch('/api/v1/admin/sites/:id', async (req) => {
    const admin = await app.requireRole(req, 'admin');
    const { id } = idParam.parse(req.params);
    const input = z.object({
      name: z.string().min(1).max(100).optional(),
      slug: z.string().regex(/^[a-z0-9-]+$/).max(100).optional(),
      homepageUrl: httpUrl().optional(),
      inviteUrl: httpUrl().nullish(),
      logoUrl: httpUrl().nullish(),
      description: z.string().max(2000).nullish(),
      type: z.enum(['new_api', 'sub2api', 'one_api', 'custom']).optional(),
      rechargeRatio: z.number().positive().max(1000).optional(),
      contact: z.object({
        qq: z.string().max(50).optional(),
        wechat: z.string().max(50).optional(),
        telegram: z.string().max(50).optional(),
        email: z.string().max(100).optional(),
        group: z.string().max(200).optional(),
      }).optional(),
      isFeatured: z.boolean().optional(),
      isVerified: z.boolean().optional(),
      sortWeight: z.number().int().optional(),
      tags: z.array(z.string().max(30)).max(10).optional(),
      paymentMethods: z.array(z.string().max(30)).max(10).optional(),
    }).parse(req.body);
    const s = (await db.select().from(sites).where(eq(sites.id, id)).limit(1))[0];
    if (!s) throw notFound('站点不存在');
    if (input.slug && input.slug !== s.slug) {
      const dup = await db.select({ id: sites.id }).from(sites).where(eq(sites.slug, input.slug)).limit(1);
      if (dup[0]) throw new HttpError(409, 'slug_taken', '该站点标识（slug）已被使用');
    }
    await db.update(sites).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.homepageUrl !== undefined ? { homepageUrl: input.homepageUrl } : {}),
      ...(input.inviteUrl !== undefined ? { inviteUrl: input.inviteUrl } : {}),
      ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.rechargeRatio !== undefined ? { rechargeRatio: input.rechargeRatio } : {}),
      ...(input.contact !== undefined ? { contact: input.contact } : {}),
      ...(input.isFeatured !== undefined ? { isFeatured: input.isFeatured } : {}),
      ...(input.isVerified !== undefined ? { isVerified: input.isVerified } : {}),
      ...(input.sortWeight !== undefined ? { sortWeight: input.sortWeight } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.paymentMethods !== undefined ? { paymentMethods: input.paymentMethods } : {}),
      updatedAt: new Date(),
    }).where(eq(sites.id, id));
    // 倍率变化不触发任何任务（SPEC §4.1.6：只有连接相关字段才排检测）
    await audit(db, admin, 'site.update', 'site', id, { fields: Object.keys(input) }, req.ip);
    return { ok: true };
  });

  // ---------- 渠道管理 ----------
  app.post('/api/v1/admin/channels/:id/probe', async (req, reply): Promise<ProbeTask> => {
    const admin = await app.requireRole(req, 'admin');
    const { id } = idParam.parse(req.params);
    const input = z.object({ kind: z.enum(['availability', 'authenticity', 'discovery']) }).parse(req.body);
    const c = (await db.select().from(channels).where(eq(channels.id, id)).limit(1))[0];
    if (!c) throw notFound('渠道不存在');
    const { task, reused } = await enqueueProbeTask(db, {
      channelId: c.id, kind: input.kind, trigger: 'admin', requestedBy: admin.id,
    });
    if (!task) throw new HttpError(429, 'rate_limited', '任务额度已满');
    void reply.status(reused ? 200 : 202);
    return task;
  });

  app.patch('/api/v1/admin/channels/:id', async (req) => {
    const admin = await app.requireRole(req, 'admin');
    const { id } = idParam.parse(req.params);
    const input = z.object({
      name: z.string().min(1).max(100).optional(),
      description: z.string().max(1000).nullish(),
      baseUrl: httpUrl().optional(),
      apiKey: z.string().min(8, 'API Key 长度至少 8 位').max(500).optional(),
      protocol: z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini']).optional(),
      primaryModel: z.string().min(1).max(200).optional(),
      backupModel: z.string().max(200).nullish(),
      billingType: z.enum(['per_token', 'per_request', 'subscription']).optional(),
      groupRatio: z.number().positive().max(1000).optional(),
      probeEnabled: z.boolean().optional(),
      probeIntervalSec: z.number().int().min(30).max(86400).optional(),
      status: z.enum(['active', 'paused', 'invalid']).optional(),
      rpmLimit: z.number().int().positive().nullish(),
      sortOrder: z.number().int().optional(),
    }).parse(req.body);
    const c = (await db.select().from(channels).where(eq(channels.id, id)).limit(1))[0];
    if (!c) throw notFound('渠道不存在');

    // 连接有效性关键字段变化 → 清除旧测试状态
    const connectionChanged = !!input.apiKey
      || (input.baseUrl !== undefined && input.baseUrl.replace(/\/$/, '') !== c.baseUrl)
      || (input.protocol !== undefined && input.protocol !== c.protocol)
      || (input.primaryModel !== undefined && input.primaryModel !== c.primaryModel);

    const { encryptSecret, maskSecret } = await import('@hub/db');
    await db.update(channels).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.replace(/\/$/, '') } : {}),
      ...(input.apiKey ? { apiKeyEnc: encryptSecret(input.apiKey), apiKeyMask: maskSecret(input.apiKey) } : {}),
      ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
      ...(input.primaryModel !== undefined ? { primaryModel: input.primaryModel } : {}),
      ...(input.backupModel !== undefined ? { backupModel: input.backupModel } : {}),
      ...(input.billingType !== undefined ? { billingType: input.billingType } : {}),
      ...(input.groupRatio !== undefined ? { groupRatio: input.groupRatio } : {}),
      ...(input.probeEnabled !== undefined ? { probeEnabled: input.probeEnabled } : {}),
      ...(input.probeIntervalSec !== undefined ? { probeIntervalSec: input.probeIntervalSec } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.rpmLimit !== undefined ? { rpmLimit: input.rpmLimit } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(connectionChanged ? { lastTestOk: null, lastTestAt: null } : {}),
      updatedAt: new Date(),
    }).where(eq(channels.id, id));
    // 连接相关字段变化 → 原子入队检测任务（倍率变化不触发）
    if (connectionChanged) {
      await enqueueProbeTask(db, { channelId: c.id, kind: 'authenticity', trigger: 'admin', requestedBy: admin.id });
    }
    await audit(db, admin, 'channel.update', 'channel', id, { fields: Object.keys(input).filter((k) => k !== 'apiKey') }, req.ip);
    return { ok: true };
  });

  // ---------- 厂商管理 ----------
  app.get('/api/v1/admin/vendors', async (req): Promise<AdminVendor[]> => {
    await app.requireRole(req, 'admin');
    const rows = await db.select().from(vendors).orderBy(asc(vendors.sortOrder));
    const modelCounts = await db.execute<Record<string, unknown>>(sql`
      SELECT vendor_id, count(*)::int AS cnt FROM models GROUP BY vendor_id`);
    const mcMap = new Map(modelCounts.map((r) => [r['vendor_id'] as number, r['cnt'] as number]));
    return rows.map((v) => ({
      id: v.id, ...vendorRef(v), modelCount: mcMap.get(v.id) ?? 0, channelCount: 0,
      website: v.website, description: v.description, sortOrder: v.sortOrder,
    }));
  });

  app.post('/api/v1/admin/vendors', async (req, reply) => {
    const admin = await app.requireRole(req, 'admin');
    const input = z.object({
      slug: z.string().regex(/^[a-z0-9-]+$/).max(50),
      name: z.string().min(1).max(100),
      nameZh: z.string().max(100).nullish(),
      color: z.string().max(20).optional(),
      iconUrl: httpUrl().nullish(),
      website: httpUrl().nullish(),
      description: z.string().max(2000).nullish(),
      sortOrder: z.number().int().optional(),
    } satisfies Record<keyof VendorInput, z.ZodTypeAny>).parse(req.body);
    const dup = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.slug, input.slug)).limit(1);
    if (dup[0]) throw new HttpError(409, 'slug_taken', '该厂商标识已存在');
    const [v] = await db.insert(vendors).values({
      slug: input.slug, name: input.name, nameZh: input.nameZh ?? null,
      color: input.color ?? '#888888', iconUrl: input.iconUrl ?? null,
      website: input.website ?? null, description: input.description ?? null,
      sortOrder: input.sortOrder ?? 0,
    }).returning();
    await audit(db, admin, 'vendor.create', 'vendor', v!.id, { slug: input.slug }, req.ip);
    void reply.status(201);
    return { id: v!.id, ...vendorRef(v!), modelCount: 0, channelCount: 0 };
  });

  app.patch('/api/v1/admin/vendors/:id', async (req) => {
    const admin = await app.requireRole(req, 'admin');
    const { id } = idParam.parse(req.params);
    const input = z.object({
      name: z.string().min(1).max(100).optional(),
      nameZh: z.string().max(100).nullish(),
      color: z.string().max(20).optional(),
      iconUrl: httpUrl().nullish(),
      website: httpUrl().nullish(),
      description: z.string().max(2000).nullish(),
      sortOrder: z.number().int().optional(),
    }).parse(req.body);
    const v = (await db.select().from(vendors).where(eq(vendors.id, id)).limit(1))[0];
    if (!v) throw notFound('厂商不存在');
    await db.update(vendors).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.nameZh !== undefined ? { nameZh: input.nameZh } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.iconUrl !== undefined ? { iconUrl: input.iconUrl } : {}),
      ...(input.website !== undefined ? { website: input.website } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    }).where(eq(vendors.id, id));
    await audit(db, admin, 'vendor.update', 'vendor', id, {}, req.ip);
    return { ok: true };
  });

  app.delete('/api/v1/admin/vendors/:id', async (req) => {
    const admin = await app.requireRole(req, 'admin');
    const { id } = idParam.parse(req.params);
    const used = await db.select({ c: count() }).from(models).where(eq(models.vendorId, id));
    if ((used[0]?.c ?? 0) > 0) throw badRequest('该厂商下仍有模型，不能删除');
    const deleted = await db.delete(vendors).where(eq(vendors.id, id)).returning({ id: vendors.id });
    if (!deleted[0]) throw notFound('厂商不存在');
    await audit(db, admin, 'vendor.delete', 'vendor', id, {}, req.ip);
    return { ok: true };
  });

  // ---------- 模型目录管理 ----------
  app.get('/api/v1/admin/models', async (req): Promise<Paginated<AdminModel>> => {
    await app.requireRole(req, 'admin');
    const q = pageQuery.extend({ vendor: z.string().optional(), q: z.string().optional() }).parse(req.query);
    const conds = [];
    if (q.vendor) {
      const v = (await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.slug, q.vendor)).limit(1))[0];
      if (!v) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
      conds.push(eq(models.vendorId, v.id));
    }
    if (q.q) conds.push(or(ilike(models.slug, `%${q.q}%`), ilike(models.displayName, `%${q.q}%`))!);
    const where = conds.length ? and(...conds) : undefined;
    const total = (await db.select({ c: count() }).from(models).where(where))[0]?.c ?? 0;
    const rows = await db.select({ m: models, v: vendors }).from(models)
      .innerJoin(vendors, eq(models.vendorId, vendors.id))
      .where(where).orderBy(asc(models.sortOrder))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return {
      items: rows.map(({ m, v }) => ({
        id: m.id, slug: m.slug, displayName: m.displayName, vendor: vendorRef(v),
        family: m.family, modality: m.modality, tier: m.tier,
        officialInputPrice: m.officialInputPrice, officialOutputPrice: m.officialOutputPrice,
        contextWindow: m.contextWindow, isFeatured: m.isFeatured,
        channelCount: 0, minInputPriceCny: null, bestUptime24h: null,
        aliases: m.aliases, defaultProtocol: m.defaultProtocol,
        knowledgeCutoff: m.knowledgeCutoff, releasedAt: m.releasedAt,
        description: m.description, expectedTps: m.expectedTps,
        isActive: m.isActive, sortOrder: m.sortOrder,
      })),
      total, page: q.page, pageSize: q.pageSize,
    };
  });

  app.post('/api/v1/admin/models', async (req, reply) => {
    const admin = await app.requireRole(req, 'admin');
    const input = z.object({
      slug: z.string().regex(/^[a-z0-9.-]+$/).max(100),
      displayName: z.string().min(1).max(100),
      vendorSlug: z.string().max(50),
      family: z.string().max(50).nullish(),
      modality: z.enum(['text', 'image', 'video', 'audio', 'embedding']).optional(),
      tier: z.enum(['flagship', 'standard', 'lite']).optional(),
      aliases: z.array(z.string().max(200)).max(50).optional(),
      defaultProtocol: z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini']).optional(),
      officialInputPrice: z.number().nonnegative().nullish(),
      officialOutputPrice: z.number().nonnegative().nullish(),
      contextWindow: z.number().int().positive().nullish(),
      knowledgeCutoff: z.string().max(10).nullish(),
      expectedTps: z.number().int().positive().nullish(),
      releasedAt: z.string().max(10).nullish(),
      description: z.string().max(2000).nullish(),
      isFeatured: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      isActive: z.boolean().optional(),
    } satisfies Record<keyof ModelInput, z.ZodTypeAny>).parse(req.body);
    const v = (await db.select().from(vendors).where(eq(vendors.slug, input.vendorSlug)).limit(1))[0];
    if (!v) throw badRequest('厂商不存在');
    const dup = await db.select({ id: models.id }).from(models).where(eq(models.slug, input.slug)).limit(1);
    if (dup[0]) throw new HttpError(409, 'slug_taken', '该模型标识已存在');
    const [m] = await db.insert(models).values({
      slug: input.slug, displayName: input.displayName, vendorId: v.id,
      family: input.family ?? null, modality: input.modality ?? 'text', tier: input.tier ?? 'standard',
      aliases: input.aliases ?? [input.slug], defaultProtocol: input.defaultProtocol ?? 'openai_chat',
      officialInputPrice: input.officialInputPrice ?? null, officialOutputPrice: input.officialOutputPrice ?? null,
      contextWindow: input.contextWindow ?? null, knowledgeCutoff: input.knowledgeCutoff ?? null,
      expectedTps: input.expectedTps ?? null, releasedAt: input.releasedAt ?? null,
      description: input.description ?? null, isFeatured: input.isFeatured ?? false,
      sortOrder: input.sortOrder ?? 0, isActive: input.isActive ?? true,
    }).returning();
    await audit(db, admin, 'model.create', 'model', m!.id, { slug: input.slug }, req.ip);
    void reply.status(201);
    return { id: m!.id };
  });

  app.patch('/api/v1/admin/models/:id', async (req) => {
    const admin = await app.requireRole(req, 'admin');
    const { id } = idParam.parse(req.params);
    const input = z.object({
      displayName: z.string().min(1).max(100).optional(),
      family: z.string().max(50).nullish(),
      modality: z.enum(['text', 'image', 'video', 'audio', 'embedding']).optional(),
      tier: z.enum(['flagship', 'standard', 'lite']).optional(),
      aliases: z.array(z.string().max(200)).max(50).optional(),
      defaultProtocol: z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini']).optional(),
      officialInputPrice: z.number().nonnegative().nullish(),
      officialOutputPrice: z.number().nonnegative().nullish(),
      contextWindow: z.number().int().positive().nullish(),
      knowledgeCutoff: z.string().max(10).nullish(),
      expectedTps: z.number().int().positive().nullish(),
      releasedAt: z.string().max(10).nullish(),
      description: z.string().max(2000).nullish(),
      isFeatured: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body);
    const m = (await db.select().from(models).where(eq(models.id, id)).limit(1))[0];
    if (!m) throw notFound('模型不存在');
    await db.update(models).set({
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.family !== undefined ? { family: input.family } : {}),
      ...(input.modality !== undefined ? { modality: input.modality } : {}),
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
      ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
      ...(input.defaultProtocol !== undefined ? { defaultProtocol: input.defaultProtocol } : {}),
      ...(input.officialInputPrice !== undefined ? { officialInputPrice: input.officialInputPrice } : {}),
      ...(input.officialOutputPrice !== undefined ? { officialOutputPrice: input.officialOutputPrice } : {}),
      ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
      ...(input.knowledgeCutoff !== undefined ? { knowledgeCutoff: input.knowledgeCutoff } : {}),
      ...(input.expectedTps !== undefined ? { expectedTps: input.expectedTps } : {}),
      ...(input.releasedAt !== undefined ? { releasedAt: input.releasedAt } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.isFeatured !== undefined ? { isFeatured: input.isFeatured } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: new Date(),
    }).where(eq(models.id, id));
    await audit(db, admin, 'model.update', 'model', id, {}, req.ip);
    return { ok: true };
  });

  app.delete('/api/v1/admin/models/:id', async (req) => {
    const admin = await app.requireRole(req, 'admin');
    const { id } = idParam.parse(req.params);
    const used = await db.select({ c: count() }).from(channelModels).where(eq(channelModels.modelId, id));
    if ((used[0]?.c ?? 0) > 0) {
      // 软删除：保留映射，仅下架
      await db.update(models).set({ isActive: false, updatedAt: new Date() }).where(eq(models.id, id));
    } else {
      const deleted = await db.delete(models).where(eq(models.id, id)).returning({ id: models.id });
      if (!deleted[0]) throw notFound('模型不存在');
    }
    await audit(db, admin, 'model.delete', 'model', id, {}, req.ip);
    return { ok: true };
  });

  // ---------- 用户管理 ----------
  app.get('/api/v1/admin/users', async (req): Promise<Paginated<AdminUser>> => {
    await app.requireRole(req, 'admin');
    const q = pageQuery.extend({
      role: z.enum(['user', 'merchant', 'admin']).optional(),
      q: z.string().optional(),
    }).parse(req.query);
    const conds = [];
    if (q.role) conds.push(eq(users.role, q.role));
    if (q.q) conds.push(or(ilike(users.email, `%${q.q}%`), ilike(users.nickname, `%${q.q}%`))!);
    const where = conds.length ? and(...conds) : undefined;
    const total = (await db.select({ c: count() }).from(users).where(where))[0]?.c ?? 0;
    const rows = await db.select().from(users).where(where)
      .orderBy(desc(users.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    const userIds = rows.map((u) => u.id);
    const siteCounts = userIds.length ? await db.execute<Record<string, unknown>>(sql`
      SELECT owner_id, count(*)::int AS cnt FROM sites
      WHERE owner_id IN (${sql.join(userIds.map((x) => sql`${x}`), sql`, `)}) GROUP BY owner_id`) : [];
    const scMap = new Map(siteCounts.map((r) => [r['owner_id'] as string, r['cnt'] as number]));
    return {
      items: rows.map((u) => ({
        id: u.id, email: u.email, nickname: u.nickname, role: u.role, status: u.status,
        siteCount: scMap.get(u.id) ?? 0,
        createdAt: u.createdAt.toISOString(), lastLoginAt: iso(u.lastLoginAt),
      })),
      total, page: q.page, pageSize: q.pageSize,
    };
  });

  app.patch('/api/v1/admin/users/:id', async (req) => {
    const admin = await app.requireRole(req, 'admin');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const input = z.object({
      role: z.enum(['user', 'merchant', 'admin']).optional(),
      status: z.enum(['active', 'banned']).optional(),
    }).parse(req.body);
    const u = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    if (!u) throw notFound('用户不存在');
    if (u.id === admin.id && input.status === 'banned') throw badRequest('不能禁用自己');
    await db.update(users).set({
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: new Date(),
    }).where(eq(users.id, id));
    await audit(db, admin, 'user.update', 'user', id, { ...input }, req.ip);
    return { ok: true };
  });

  // ---------- 全局探测日志 / 任务队列 ----------
  app.get('/api/v1/admin/probe-runs', async (req): Promise<Paginated<ProbeRun>> => {
    await app.requireRole(req, 'admin');
    const q = pageQuery.extend({
      channelId: z.coerce.number().int().optional(),
      success: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').optional(),
      kind: z.enum(['availability', 'authenticity', 'discovery']).optional(),
    }).parse(req.query);
    const conds = [];
    if (q.channelId !== undefined) conds.push(eq(probeRuns.channelId, q.channelId));
    if (q.success !== undefined) conds.push(eq(probeRuns.success, q.success));
    if (q.kind) conds.push(eq(probeRuns.kind, q.kind));
    const where = conds.length ? and(...conds) : undefined;
    const total = (await db.select({ c: count() }).from(probeRuns).where(where))[0]?.c ?? 0;
    const rows = await db.select().from(probeRuns).where(where)
      .orderBy(desc(probeRuns.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return { items: rows.map((r) => probeRunView(r)), total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/api/v1/admin/tasks', async (req): Promise<Paginated<ProbeTask>> => {
    await app.requireRole(req, 'admin');
    const q = pageQuery.extend({
      status: z.enum(['queued', 'running', 'done', 'failed', 'canceled']).optional(),
    }).parse(req.query);
    const where = q.status ? eq(probeTasks.status, q.status) : undefined;
    const total = (await db.select({ c: count() }).from(probeTasks).where(where))[0]?.c ?? 0;
    const rows = await db.select().from(probeTasks).where(where)
      .orderBy(desc(probeTasks.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return { items: rows.map(taskView), total, page: q.page, pageSize: q.pageSize };
  });

  // ---------- 反馈 ----------
  app.get('/api/v1/admin/feedback', async (req): Promise<Paginated<FeedbackItem>> => {
    await app.requireRole(req, 'admin');
    const q = pageQuery.extend({
      status: z.enum(['new', 'read', 'handled']).optional(),
      type: z.enum(['recommend_site', 'suggestion', 'complaint', 'bug']).optional(),
    }).parse(req.query);
    const conds = [];
    if (q.status) conds.push(eq(feedback.status, q.status));
    if (q.type) conds.push(eq(feedback.type, q.type));
    const where = conds.length ? and(...conds) : undefined;
    const total = (await db.select({ c: count() }).from(feedback).where(where))[0]?.c ?? 0;
    const rows = await db.select({ f: feedback, u: users }).from(feedback)
      .leftJoin(users, eq(feedback.userId, users.id))
      .where(where).orderBy(desc(feedback.createdAt))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return {
      items: rows.map(({ f, u }) => ({
        id: f.id, type: f.type, siteName: f.siteName, siteUrl: f.siteUrl,
        contact: f.contact, content: f.content, status: f.status,
        user: u ? { id: u.id, email: u.email, nickname: u.nickname } : null,
        createdAt: f.createdAt.toISOString(),
      })),
      total, page: q.page, pageSize: q.pageSize,
    };
  });

  app.patch('/api/v1/admin/feedback/:id', async (req) => {
    await app.requireRole(req, 'admin');
    const { id } = idParam.parse(req.params);
    const input = z.object({ status: z.enum(['new', 'read', 'handled']) }).parse(req.body);
    const updated = await db.update(feedback).set({ status: input.status })
      .where(eq(feedback.id, id)).returning({ id: feedback.id });
    if (!updated[0]) throw notFound('反馈不存在');
    return { ok: true };
  });

  // ---------- 评价管理 ----------
  app.get('/api/v1/admin/reviews', async (req): Promise<Paginated<AdminReview>> => {
    await app.requireRole(req, 'admin');
    const q = pageQuery.extend({
      status: z.enum(['visible', 'hidden']).optional(),
    }).parse(req.query);
    const where = q.status ? eq(reviews.status, q.status) : undefined;
    const total = (await db.select({ c: count() }).from(reviews).where(where))[0]?.c ?? 0;
    const rows = await db.select({ r: reviews, u: users, s: sites }).from(reviews)
      .innerJoin(users, eq(reviews.userId, users.id))
      .innerJoin(sites, eq(reviews.siteId, sites.id))
      .where(where).orderBy(desc(reviews.createdAt))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return {
      items: rows.map(({ r, u, s }) => ({
        id: r.id, rating: r.rating, content: r.content,
        user: { nickname: u.nickname, avatarUrl: u.avatarUrl },
        createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
        status: r.status,
        site: { id: s.id, slug: s.slug, name: s.name },
      })),
      total, page: q.page, pageSize: q.pageSize,
    };
  });

  app.patch('/api/v1/admin/reviews/:id', async (req) => {
    await app.requireRole(req, 'admin');
    const { id } = idParam.parse(req.params);
    const input = z.object({ status: z.enum(['visible', 'hidden']) }).parse(req.body);
    const updated = await db.update(reviews).set({ status: input.status, updatedAt: new Date() })
      .where(eq(reviews.id, id)).returning({ id: reviews.id });
    if (!updated[0]) throw notFound('评价不存在');
    return { ok: true };
  });

  // ---------- 公告 ----------
  app.get('/api/v1/admin/announcements', async (req): Promise<Announcement[]> => {
    await app.requireRole(req, 'admin');
    const rows = await db.select().from(announcements).orderBy(desc(announcements.pinned), desc(announcements.createdAt));
    return rows.map((a) => ({
      id: a.id, title: a.title, contentMd: a.contentMd,
      pinned: a.pinned, enabled: a.enabled, createdAt: a.createdAt.toISOString(),
    }));
  });

  const announcementInput = z.object({
    title: z.string().min(1).max(200),
    contentMd: z.string().min(1).max(10000),
    pinned: z.boolean().optional(),
    enabled: z.boolean().optional(),
  });

  app.post('/api/v1/admin/announcements', async (req, reply) => {
    const admin = await app.requireRole(req, 'admin');
    const input = announcementInput.parse(req.body);
    const [a] = await db.insert(announcements).values({
      title: input.title, contentMd: input.contentMd,
      pinned: input.pinned ?? false, enabled: input.enabled ?? true,
    }).returning();
    await audit(db, admin, 'announcement.create', 'announcement', a!.id, {}, req.ip);
    void reply.status(201);
    return { id: a!.id };
  });

  app.patch('/api/v1/admin/announcements/:id', async (req) => {
    await app.requireRole(req, 'admin');
    const { id } = idParam.parse(req.params);
    const input = announcementInput.partial().parse(req.body);
    const updated = await db.update(announcements).set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.contentMd !== undefined ? { contentMd: input.contentMd } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: new Date(),
    }).where(eq(announcements.id, id)).returning({ id: announcements.id });
    if (!updated[0]) throw notFound('公告不存在');
    return { ok: true };
  });

  app.delete('/api/v1/admin/announcements/:id', async (req) => {
    await app.requireRole(req, 'admin');
    const { id } = idParam.parse(req.params);
    const deleted = await db.delete(announcements).where(eq(announcements.id, id)).returning({ id: announcements.id });
    if (!deleted[0]) throw notFound('公告不存在');
    return { ok: true };
  });

  // ---------- 设置 ----------
  app.get('/api/v1/admin/settings', async (req): Promise<SettingsMap> => {
    await app.requireRole(req, 'admin');
    const rows = await db.select().from((await import('@hub/db')).settings);
    // SAFETY: DEFAULT_SETTINGS 全量默认，库中值按同一类型写入
    return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) } as unknown as SettingsMap;
  });

  app.put('/api/v1/admin/settings', async (req): Promise<SettingsMap> => {
    const admin = await app.requireRole(req, 'admin');
    const { settings } = await import('@hub/db');
    const input = z.object({
      'probe.defaultIntervalSec': z.number().int().min(30).max(86400).optional(),
      'probe.concurrency': z.number().int().min(1).max(100).optional(),
      'probe.perSiteConcurrency': z.number().int().min(1).max(20).optional(),
      'probe.timeoutMs': z.number().int().min(1000).max(120000).optional(),
      'authenticity.intervalHours': z.number().int().min(1).max(720).optional(),
      'authenticity.merchantDailyLimit': z.number().int().min(1).max(100).optional(),
      'scoring.weights': z.object({
        uptime: z.number().min(0).max(1),
        latency: z.number().min(0).max(1),
        trust: z.number().min(0).max(1),
        stability: z.number().min(0).max(1),
      }).refine((w) => w.uptime + w.latency + w.trust + w.stability > 0, { message: '评分权重之和必须大于 0' }).optional(),
      'verify.hourlyLimitPerIp': z.number().int().min(1).max(1000).optional(),
      'site.allowRegistration': z.boolean().optional(),
      'site.announcementBar': z.string().max(500).optional(),
    } satisfies Partial<Record<keyof SettingsMap, z.ZodTypeAny>>).parse(req.body);

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      // SAFETY: value 已经过上方 zod schema 校验，与 SettingsMap 键类型一一对应
      await db.insert(settings).values({ key, value: value as unknown as never })
        // SAFETY: 同上
        .onConflictDoUpdate({ target: settings.key, set: { value: value as unknown as never, updatedAt: new Date() } });
    }
    await audit(db, admin, 'settings.update', 'settings', 'global', { keys: Object.keys(input) }, req.ip);
    const rows = await db.select().from(settings);
    // SAFETY: 同上
    return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) } as unknown as SettingsMap;
  });

  // ---------- 审计日志 ----------
  app.get('/api/v1/admin/audit-logs', async (req): Promise<Paginated<AuditLog>> => {
    await app.requireRole(req, 'admin');
    const q = pageQuery.parse(req.query);
    const total = (await db.select({ c: count() }).from(auditLogs))[0]?.c ?? 0;
    const rows = await db.select({ l: auditLogs, u: users }).from(auditLogs)
      .leftJoin(users, eq(auditLogs.actorId, users.id))
      .orderBy(desc(auditLogs.createdAt))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return {
      items: rows.map(({ l, u }) => ({
        id: l.id,
        actor: u ? { id: u.id, email: u.email, nickname: u.nickname } : null,
        action: l.action, targetType: l.targetType, targetId: l.targetId,
        meta: l.meta, ip: l.ip, createdAt: l.createdAt.toISOString(),
      })),
      total, page: q.page, pageSize: q.pageSize,
    };
  });
}

