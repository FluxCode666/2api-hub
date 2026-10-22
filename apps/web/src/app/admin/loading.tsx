import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return <div className="space-y-6" role="status" aria-label="正在加载管理数据"><div className="space-y-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-4 w-72 max-w-full" /></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <Card key={index}><CardHeader><Skeleton className="h-4 w-28" /></CardHeader><CardContent className="space-y-3"><Skeleton className="h-9 w-24" /><Skeleton className="h-3 w-36" /></CardContent></Card>)}</div><Card><CardHeader><Skeleton className="h-5 w-36" /></CardHeader><CardContent className="space-y-3">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-9 w-full" />)}</CardContent></Card><span className="sr-only">正在加载管理数据…</span></div>;
}
