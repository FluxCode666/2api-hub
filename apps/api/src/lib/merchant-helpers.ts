/*
 * 站长/管理共用的渠道模型加载辅助（从 merchant.ts 提炼，避免循环依赖）。
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { channelModels, models } from '@hub/db';
import type { Database } from '@hub/db';
import type { MerchantChannelModel } from '@hub/shared';
import { iso } from './serialize';

export async function loadMerchantChannelModelsFor(db: Database, channelIds: number[]): Promise<Map<number, MerchantChannelModel[]>> {
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
