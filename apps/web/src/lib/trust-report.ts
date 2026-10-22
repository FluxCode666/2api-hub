import type { AuthenticityReport, ChannelListItem, ChannelModelBrief, TrustReportBrief } from '@hub/shared';

export function trustModelDisplayName(model: string | undefined, models: ReadonlyArray<Pick<ChannelModelBrief, 'upstreamName' | 'modelSlug' | 'displayName'>>): string | undefined {
  return models.find(item => item.upstreamName === model || item.modelSlug === model)?.displayName ?? undefined;
}

/** 展示名称来自渠道已经映射好的目录，不再额外请求模型列表。 */
export function channelTrustContext(channel: ChannelListItem, selectedModel?: string) {
  const model = channel.trustReport?.model ?? (channel.trustBasis === 'model' ? selectedModel ?? channel.price?.upstreamName ?? channel.price?.modelSlug : undefined);
  return {
    basis: channel.trustBasis,
    model,
    modelName: trustModelDisplayName(model, channel.models),
    fallbackReport: channel.fallbackTrustReport,
    fallbackModelName: trustModelDisplayName(channel.fallbackTrustReport?.model, channel.models),
  };
}

/** 后台完整报告与公开列表摘要共用同一套展示。 */
export function toTrustReportBrief(report: AuthenticityReport | null): TrustReportBrief | null {
  if (!report || report.id === null) return null;
  return {
    id: report.id,
    model: report.model,
    score: report.score,
    verdict: report.verdict,
    checkedAt: report.createdAt,
    checks: report.checks.map(({ id, passed, score }) => ({ id, passed, ...(score === undefined ? {} : { score }) })),
  };
}
