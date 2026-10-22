import Link from 'next/link';
import type { AdminOverview } from '@hub/shared';
import { requireSession, serverApi } from '@/lib/api/server';
import { PageHead } from '@/components/page-kit';
import { FailureTable } from '@/components/admin/resources';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default async function AdminOverviewPage() {
  if (!await requireSession(true)) return null;
  const data = await serverApi<AdminOverview>('/admin/overview');
  const failureRate = data.probes24h.total ? `${(data.probes24h.failed / data.probes24h.total * 100).toFixed(1)}%` : '暂无样本';
  const metrics = [
    { label: '待审核站点', value: data.pendingSites, detail: '等待人工审阅' },
    { label: '已上线 / 全部站点', value: `${data.sites.approved} / ${data.sites.total}`, detail: `${data.sites.suspended} 个站点已下架` },
    { label: '活跃渠道', value: `${data.channels.active} / ${data.channels.total}`, detail: `${data.channels.invalid} 个渠道失效` },
    { label: '平台用户', value: data.users.total, detail: `${data.users.merchants} 位站长` },
    { label: '24 小时探测', value: data.probes24h.total.toLocaleString('zh-CN'), detail: `失败率 ${failureRate}` },
    { label: '待执行 / 运行中', value: `${data.queue.queued} / ${data.queue.running}`, detail: '模型检测与可用性任务' },
  ];
  return <div className="space-y-6">
    <PageHead title="平台运行总览" description="关注入驻审核、渠道健康与检测队列。"><Button asChild><Link href="/admin/reviews">处理入驻申请</Link></Button></PageHead>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{metrics.map(metric => <Card key={metric.label}><CardHeader><CardDescription>{metric.label}</CardDescription></CardHeader><CardContent className="space-y-2"><p className="font-mono text-3xl font-semibold tracking-tight tabular-nums">{metric.value}</p><p className="text-xs text-muted-foreground">{metric.detail}</p></CardContent></Card>)}</div>
    <Card><CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3"><div className="space-y-1"><CardTitle>最近失败探测</CardTitle><CardDescription>快速定位渠道异常与上游连接问题。</CardDescription></div><Button asChild variant="outline" size="sm"><Link href="/admin/probe-runs?success=false">查看全部日志</Link></Button></CardHeader><CardContent><FailureTable items={data.recentFailures} /></CardContent></Card>
  </div>;
}
