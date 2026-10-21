/*
 * 渠道公开接口：榜单 / 详情 / 探测历史 / 检测报告（SPEC §7.1）
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  authenticityReports, channelModels, channels, models, probeRuns, sites, vendors,
} from '@hub/db';
import type {
  ChannelDetail, ChannelHistory, ChannelHistoryPoint, ChannelModelView,
  ChannelQuery, HistoryWindow, Paginated, AuthenticityReport, ChannelListItem,
} from '@hub/shared';
import { priceCny, actualRatio } from '@hub/shared';
import { notFound } from '../lib/errors';
import { iso, probeRunView, reportView } from '../lib/serialize';
import { queryChannels } from '../lib/channelList';

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const channelQuerySchema = pageQuery.extend({
  model: z.string().optional(),
  vendor: z.string().optional(),
  q: z.string().optional(),
  siteId: z.coerce.number().int().optional(),
  maxRatio: z.coerce.number().optional(),
  minUptime: z.coerce.number().min(0).max(1).optional(),
  minTrust: z.coerce.number().min(0).max(100).optional(),
  stableOnly: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').optional(),
  protocol: z.enum(['openai_chat', 'openai_responses', 'anthropic', 'gemini']).optional(),
  sort: z.enum(['recommend', 'price', 'ratio', 'uptime', 'latency', 'trust', 'updated']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  ids: z.string().optional(), // "1,2,3"
});

const WINDOW_BUCKET: Record<HistoryWindow, number> = { '1h': 60, '24h': 1800, '7d': 10800, '30d': 43200 };
const WINDOW_INTERVAL: Record<HistoryWindow, string> = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

export async function channelRoutes(app: FastifyInstance) {
  const db = app.db;

  // ---------- GET /channels 榜单 ----------
  app.get('/api/v1/channels', async (req): Promise<Paginated<ChannelListItem>> => {
    const parsed = channelQuerySchema.parse(req.query);
    const ids = parsed.ids
      ?.split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    const query: ChannelQuery & { page: number; pageSize: number } = {
      ...parsed,
      ids: ids && ids.length > 0 ? ids : undefined,
    };
    const user = await app.optionalUser(req);
    const { items, total } = await queryChannels(db, query, user?.id);
    return { items, total, page: parsed.page, pageSize: parsed.pageSize };
  });

  // ---------- GET /channels/:id ----------
  app.get('/api/v1/channels/:id', async (req): Promise<ChannelDetail> => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const rows = await db
      .select({ c: channels, s: sites })
      .from(channels)
      .innerJoin(sites, eq(channels.siteId, sites.id))
      .where(and(eq(channels.id, id), eq(sites.status, 'approved')))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound('渠道不存在');
    const { c, s } = row;

    const user = await app.optionalUser(req);
    const { items } = await queryChannels(db, { siteId: s.id, page: 1, pageSize: 100 }, user?.id);
    const listItem = items.find((it) => it.id === id);
    if (!listItem) throw notFound('渠道不存在或已下线');

    // 模型列表（含价格）
    const modelRows = await db
      .select({ cm: channelModels, m: models })
      .from(channelModels)
      .leftJoin(models, eq(channelModels.modelId, models.id))
      .where(eq(channelModels.channelId, id));
    const ratio = actualRatio(c.groupRatio, s.rechargeRatio);
    const modelViews: ChannelModelView[] = modelRows.map(({ cm, m }) => ({
      id: cm.id,
      upstreamName: cm.upstreamName,
      modelSlug: m?.slug ?? null,
      displayName: m?.displayName ?? null,
      vendorSlug: null, // 由下方填充
      lastStatus: cm.lastStatus,
      lastLatencyMs: cm.lastLatencyMs,
      lastTestedAt: iso(cm.lastTestedAt),
      lastError: cm.lastError,
      trustScore: cm.trustScore,
      trustVerdict: cm.trustVerdict,
      inputPriceCny: cm.priceOverrideInput ?? priceCny(m?.officialInputPrice ?? null, ratio),
      outputPriceCny: cm.priceOverrideOutput ?? priceCny(m?.officialOutputPrice ?? null, ratio),
    }));
    // 填充 vendorSlug
    if (modelRows.some((r) => r.m)) {
      const vendorIds = [...new Set(modelRows.filter((r) => r.m).map((r) => r.m!.vendorId))];
      const vRows = await db.select().from(vendors).where(sql`${vendors.id} IN (${sql.join(vendorIds.map((x) => sql`${x}`), sql`, `)})`);
      const vMap = new Map(vRows.map((x) => [x.id, x.slug]));
      for (let i = 0; i < modelRows.length; i++) {
        const m = modelRows[i]!.m;
        if (m) modelViews[i]!.vendorSlug = vMap.get(m.vendorId) ?? null;
      }
    }

    const latestReportRow = (await db.select().from(authenticityReports)
      .where(eq(authenticityReports.channelId, id))
      .orderBy(desc(authenticityReports.createdAt)).limit(1))[0];

    const { models: _omit, ...rest } = listItem;
    return {
      ...rest,
      primaryModel: c.primaryModel,
      backupModel: c.backupModel,
      models: modelViews,
      latestReport: latestReportRow ? reportView(latestReportRow) : null,
      createdAt: c.createdAt.toISOString(),
    };
  });

  // ---------- GET /channels/:id/history ----------
  app.get('/api/v1/channels/:id/history', async (req): Promise<ChannelHistory> => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { window } = z.object({ window: z.enum(['1h', '24h', '7d', '30d']).default('24h') }).parse(req.query);

    const exists = await db.select({ id: channels.id }).from(channels)
      .innerJoin(sites, eq(channels.siteId, sites.id))
      .where(and(eq(channels.id, id), eq(sites.status, 'approved'))).limit(1);
    if (!exists[0]) throw notFound('渠道不存在');

    const bucketSec = WINDOW_BUCKET[window];
    const interval = WINDOW_INTERVAL[window];
    const bucketRows = await db.execute<Record<string, unknown>>(sql`
      SELECT
        to_timestamp(floor(extract(epoch FROM created_at) / ${bucketSec}) * ${bucketSec}) AS bucket,
        count(*)::int AS total,
        count(*) FILTER (WHERE success)::int AS ok,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE success AND latency_ms IS NOT NULL) AS p50,
        avg(ttft_ms) FILTER (WHERE success AND ttft_ms IS NOT NULL) AS ttft
      FROM probe_runs
      WHERE channel_id = ${id} AND kind = 'availability' AND created_at > now() - ${sql.raw(`interval '${interval}'`)}
      GROUP BY bucket ORDER BY bucket`);
    const points: ChannelHistoryPoint[] = bucketRows.map((r) => ({
      t: new Date(r['bucket'] as string).toISOString(),
      total: r['total'] as number,
      ok: r['ok'] as number,
      latencyP50: r['p50'] === null ? null : Math.round(r['p50'] as number),
      ttftAvg: r['ttft'] === null ? null : Math.round(r['ttft'] as number),
    }));

    const recentRows = await db.select().from(probeRuns)
      .where(eq(probeRuns.channelId, id))
      .orderBy(desc(probeRuns.createdAt)).limit(50);
    return { window, bucketSec, points, recentRuns: recentRows.map((r) => probeRunView(r, true)) };
  });

  // ---------- GET /channels/:id/reports ----------
  app.get('/api/v1/channels/:id/reports', async (req): Promise<AuthenticityReport[]> => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const exists = await db.select({ id: channels.id }).from(channels)
      .innerJoin(sites, eq(channels.siteId, sites.id))
      .where(and(eq(channels.id, id), eq(sites.status, 'approved'))).limit(1);
    if (!exists[0]) throw notFound('渠道不存在');
    const rows = await db.select().from(authenticityReports)
      .where(eq(authenticityReports.channelId, id))
      .orderBy(desc(authenticityReports.createdAt)).limit(20);
    return rows.map(reportView);
  });
}
