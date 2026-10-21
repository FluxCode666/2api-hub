import Link from 'next/link';
import type { AdminOverview } from '@hub/shared';
import { requireSession, serverApi } from '@/lib/api/server';
import { PageHead, Metric } from '@/components/ui';
import { FailureTable } from '@/components/admin/resources';

export default async function AdminOverviewPage() {
  if (!await requireSession(true)) return null;
  const data = await serverApi<AdminOverview>('/admin/overview');
  const failureRate = data.probes24h.total ? `${(data.probes24h.failed / data.probes24h.total * 100).toFixed(1)}%` : '暂无样本';
  return <div className="stack">
    <PageHead title="平台运行总览" description="关注入驻审核、渠道健康与检测队列。"><Link className="btn btn-primary" href="/admin/reviews">处理入驻申请</Link></PageHead>
    <div className="metric-grid"><Metric label="待审核站点" value={data.pendingSites} detail="等待人工审阅" /><Metric label="已上线 / 全部站点" value={`${data.sites.approved} / ${data.sites.total}`} detail={`${data.sites.suspended} 个站点已下架`} /><Metric label="活跃渠道" value={`${data.channels.active} / ${data.channels.total}`} detail={`${data.channels.invalid} 个渠道失效`} /><Metric label="平台用户" value={data.users.total} detail={`${data.users.merchants} 位站长`} /><Metric label="24 小时探测" value={data.probes24h.total.toLocaleString('zh-CN')} detail={`失败率 ${failureRate}`} /><Metric label="待执行 / 运行中" value={`${data.queue.queued} / ${data.queue.running}`} detail="模型检测与可用性任务" /></div>
    <div className="panel stack"><div className="row between"><h2>最近失败探测</h2><Link className="btn btn-small" href="/admin/probe-runs?success=false">查看全部日志</Link></div><FailureTable items={data.recentFailures} /></div>
  </div>;
}
