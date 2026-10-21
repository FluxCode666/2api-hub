/*
 * DB 行类型别名（从 drizzle schema 推断）。
 */
import type { InferSelectModel } from 'drizzle-orm';
import type { channels, channelStats, sites, siteStats, channelModels } from '@hub/db';

export type ChannelRow = InferSelectModel<typeof channels>;
export type ChannelStatsRow = InferSelectModel<typeof channelStats>;
export type SiteRow = InferSelectModel<typeof sites>;
export type SiteStatsRow = InferSelectModel<typeof siteStats>;
export type ChannelModelRow = InferSelectModel<typeof channelModels>;
