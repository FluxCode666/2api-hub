import { toTrustReportBrief } from '@/lib/trust-report';
import {
  AUTH_CHECKS, SEED_MODELS, SEED_VENDORS, computeRecommendScore, priceCny,
  type Announcement, type AuthenticityReport, type ChannelDetail, type ChannelStatsView,
  type ModelDetail, type SessionUser, type SiteDetail, type SiteType, type SparkPoint,
  type VendorSummary,
} from '@hub/shared';

export const mockNow = new Date().toISOString();
const ago = (minutes: number) => new Date(Date.parse(mockNow) - minutes * 60000).toISOString();

export const mockUsers: SessionUser[] = [
  { id: '00000000-0000-4000-8000-000000000001', email: 'admin@2api.hub', nickname: '平台管理员', avatarUrl: null, role: 'admin', createdAt: ago(129600) },
  { id: '00000000-0000-4000-8000-000000000002', email: 'merchant@2api.hub', nickname: '星河站长', avatarUrl: null, role: 'merchant', createdAt: ago(86400) },
  { id: '00000000-0000-4000-8000-000000000003', email: 'user@2api.hub', nickname: '探索者', avatarUrl: null, role: 'user', createdAt: ago(43200) },
];

export const mockVendors: VendorSummary[] = SEED_VENDORS.map((vendor, index) => ({
  id: index + 1, slug: vendor.slug, name: vendor.name, nameZh: vendor.nameZh, color: vendor.color,
  iconUrl: null, modelCount: SEED_MODELS.filter((model) => model.vendor === vendor.slug).length, channelCount: 0,
}));

export const mockModels: ModelDetail[] = SEED_MODELS.map((model, index) => ({
  id: index + 1, slug: model.slug, displayName: model.displayName,
  vendor: mockVendors.find((vendor) => vendor.slug === model.vendor)!,
  family: model.family, modality: model.modality, tier: model.tier,
  officialInputPrice: model.input, officialOutputPrice: model.output, contextWindow: model.contextWindow,
  isFeatured: model.featured, channelCount: 0, minInputPriceCny: null, bestUptime24h: null,
  aliases: model.aliases, defaultProtocol: model.defaultProtocol, knowledgeCutoff: model.knowledgeCutoff,
  releasedAt: '2026-09-15', expectedTps: model.expectedTps,
  description: `${model.displayName} 是 ${mockVendors.find((vendor) => vendor.slug === model.vendor)!.name} 的${model.tier === 'flagship' ? '旗舰' : model.tier === 'lite' ? '轻量' : '通用'}模型。此处为演示目录，价格以平台目录与渠道实时数据为准。`,
}));

export const mockReport: AuthenticityReport = {
  id: 1, channelId: 1, model: 'claude-opus-5-5', protocol: 'anthropic', score: 100, verdict: 'genuine',
  checks: AUTH_CHECKS.map((check) => ({ id: check.id, name: check.name, passed: true, weight: check.weight,
    detail: `演示检查：${check.description}，结果符合模型目录预期。` })),
  durationMs: 4280, trigger: 'schedule', createdAt: ago(48),
};

const siteNames = ['星河 API', '薄荷中转', '云桥 AI', '极光接口', '硅谷驿站', '长风 API', '微光智能', '鲸跃模型', '晴空中转', '竹间 API', '开物智联', '北辰模型'];
const siteSlugs = ['xinghe', 'mint', 'cloudbridge', 'aurora', 'silicon', 'changfeng', 'glimmer', 'whale', 'clear-sky', 'bamboo', 'kaiwu', 'polaris'];
const siteTypes: SiteType[] = ['new_api', 'sub2api', 'one_api', 'custom'];

export const mockSites: SiteDetail[] = siteNames.map((name, index) => ({
  id: index + 1, slug: siteSlugs[index]!, name, logoUrl: null, homepageUrl: `https://${siteSlugs[index]}.example.com`,
  type: siteTypes[index % siteTypes.length]!, description: '面向开发者的多模型 API 服务，支持按量计费与主流 SDK 接入。此站点为演示数据。',
  tags: index % 3 === 0 ? ['官方直连', '开发者友好'] : index % 3 === 1 ? ['价格友好', '多模型'] : ['企业服务', '按量付费'],
  isVerified: index < 5, isFeatured: index < 4,
  stats: { channelCount: 0, modelCount: 0, avgUptime24h: null, bestRecommendScore: null, minActualRatio: null, vendorSlugs: [], reviewCount: 3, avgRating: 4.7 },
  createdAt: ago(1440 * (120 - index * 6)), contact: { email: `hello@${siteSlugs[index]}.example.com`, telegram: '@hub_demo' },
  paymentMethods: index % 2 === 0 ? ['alipay', 'wechat', 'usdt'] : ['alipay', 'card'],
  rechargeRatio: index % 3 === 0 ? 1.25 : 1, approvedAt: ago(1440 * (115 - index * 6)), channels: [],
  ratingSummary: { avg: 4.7, count: 3, distribution: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 2 } },
}));

function statsFor(index: number): ChannelStatsView {
  const unknown = index === 35;
  const degraded = index % 9 === 7;
  const dead = index === 25;
  const trustScore = unknown ? null : index % 11 === 9 ? 35 : index % 7 === 6 ? 65 : index % 5 === 4 ? 85 : 100;
  const trustVerdict = trustScore === null ? 'unknown' : trustScore >= 80 ? 'genuine' : trustScore >= 50 ? 'suspect' : 'fake';
  const sparkline: SparkPoint[] = unknown ? [] : Array.from({ length: 60 }, (_, offset) => {
    const ok = !dead && (!degraded || offset % 4 !== 0) && (index % 4 !== 2 || offset % 31 !== 0);
    return { t: ago((59 - offset) * 10), ok, ms: ok ? 450 + index * 58 + ((offset * 173 + index * 71) % 900) : null };
  });
  const successes = sparkline.filter((point) => point.ok);
  const failures = sparkline.filter((point) => !point.ok);
  const uptime24h = unknown ? null : successes.length / 60;
  const latencyP50 = unknown || dead ? null : 850 + index * 58;
  const consecutiveFailures = dead ? 60 : degraded ? 1 : 0;
  const samples24h = unknown ? 0 : 144;
  return {
    uptime1h: unknown ? null : dead ? 0 : degraded ? 0.67 : 1,
    uptime24h, uptime7d: uptime24h === null ? null : Math.max(0, uptime24h - 0.003), samples24h,
    latencyP50, latencyP95: latencyP50 === null ? null : Math.round(latencyP50 * 1.8), ttftAvg: latencyP50 === null ? null : Math.round(latencyP50 * 0.45),
    consecutiveFailures, lastSuccessAt: successes.at(-1)?.t ?? null, lastFailureAt: failures.at(-1)?.t ?? null,
    lastProbeAt: sparkline.at(-1)?.t ?? null, trustScore, trustVerdict,
    recommendScore: computeRecommendScore({ uptime24h, latencyP50, trustScore, consecutiveFailures, samples24h }), sparkline,
  };
}

export const mockChannels: ChannelDetail[] = Array.from({ length: 36 }, (_, index) => {
  const site = mockSites[Math.floor(index / 3)]!;
  const vendor = mockVendors[index % mockVendors.length]!;
  const models = mockModels.filter((model) => model.vendor.slug === vendor.slug);
  const primary = models[index % models.length]!;
  const stats = statsFor(index);
  const ratio = Math.round((0.55 + (index % 12) * 0.16) * 100) / 100;
  const report: AuthenticityReport | null = stats.trustScore === null ? null : {
    ...mockReport, id: index + 1, channelId: index + 1, model: primary.slug, protocol: primary.defaultProtocol,
    score: stats.trustScore, verdict: stats.trustVerdict,
    checks: AUTH_CHECKS.map((check, checkIndex) => ({ id: check.id, name: check.name, weight: check.weight,
      passed: stats.trustScore === 100 || (stats.trustScore === 85 ? check.id !== 'response_shape' : checkIndex < Math.ceil((stats.trustScore ?? 0) / 13)),
      detail: `演示检查：${check.description}。${stats.trustScore !== null && stats.trustScore < 80 ? '部分指标存在差异，建议结合完整报告评估。' : '结果符合目录预期。'}` })),
  };
  if (report?.verdict === 'suspect') {
    // 展示部分得分与不适用项，演示数据的总分与检查权重保持一致。
    report.checks = report.checks.map(check => ({ ...check, passed: check.id === 'knowledge' ? null : !['token_count', 'reasoning'].includes(check.id), ...(check.id === 'reasoning' ? { score: 2 / 3 } : {}) }));
    const executed = report.checks.filter(check => check.passed !== null);
    report.score = Math.round(executed.reduce((sum, check) => sum + check.weight * (check.score ?? (check.passed ? 1 : 0)), 0) / executed.reduce((sum, check) => sum + check.weight, 0) * 100);
    stats.trustScore = report.score;
    stats.recommendScore = computeRecommendScore(stats);
  }
  return {
    id: index + 1, rank: index + 1, name: `${vendor.name} ${index % 3 === 0 ? '优选直连' : index % 3 === 1 ? '标准分组' : '高性价比'}`,
    description: `${vendor.name} 模型分组，按 Token 计费。此渠道为演示数据。`,
    protocol: primary.defaultProtocol, billingType: 'per_token', status: index === 25 ? 'invalid' : 'active',
    site: { id: site.id, slug: site.slug, name: site.name, logoUrl: site.logoUrl, homepageUrl: site.homepageUrl, type: site.type, isVerified: site.isVerified },
    vendor, groupRatio: Math.round(ratio * site.rechargeRatio * 10000) / 10000,
    rechargeRatio: site.rechargeRatio, actualRatio: ratio,
    price: { modelSlug: primary.slug, upstreamName: primary.slug, inputCny: priceCny(primary.officialInputPrice, ratio), outputCny: priceCny(primary.officialOutputPrice, ratio), isOverride: false },
    modelCount: models.length, models: models.map((model, modelIndex) => ({
      id: index * 100 + modelIndex + 1, upstreamName: model.slug, modelSlug: model.slug, displayName: model.displayName,
      vendorSlug: vendor.slug, lastStatus: stats.samples24h === 0 ? 'untested' : stats.uptime24h === 0 ? 'fail' : 'pass',
      trustScore: stats.trustScore, trustVerdict: stats.trustVerdict,
      lastLatencyMs: stats.latencyP50, lastTestedAt: stats.lastProbeAt, lastError: stats.uptime24h === 0 ? '上游返回 503' : null,
      inputPriceCny: priceCny(model.officialInputPrice, ratio), outputPriceCny: priceCny(model.officialOutputPrice, ratio),
    })), stats, isFavorite: false, primaryModel: primary.slug, backupModel: models.find((model) => model.slug !== primary.slug)?.slug ?? null,
    trustReport: toTrustReportBrief(report), latestReport: report, createdAt: site.createdAt,
  };
});

for (const site of mockSites) {
  site.channels = mockChannels.filter((channel) => channel.site.id === site.id);
  const available = site.channels.map((channel) => channel.stats.uptime24h).filter((value): value is number => value !== null);
  const scores = site.channels.map((channel) => channel.stats.recommendScore).filter((value): value is number => value !== null);
  site.stats = { ...site.stats, channelCount: site.channels.length,
    modelCount: new Set(site.channels.flatMap((channel) => channel.models.map((model) => model.modelSlug))).size,
    avgUptime24h: available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null,
    bestRecommendScore: scores.length ? Math.max(...scores) : null,
    minActualRatio: Math.min(...site.channels.map((channel) => channel.actualRatio)),
    vendorSlugs: Array.from(new Set(site.channels.flatMap((channel) => channel.vendor?.slug ?? []))),
  };
}

for (const model of mockModels) {
  const channels = mockChannels.filter((channel) => channel.models.some((item) => item.modelSlug === model.slug));
  const prices = channels.map((channel) => channel.models.find((item) => item.modelSlug === model.slug)?.inputPriceCny).filter((value): value is number => value !== null && value !== undefined);
  const uptime = channels.map((channel) => channel.stats.uptime24h).filter((value): value is number => value !== null);
  model.channelCount = channels.length;
  model.minInputPriceCny = prices.length ? Math.min(...prices) : null;
  model.bestUptime24h = uptime.length ? Math.max(...uptime) : null;
}
for (const vendor of mockVendors) vendor.channelCount = mockChannels.filter((channel) => channel.vendor?.slug === vendor.slug).length;

export const mockAnnouncements: Announcement[] = [{
  id: 1, title: '让每一次选择都有据可依', contentMd: '平台持续探测公开渠道。当前为演示数据，鉴定结论仅供参考，请结合业务需求选择服务。',
  pinned: true, enabled: true, createdAt: ago(720),
}];
