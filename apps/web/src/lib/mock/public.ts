import { priceCny, type ChannelDetail, type ChannelStatsView, type MerchantChannel, type ModelDetail, type SiteDetail, type VendorSummary } from '@hub/shared';
import { getMockAdminModels, getMockAdminVendors } from './admin';
import { getMockMerchantSites } from './merchant';
import { mockCommunityStore } from './store';

const emptyStats: ChannelStatsView = {
  uptime1h: null, uptime24h: null, uptime7d: null, samples24h: 0, latencyP50: null, latencyP95: null,
  ttftAvg: null, consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastProbeAt: null,
  trustScore: null, trustVerdict: 'unknown', recommendScore: null, sparkline: [],
};

function publicChannel(channel: MerchantChannel, site: SiteDetail): ChannelDetail {
  const models = channel.models.map((item) => {
    const model = getMockAdminModels().find((catalog) => catalog.slug === item.modelSlug);
    return {
      id: item.id, upstreamName: item.upstreamName, modelSlug: item.modelSlug, displayName: item.displayName,
      vendorSlug: model?.vendor.slug ?? null, lastStatus: item.lastStatus, trustScore: item.trustScore,
      trustVerdict: item.trustVerdict, lastLatencyMs: item.lastLatencyMs, lastTestedAt: item.lastTestedAt,
      lastError: item.lastError ? '上游暂时不可用，请稍后重试。' : null,
      inputPriceCny: item.priceOverrideInput ?? priceCny(model?.officialInputPrice, channel.actualRatio),
      outputPriceCny: item.priceOverrideOutput ?? priceCny(model?.officialOutputPrice, channel.actualRatio),
    };
  });
  const primary = models.find((model) => model.upstreamName === channel.primaryModel);
  const primaryMerchant = channel.models.find((model) => model.upstreamName === channel.primaryModel);
  return {
    id: channel.id, rank: channel.id, name: channel.name, description: channel.description,
    protocol: channel.protocol, billingType: channel.billingType, status: channel.status,
    site: { id: site.id, slug: site.slug, name: site.name, logoUrl: site.logoUrl, homepageUrl: site.homepageUrl, type: site.type, isVerified: site.isVerified },
    vendor: channel.vendor, groupRatio: channel.groupRatio, rechargeRatio: site.rechargeRatio, actualRatio: channel.actualRatio,
    price: primary?.modelSlug ? { modelSlug: primary.modelSlug, upstreamName: primary.upstreamName,
      inputCny: primary.inputPriceCny, outputCny: primary.outputPriceCny,
      isOverride: primaryMerchant?.priceOverrideInput != null || primaryMerchant?.priceOverrideOutput != null } : null,
    modelCount: models.length, models, stats: channel.stats ?? { ...emptyStats, trustScore: channel.latestReport?.score ?? null, trustVerdict: channel.latestReport?.verdict ?? 'unknown' }, isFavorite: false,
    primaryModel: channel.primaryModel, backupModel: channel.backupModel, latestReport: channel.latestReport, createdAt: channel.createdAt,
  };
}

/** 与站长及管理员共用状态，使审核通过后的演示站点立即公开。 */
export function publicSites(): SiteDetail[] {
  return getMockMerchantSites().filter((site) => site.status === 'approved').map((merchant) => {
    const site: SiteDetail = {
      id: merchant.id, slug: merchant.slug, name: merchant.name, logoUrl: merchant.logoUrl, homepageUrl: merchant.homepageUrl,
      type: merchant.type, description: merchant.description, tags: merchant.tags, isVerified: merchant.isVerified,
      isFeatured: merchant.isFeatured, createdAt: merchant.createdAt, contact: merchant.contact,
      paymentMethods: merchant.paymentMethods, rechargeRatio: merchant.rechargeRatio, approvedAt: merchant.approvedAt,
      stats: merchant.stats ?? { channelCount: 0, modelCount: 0, avgUptime24h: null, bestRecommendScore: null, minActualRatio: null, vendorSlugs: [], reviewCount: 0, avgRating: null },
      channels: [], ratingSummary: { avg: merchant.stats?.avgRating ?? null, count: merchant.stats?.reviewCount ?? 0, distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } },
    };
    site.channels = merchant.channels.map((channel) => publicChannel(channel, site));
    const reviews = mockCommunityStore.reviews.filter((review) => review.siteId === merchant.id && review.status !== 'hidden');
    site.ratingSummary.count = reviews.length;
    site.ratingSummary.avg = reviews.length ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length : null;
    for (const review of reviews) site.ratingSummary.distribution[String(review.rating) as keyof typeof site.ratingSummary.distribution] += 1;
    const uptime = site.channels.flatMap((channel) => channel.stats.uptime24h === null ? [] : [channel.stats.uptime24h]);
    const scores = site.channels.flatMap((channel) => channel.stats.recommendScore === null ? [] : [channel.stats.recommendScore]);
    site.stats = { ...site.stats, reviewCount: site.ratingSummary.count, avgRating: site.ratingSummary.avg, channelCount: site.channels.length,
      modelCount: new Set(site.channels.flatMap((channel) => channel.models.map((model) => model.modelSlug ?? model.upstreamName))).size,
      avgUptime24h: uptime.length ? uptime.reduce((sum, value) => sum + value, 0) / uptime.length : null,
      bestRecommendScore: scores.length ? Math.max(...scores) : null,
      minActualRatio: site.channels.length ? Math.min(...site.channels.map((channel) => channel.actualRatio)) : null,
      vendorSlugs: Array.from(new Set(site.channels.flatMap((channel) => channel.models.flatMap((model) => model.vendorSlug ?? [])))),
    };
    return site;
  });
}

export function publicChannels(): ChannelDetail[] { return publicSites().flatMap((site) => site.channels as ChannelDetail[]); }

export function publicModels(): ModelDetail[] {
  const channels = publicChannels();
  return getMockAdminModels().filter((model) => model.isActive).map(({ isActive: _isActive, sortOrder: _sortOrder, ...model }) => {
    const matched = channels.filter((channel) => channel.models.some((item) => item.modelSlug === model.slug));
    const prices = matched.flatMap((channel) => channel.models.flatMap((item) => item.modelSlug === model.slug && item.inputPriceCny !== null ? [item.inputPriceCny] : []));
    const uptime = matched.flatMap((channel) => channel.stats.uptime24h === null ? [] : [channel.stats.uptime24h]);
    const vendor = getMockAdminVendors().find((item) => item.slug === model.vendor.slug);
    return { ...model, vendor: vendor ? { slug: vendor.slug, name: vendor.name, nameZh: vendor.nameZh, color: vendor.color, iconUrl: vendor.iconUrl } : model.vendor, channelCount: matched.length,
      minInputPriceCny: prices.length ? Math.min(...prices) : null, bestUptime24h: uptime.length ? Math.max(...uptime) : null };
  });
}

export function publicVendors(): VendorSummary[] {
  const channels = publicChannels();
  return getMockAdminVendors().map((vendor) => ({ id: vendor.id, slug: vendor.slug, name: vendor.name,
    nameZh: vendor.nameZh, color: vendor.color, iconUrl: vendor.iconUrl,
    modelCount: getMockAdminModels().filter((model) => model.isActive && model.vendor.slug === vendor.slug).length,
    channelCount: channels.filter((channel) => channel.vendor?.slug === vendor.slug || channel.models.some((model) => model.vendorSlug === vendor.slug)).length,
  }));
}
