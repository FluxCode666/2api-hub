/*
 * 渠道榜单核心查询：SQL 完成筛选/排序/分页（SPEC §7.1）。
 * 只返回已上线站点（status=approved）下的 active 渠道；null 值永远排最后；rank 跨页连续。
 */
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { inArray } from 'drizzle-orm';
import { channelModels, favorites, models, vendors } from '@hub/db';
import type { Database } from '@hub/db';
import type {
  ChannelListItem, ChannelModelBrief, ChannelPrice, ChannelQuery, ChannelSort,
  SiteRef, TrustVerdict,
} from '@hub/shared';
import { DEFAULT_SORT_ORDER, actualRatio, priceCny, STABLE_MIN_SAMPLES, STABLE_MIN_UPTIME } from '@hub/shared';
import { channelStatsView, vendorRef } from './serialize';
import type { ChannelStatsRow } from './types';

interface ListRow extends Record<string, unknown> {
  id: number;
  name: string;
  description: string | null;
  protocol: ChannelListItem['protocol'];
  billing_type: ChannelListItem['billingType'];
  status: ChannelListItem['status'];
  group_ratio: number;
  recharge_ratio: number;
  site_id: number;
  site_slug: string;
  site_name: string;
  site_logo_url: string | null;
  site_homepage_url: string;
  site_type: SiteRef['type'];
  site_is_verified: boolean;
  vendor_slug: string | null;
  vendor_name: string | null;
  vendor_name_zh: string | null;
  vendor_color: string | null;
  vendor_icon_url: string | null;
  model_count: number;
  price_model_slug: string | null;
  price_upstream_name: string | null;
  price_input_cny: number | null;
  price_output_cny: number | null;
  price_is_override: boolean | null;
  // channel_stats 列（左连接可能全 null）
  uptime_1h: number | null;
  uptime_24h: number | null;
  uptime_7d: number | null;
  samples_24h: number | null;
  latency_p50_24h: number | null;
  latency_p95_24h: number | null;
  ttft_avg_24h: number | null;
  consecutive_failures: number | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_probe_at: Date | null;
  trust_score: number | null;
  trust_verdict: TrustVerdict | null;
  recommend_score: number | null;
  sparkline: unknown;
}

const ACTUAL_RATIO = sql`CASE WHEN s.recharge_ratio > 0 THEN c.group_ratio / s.recharge_ratio ELSE c.group_ratio END`;

/** 价格表达式：站长覆盖价优先，否则官方价 × 实际倍率 */
const PRICE_INPUT = sql`COALESCE(pm.price_override_input, m.official_input_price * (${ACTUAL_RATIO}))`;
const PRICE_OUTPUT = sql`COALESCE(pm.price_override_output, m.official_output_price * (${ACTUAL_RATIO}))`;

const SORT_COL: Record<ChannelSort, SQL> = {
  recommend: sql`cs.recommend_score`,
  price: sql`(${PRICE_INPUT})`,
  ratio: sql`(${ACTUAL_RATIO})`,
  uptime: sql`cs.uptime_24h`,
  latency: sql`cs.latency_p50_24h`,
  trust: sql`cs.trust_score`,
  updated: sql`c.updated_at`,
};

export interface ChannelQueryResult {
  items: ChannelListItem[];
  total: number;
}

export async function queryChannels(
  db: Database,
  params: ChannelQuery & { page: number; pageSize: number },
  currentUserId?: string | null,
): Promise<ChannelQueryResult> {
  const conditions: SQL[] = [sql`s.status = 'approved'`, sql`c.status = 'active'`];

  // 价格/模型连接：带 model 时按目录模型连接，否则按主测模型
  let modelId: number | null = null;
  if (params.model) {
    const found = await db.select({ id: models.id }).from(models).where(sql`${models.slug} = ${params.model}`).limit(1);
    if (!found[0]) return { items: [], total: 0 };
    modelId = found[0].id;
  }
  const priceJoin = modelId !== null
    ? sql`LEFT JOIN channel_models pm ON pm.channel_id = c.id AND pm.model_id = ${modelId}
          LEFT JOIN models m ON m.id = pm.model_id`
    : sql`LEFT JOIN channel_models pm ON pm.channel_id = c.id AND pm.upstream_name = c.primary_model
          LEFT JOIN models m ON m.id = pm.model_id`;
  if (modelId !== null) conditions.push(sql`pm.model_id IS NOT NULL`);

  if (params.vendor) {
    const v = params.vendor;
    conditions.push(sql`(
      v.slug = ${v} OR EXISTS (
        SELECT 1 FROM channel_models cm
        JOIN models mm ON mm.id = cm.model_id
        JOIN vendors vv ON vv.id = mm.vendor_id
        WHERE cm.channel_id = c.id AND vv.slug = ${v}
      )
    )`);
  }
  if (params.q) {
    for (const kw of params.q.split(/\s+/).filter(Boolean)) {
      const like = `%${kw}%`;
      conditions.push(sql`(s.name ILIKE ${like} OR c.name ILIKE ${like} OR c.description ILIKE ${like})`);
    }
  }
  if (params.siteId !== undefined) conditions.push(sql`c.site_id = ${params.siteId}`);
  if (params.maxRatio !== undefined) conditions.push(sql`(${ACTUAL_RATIO}) <= ${params.maxRatio}`);
  if (params.minUptime !== undefined) conditions.push(sql`cs.uptime_24h >= ${params.minUptime}`);
  if (params.minTrust !== undefined) conditions.push(sql`cs.trust_score >= ${params.minTrust}`);
  if (params.stableOnly) conditions.push(sql`cs.uptime_24h >= ${STABLE_MIN_UPTIME} AND cs.samples_24h >= ${STABLE_MIN_SAMPLES}`);
  if (params.protocol) conditions.push(sql`c.protocol = ${params.protocol}`);
  if (params.ids && params.ids.length > 0) {
    conditions.push(sql`c.id IN (${sql.join(params.ids.map((id) => sql`${id}`), sql`, `)})`);
  }

  const where = sql.join(conditions, sql` AND `);
  const sort = params.sort ?? 'recommend';
  const order = params.order ?? DEFAULT_SORT_ORDER[sort];
  const sortCol = SORT_COL[sort];
  const orderSql = order === 'asc'
    ? sql`ORDER BY ${sortCol} ASC NULLS LAST, c.id ASC`
    : sql`ORDER BY ${sortCol} DESC NULLS LAST, c.id ASC`;

  const from = sql`
    FROM channels c
    JOIN sites s ON s.id = c.site_id
    LEFT JOIN vendors v ON v.id = c.vendor_id
    LEFT JOIN channel_stats cs ON cs.channel_id = c.id
    ${priceJoin}
    WHERE ${where}`;

  const countRows = await db.execute<Record<string, unknown>>(sql`SELECT count(*) AS count ${from}`);
  const total = Number(countRows[0]?.['count'] ?? 0);

  const rows = await db.execute<ListRow>(sql`
    SELECT
      c.id, c.name, c.description, c.protocol, c.billing_type, c.status, c.group_ratio,
      s.recharge_ratio,
      s.id AS site_id, s.slug AS site_slug, s.name AS site_name, s.logo_url AS site_logo_url,
      s.homepage_url AS site_homepage_url, s.type AS site_type, s.is_verified AS site_is_verified,
      v.slug AS vendor_slug, v.name AS vendor_name, v.name_zh AS vendor_name_zh,
      v.color AS vendor_color, v.icon_url AS vendor_icon_url,
      (SELECT count(*) FROM channel_models cm3 WHERE cm3.channel_id = c.id)::int AS model_count,
      m.slug AS price_model_slug, pm.upstream_name AS price_upstream_name,
      (${PRICE_INPUT}) AS price_input_cny, (${PRICE_OUTPUT}) AS price_output_cny,
      (pm.price_override_input IS NOT NULL OR pm.price_override_output IS NOT NULL) AS price_is_override,
      cs.uptime_1h, cs.uptime_24h, cs.uptime_7d, cs.samples_24h,
      cs.latency_p50_24h, cs.latency_p95_24h, cs.ttft_avg_24h, cs.consecutive_failures,
      cs.last_success_at, cs.last_failure_at, cs.last_probe_at,
      cs.trust_score, cs.trust_verdict, cs.recommend_score, cs.sparkline
    ${from}
    ${orderSql}
    LIMIT ${params.pageSize} OFFSET ${(params.page - 1) * params.pageSize}`);

  const channelIds = rows.map((r) => r.id);
  const modelsBrief = await loadModelsBrief(db, channelIds);
  const favSet = currentUserId && channelIds.length > 0
    ? new Set(
        (await db.select({ channelId: favorites.channelId }).from(favorites)
          .where(sql`${favorites.userId} = ${currentUserId} AND ${inArray(favorites.channelId, channelIds)}`))
          .map((f) => f.channelId),
      )
    : new Set<number>();

  const items: ChannelListItem[] = rows.map((r, i) => {
    const ratio = actualRatio(r.group_ratio, r.recharge_ratio);
    const price: ChannelPrice | null = r.price_model_slug && r.price_upstream_name
      ? {
          modelSlug: r.price_model_slug,
          upstreamName: r.price_upstream_name,
          inputCny: r.price_input_cny === null ? null : Math.round(r.price_input_cny * 1000) / 1000,
          outputCny: r.price_output_cny === null ? null : Math.round(r.price_output_cny * 1000) / 1000,
          isOverride: r.price_is_override ?? false,
        }
      : null;
    return {
      id: r.id,
      rank: (params.page - 1) * params.pageSize + i + 1,
      name: r.name,
      description: r.description,
      protocol: r.protocol,
      billingType: r.billing_type,
      status: r.status,
      site: {
        id: r.site_id,
        slug: r.site_slug,
        name: r.site_name,
        logoUrl: r.site_logo_url,
        homepageUrl: r.site_homepage_url,
        type: r.site_type,
        isVerified: r.site_is_verified,
      },
      vendor: r.vendor_slug && r.vendor_name && r.vendor_color
        ? vendorRef({ slug: r.vendor_slug, name: r.vendor_name, nameZh: r.vendor_name_zh, color: r.vendor_color, iconUrl: r.vendor_icon_url })
        : null,
      groupRatio: r.group_ratio,
      rechargeRatio: r.recharge_ratio,
      actualRatio: ratio,
      price,
      modelCount: r.model_count,
      models: modelsBrief.get(r.id) ?? [],
      stats: channelStatsView(statsRowFrom(r)),
      isFavorite: favSet.has(r.id),
    };
  });

  return { items, total };
}

/** db.execute 返回的 timestamp 可能是 string；统一转 Date */
function toDate(v: Date | string | null): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

function statsRowFrom(r: ListRow): ChannelStatsRow | null {
  if (r.samples_24h === null && r.uptime_24h === null && r.last_probe_at === null) return null;
  return {
    channelId: r.id,
    uptime1h: r.uptime_1h,
    uptime24h: r.uptime_24h,
    uptime7d: r.uptime_7d,
    samples24h: r.samples_24h ?? 0,
    latencyP50_24h: r.latency_p50_24h,
    latencyP95_24h: r.latency_p95_24h,
    ttftAvg24h: r.ttft_avg_24h,
    consecutiveFailures: r.consecutive_failures ?? 0,
    lastSuccessAt: toDate(r.last_success_at),
    lastFailureAt: toDate(r.last_failure_at),
    lastProbeAt: toDate(r.last_probe_at),
    trustScore: r.trust_score,
    trustVerdict: r.trust_verdict ?? 'unknown',
    recommendScore: r.recommend_score,
    sparkline: (r.sparkline ?? []) as ChannelStatsRow['sparkline'],
    updatedAt: new Date(0),
  };
}

/** 批量加载渠道的声明模型（含目录映射与厂商 slug） */
export async function loadModelsBrief(db: Database, channelIds: number[]): Promise<Map<number, ChannelModelBrief[]>> {
  const map = new Map<number, ChannelModelBrief[]>();
  if (channelIds.length === 0) return map;
  const rows = await db
    .select({
      channelId: channelModels.channelId,
      upstreamName: channelModels.upstreamName,
      lastStatus: channelModels.lastStatus,
      trustScore: channelModels.trustScore,
      trustVerdict: channelModels.trustVerdict,
      modelSlug: models.slug,
      displayName: models.displayName,
      vendorSlug: vendors.slug,
    })
    .from(channelModels)
    .leftJoin(models, sql`${channelModels.modelId} = ${models.id}`)
    .leftJoin(vendors, sql`${models.vendorId} = ${vendors.id}`)
    .where(inArray(channelModels.channelId, channelIds));
  for (const r of rows) {
    const list = map.get(r.channelId) ?? [];
    list.push({
      upstreamName: r.upstreamName,
      modelSlug: r.modelSlug ?? null,
      displayName: r.displayName ?? null,
      vendorSlug: r.vendorSlug ?? null,
      lastStatus: r.lastStatus,
      trustScore: r.trustScore,
      trustVerdict: r.trustVerdict,
    });
    map.set(r.channelId, list);
  }
  return map;
}

export { priceCny };
