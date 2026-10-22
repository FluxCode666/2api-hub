import { Skeleton } from '@/components/ui/skeleton';
export default function Loading() { return <div className="space-y-5" role="status" aria-label="正在加载站长后台"><Skeleton className="h-36 w-full" /><Skeleton className="h-36 w-full" /><span className="text-sm text-muted-foreground">正在加载站点数据…</span></div>; }
