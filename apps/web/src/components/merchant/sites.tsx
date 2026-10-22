'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { MerchantSite } from '@hub/shared';
import { SITE_TYPE_LABELS } from '@hub/shared';
import { api } from '@/lib/api/client';
import type { SearchValues } from '@/lib/query';
import { paginationValues, slicePage } from '@/lib/pagination';
import { DataPagination } from '@/components/data-pagination';
import { Empty, StatusBadge, FormatDate } from '@/components/page-kit';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { errorMessage } from './forms';

export function SitesList({ sites: initialSites, values }: { sites: MerchantSite[]; values: SearchValues }) {
  const [sites, setSites] = useState(initialSites);
  const [deleting, setDeleting] = useState<MerchantSite | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  useEffect(() => setSites(initialSites), [initialSites]);
  const pagination = paginationValues(values);
  const page = Math.min(pagination.page, Math.max(1, Math.ceil(sites.length / pagination.pageSize)));
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try { await api(`/merchant/sites/${deleting.id}`, { method: 'DELETE' }); setSites((current) => current.filter((site) => site.id !== deleting.id)); setDeleting(null); toast.success('站点已删除。'); router.refresh(); }
    catch (error) { toast.error(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-6">
    {sites.length ? <div className="grid gap-4 xl:grid-cols-2">{slicePage(sites, page, pagination.pageSize).map((site) => <Card key={site.id}>
      <CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-2"><CardDescription>{SITE_TYPE_LABELS[site.type]}</CardDescription><CardTitle>{site.name}</CardTitle></div><StatusBadge status={site.status} /></div></CardHeader>
      <CardContent className="space-y-5"><p className="text-sm text-muted-foreground">{site.description ?? '尚未填写站点简介'}</p><div className="flex flex-wrap items-center justify-between gap-3 text-sm"><span className="font-mono tabular-nums">{site.channelCount} 条渠道</span><span className="text-muted-foreground">更新于 <FormatDate value={site.updatedAt} /></span></div>
        {site.reviewNote && <Alert variant="destructive"><AlertDescription>审核反馈：{site.reviewNote}</AlertDescription></Alert>}
        <div className="flex flex-wrap gap-2"><Button asChild size="sm" variant="outline"><Link href={`/merchant/sites/${site.id}`}>管理站点</Link></Button>{['draft', 'rejected'].includes(site.status) && <><Button asChild size="sm"><Link href={`/merchant/onboarding?siteId=${site.id}`}>继续入驻</Link></Button><Button size="sm" variant="destructive" onClick={() => setDeleting(site)}>删除</Button></>}{site.status === 'approved' && <Button asChild size="sm" variant="ghost"><Link href={`/sites/${site.slug}`}>查看公开档案</Link></Button>}</div>
      </CardContent>
    </Card>)}</div> : <Empty title="你的第一个站点，从这里开始" description="创建站点草稿，添加渠道，连接成功后即可提交审核。" />}
    <DataPagination page={page} pageSize={pagination.pageSize} total={sites.length} base="/merchant/sites" values={values} />
    <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => { if (!busy && !open) setDeleting(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除「{deleting?.name}」？</AlertDialogTitle><AlertDialogDescription>站点及其旗下渠道将同时删除，此操作无法撤销。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>取消</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void remove(); }}>{busy ? '正在删除…' : '确认删除'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}
