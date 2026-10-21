/*
 * 序列化辅助：把 DB 行转成契约类型。时间统一 ISO 字符串。
 */
import type {
  ChannelStatsView, SiteStatsView, SparkPoint, TrustVerdict,
  ChannelModelBrief, VendorRef, ProbeRun, AuthenticityReport, ProbeTask,
} from '@hub/shared';
import type { ChannelStatsRow, SiteStatsRow } from './types';
import { publicErrorMessage } from './sanitize';
import { DEFAULT_SETTINGS } from '@hub/shared';
import type { SettingsMap } from '@hub/shared';

export const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  // db.execute 返回的 timestamp 是 string，drizzle select 返回 Date
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
};

export function vendorRef(v: { slug: string; name: string; nameZh: string | null; color: string; iconUrl: string | null }): VendorRef {
  return { slug: v.slug, name: v.name, nameZh: v.nameZh, color: v.color, iconUrl: v.iconUrl };
}

/** channel_stats 缺行时按“无数据”处理（worker 未启动/未聚合） */
export function channelStatsView(s: ChannelStatsRow | undefined | null): ChannelStatsView {
  return {
    uptime1h: s?.uptime1h ?? null,
    uptime24h: s?.uptime24h ?? null,
    uptime7d: s?.uptime7d ?? null,
    samples24h: s?.samples24h ?? 0,
    latencyP50: s?.latencyP50_24h ?? null,
    latencyP95: s?.latencyP95_24h ?? null,
    ttftAvg: s?.ttftAvg24h ?? null,
    consecutiveFailures: s?.consecutiveFailures ?? 0,
    lastSuccessAt: iso(s?.lastSuccessAt),
    lastFailureAt: iso(s?.lastFailureAt),
    lastProbeAt: iso(s?.lastProbeAt),
    trustScore: s?.trustScore ?? null,
    trustVerdict: (s?.trustVerdict ?? 'unknown') as TrustVerdict,
    recommendScore: s?.recommendScore ?? null,
    sparkline: (s?.sparkline ?? []) as SparkPoint[],
  };
}

export function siteStatsView(s: SiteStatsRow | undefined | null): SiteStatsView {
  return {
    channelCount: s?.channelCount ?? 0,
    modelCount: s?.modelCount ?? 0,
    avgUptime24h: s?.avgUptime24h ?? null,
    bestRecommendScore: s?.bestRecommendScore ?? null,
    minActualRatio: s?.minActualRatio ?? null,
    vendorSlugs: s?.vendorSlugs ?? [],
    reviewCount: s?.reviewCount ?? 0,
    avgRating: s?.avgRating ?? null,
  };
}

export function channelModelBrief(m: {
  upstreamName: string; modelSlug?: string | null; displayName?: string | null;
  vendorSlug?: string | null; lastStatus: string; trustScore: number | null; trustVerdict: string;
}): ChannelModelBrief {
  return {
    upstreamName: m.upstreamName,
    modelSlug: m.modelSlug ?? null,
    displayName: m.displayName ?? null,
    vendorSlug: m.vendorSlug ?? null,
    lastStatus: m.lastStatus as ChannelModelBrief['lastStatus'],
    trustScore: m.trustScore,
    trustVerdict: m.trustVerdict as TrustVerdict,
  };
}

export function probeRunView(r: {
  id: number; channelId: number; model: string; protocol: string; kind: string; trigger: string;
  success: boolean; httpStatus: number | null; errorCode: string | null; errorMessage: string | null;
  latencyMs: number | null; ttftMs: number | null; outputTokens: number | null; tokensPerSec: number | null;
  createdAt: Date;
}, sanitize = false): ProbeRun {
  return {
    id: r.id,
    channelId: r.channelId,
    model: r.model,
    protocol: r.protocol as ProbeRun['protocol'],
    kind: r.kind as ProbeRun['kind'],
    trigger: r.trigger as ProbeRun['trigger'],
    success: r.success,
    httpStatus: r.httpStatus,
    errorCode: r.errorCode,
    // 公开接口：不返回原始 errorMessage，用 errorCode 映射固定中文分类（防 Key/上游信息泄露）
    errorMessage: sanitize ? publicErrorMessage(r.errorCode) : r.errorMessage,
    latencyMs: r.latencyMs,
    ttftMs: r.ttftMs,
    outputTokens: r.outputTokens,
    tokensPerSec: r.tokensPerSec,
    createdAt: r.createdAt.toISOString(),
  };
}

export function reportView(r: {
  id: number; channelId: number | null; model: string; protocol: string;
  score: number | null; verdict: string; checks: unknown; durationMs: number | null;
  trigger: string; createdAt: Date;
}): AuthenticityReport {
  return {
    id: r.id,
    channelId: r.channelId,
    model: r.model,
    protocol: r.protocol as AuthenticityReport['protocol'],
    score: r.score,
    verdict: r.verdict as TrustVerdict,
    checks: r.checks as AuthenticityReport['checks'],
    durationMs: r.durationMs ?? 0,
    trigger: r.trigger as AuthenticityReport['trigger'],
    createdAt: r.createdAt.toISOString(),
  };
}

export function taskView(t: {
  id: number; channelId: number; kind: string; trigger: string; status: string;
  payload: unknown; result: unknown; error: string | null;
  createdAt: Date; startedAt: Date | null; finishedAt: Date | null;
}): ProbeTask {
  return {
    id: t.id,
    channelId: t.channelId,
    kind: t.kind as ProbeTask['kind'],
    trigger: t.trigger as ProbeTask['trigger'],
    status: t.status as ProbeTask['status'],
    payload: (t.payload ?? {}) as ProbeTask['payload'],
    result: t.result ?? null,
    error: t.error,
    createdAt: t.createdAt.toISOString(),
    startedAt: iso(t.startedAt),
    finishedAt: iso(t.finishedAt),
  };
}

/** settings 读取：库中缺 key 时回落到 DEFAULT_SETTINGS */
export function readSettings(rows: { key: string; value: unknown }[]): SettingsMap {
  const map: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) map[r.key] = r.value;
  // SAFETY: DEFAULT_SETTINGS 是全量默认，库中覆盖值由后台按同一类型写入
  return map as unknown as SettingsMap;
}

/** IP → 哈希（用于限频记录，避免存明文 IP） */
import { createHash } from 'node:crypto';
export function ipHash(ip: string): string {
  const salt = process.env.SESSION_SECRET ?? 'hub';
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}
