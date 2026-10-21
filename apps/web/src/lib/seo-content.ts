import type { ChannelDetail, ModelDetail, SiteDetail } from '@hub/shared';

function price(value: number | null): string {
  return value === null ? '价格待收录' : `最低输入价 ¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}/百万 Token`;
}

function uptime(value: number | null, prefix = '24h 可用率'): string {
  return value === null ? '可用率待采样' : `${prefix} ${(value * 100).toFixed(2)}%`;
}

export function modelDescription(model: ModelDetail): string {
  return `比较 ${model.vendor.name} ${model.displayName} 的 ${model.channelCount} 个已上线中转渠道，${price(model.minInputPriceCny)}，${uptime(model.bestUptime24h, '最佳 24h 可用率')}。查看输入与输出单价、延迟和模型检测可信分，按需筛选合适的 API 中转站。`;
}

export function siteModelCount(site: SiteDetail): number {
  return new Set(site.channels.flatMap(channel => channel.models.map(model => model.modelSlug ?? model.upstreamName))).size;
}

export function siteDescription(site: SiteDetail): string {
  const rating = site.ratingSummary.avg !== null && site.ratingSummary.count > 0
    ? `，用户评分 ${site.ratingSummary.avg.toFixed(1)}/5（${site.ratingSummary.count} 条评价）`
    : '';
  const prices = site.channels.flatMap(channel => channel.price?.inputCny === null || channel.price?.inputCny === undefined ? [] : [channel.price.inputCny]);
  const lowest = prices.length > 0 ? `${price(Math.min(...prices))}（各渠道主测模型报价），` : '';
  return `${site.name} 中转站档案：${site.channels.length} 个已上线渠道、${siteModelCount(site)} 个模型，${lowest}${uptime(site.stats.avgUptime24h, '平均 24h 可用率')}${rating}。比较实际倍率、模型价格和检测记录。`;
}

export function channelDescription(channel: ChannelDetail): string {
  const quote = channel.price?.inputCny === null || channel.price?.inputCny === undefined
    ? '价格待收录'
    : `输入 ¥${channel.price.inputCny.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}/百万 Token`;
  const trust = channel.stats.trustScore === null ? '可信分待检测' : `模型可信分 ${channel.stats.trustScore}/100`;
  return `${channel.site.name}「${channel.name}」渠道实测：实际倍率 ${channel.actualRatio.toFixed(2)}×，${quote}，${uptime(channel.stats.uptime24h)}，${trust}。查看 ${channel.modelCount} 个支持模型、延迟趋势及最近探测日志。`;
}
