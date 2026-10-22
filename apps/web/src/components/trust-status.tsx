import type { TrustVerdict } from '@hub/shared';
import { VERDICT_LABELS } from '@hub/shared';
import { ShieldCheck, ShieldWarning, ShieldSlash, MinusCircle } from '@phosphor-icons/react/dist/ssr';
import { Badge } from '@/components/ui/badge';

/** 报告正文与折叠标题内使用静态徽章，避免嵌套交互控件。 */
export function TrustStatus({ score, verdict }: { score: number | null; verdict: TrustVerdict }) {
  const Icon = verdict === 'genuine' ? ShieldCheck : verdict === 'suspect' ? ShieldWarning : verdict === 'fake' ? ShieldSlash : MinusCircle;
  return <Badge variant={verdict === 'genuine' ? 'success' : verdict === 'suspect' ? 'warning' : verdict === 'fake' ? 'danger' : 'unknown'}><Icon size={12} />{score === null ? '—' : score} · {VERDICT_LABELS[verdict]}</Badge>;
}
