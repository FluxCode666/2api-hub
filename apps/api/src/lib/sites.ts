/*
 * 站点列表/统计公共查询。
 */
import { sql } from 'drizzle-orm';
import type { Database } from '@hub/db';
import type { Paginated, SiteListItem } from '@hub/shared';
import { siteStatsView } from './serialize';

interface SiteListRow extends Record<string, unknown> {
  id: number;
  slug: string;
  name: string;
  logo_url: string | null;
  homepage_url: string;
  type: SiteListItem['type'];
  description: string | null;
  tags: string[];
  is_verified: boolean;
  is_featured: boolean;
  created_at: Date;
  // site_stats 左连接
  channel_count: number | null;
  model_count: number | null;
  avg_uptime_24h: number | null;
  best_recommend_score: number | null;
  min_actual_ratio: number | null;
  vendor_slugs: string[] | null;
  review_count: number | null;
  avg_rating: number | null;
  stats_updated_at: Date | null;
}

export interface SiteListParams {
  q?: string;
  type?: string;
  vendor?: string;
  sort: 'score' | 'uptime' | 'channels' | 'newest';
  page: number;
  pageSize: number;
}

export async function siteListQuery(db: Database, p: SiteListParams): Promise<Paginated<SiteListItem>> {
  const conds = [sql`s.status = 'approved'`];
  if (p.q) {
    for (const kw of p.q.split(/\s+/).filter(Boolean)) {
      const like = `%${kw}%`;
      conds.push(sql`(s.name ILIKE ${like} OR s.description ILIKE ${like})`);
    }
  }
  if (p.type) conds.push(sql`s.type = ${p.type}`);
  if (p.vendor) {
    conds.push(sql`(
      EXISTS (SELECT 1 FROM channels c JOIN vendors v ON v.id = c.vendor_id
              WHERE c.site_id = s.id AND c.status = 'active' AND v.slug = ${p.vendor})
      OR EXISTS (SELECT 1 FROM channels c
                 JOIN channel_models cm ON cm.channel_id = c.id AND c.status = 'active'
                 JOIN models m ON m.id = cm.model_id
                 JOIN vendors v ON v.id = m.vendor_id
                 WHERE c.site_id = s.id AND v.slug = ${p.vendor})
      OR ss.vendor_slugs @> ARRAY[${p.vendor}]::text[]
    )`);
  }
  const where = sql.join(conds, sql` AND `);

  const orderSql =
    p.sort === 'newest' ? sql`ORDER BY s.created_at DESC, s.id ASC`
    : p.sort === 'channels' ? sql`ORDER BY ss.channel_count DESC NULLS LAST, s.id ASC`
    : p.sort === 'uptime' ? sql`ORDER BY ss.avg_uptime_24h DESC NULLS LAST, s.id ASC`
    : sql`ORDER BY ss.best_recommend_score DESC NULLS LAST, s.sort_weight DESC, s.id ASC`;

  const from = sql`FROM sites s LEFT JOIN site_stats ss ON ss.site_id = s.id WHERE ${where}`;
  const countRows = await db.execute<Record<string, unknown>>(sql`SELECT count(*) AS count ${from}`);
  const total = Number(countRows[0]?.['count'] ?? 0);

  const rows = await db.execute<SiteListRow>(sql`
    SELECT s.id, s.slug, s.name, s.logo_url, s.homepage_url, s.type, s.description, s.tags,
           s.is_verified, s.is_featured, s.created_at,
           ss.channel_count, ss.model_count, ss.avg_uptime_24h, ss.best_recommend_score,
           ss.min_actual_ratio, ss.vendor_slugs, ss.review_count, ss.avg_rating, ss.updated_at AS stats_updated_at
    ${from} ${orderSql} LIMIT ${p.pageSize} OFFSET ${(p.page - 1) * p.pageSize}`);

  const items: SiteListItem[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    logoUrl: r.logo_url,
    homepageUrl: r.homepage_url,
    type: r.type,
    description: r.description,
    tags: r.tags ?? [],
    isVerified: r.is_verified,
    isFeatured: r.is_featured,
    stats: siteStatsView(r.channel_count === null ? null : {
      siteId: r.id,
      channelCount: r.channel_count ?? 0,
      modelCount: r.model_count ?? 0,
      avgUptime24h: r.avg_uptime_24h,
      bestRecommendScore: r.best_recommend_score,
      minActualRatio: r.min_actual_ratio,
      vendorSlugs: r.vendor_slugs ?? [],
      reviewCount: r.review_count ?? 0,
      avgRating: r.avg_rating,
      updatedAt: r.stats_updated_at ? new Date(r.stats_updated_at) : new Date(0),
    }),
    createdAt: new Date(r.created_at).toISOString(),
  }));
  return { items, total, page: p.page, pageSize: p.pageSize };
}

export async function reviewDistribution(
  db: Database,
  siteId: number,
): Promise<{ avg: number | null; count: number; distribution: Record<'1' | '2' | '3' | '4' | '5', number> }> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT rating, count(*)::int AS cnt FROM reviews
    WHERE site_id = ${siteId} AND status = 'visible' GROUP BY rating`);
  const distribution: Record<'1' | '2' | '3' | '4' | '5', number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let sum = 0;
  let cnt = 0;
  for (const r of rows) {
    const rating = String(r['rating']) as '1' | '2' | '3' | '4' | '5';
    const c = r['cnt'] as number;
    if (rating in distribution) distribution[rating] = c;
    sum += Number(r['rating']) * c;
    cnt += c;
  }
  return { avg: cnt > 0 ? Math.round((sum / cnt) * 10) / 10 : null, count: cnt, distribution };
}
