import type { AuthenticityReport, TrustReportBrief } from '@hub/shared';

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
