import {Skeleton} from '@/components/ui/skeleton';
export default function Loading() { return <div className="container stack" style={{ paddingTop: 50 }} aria-busy="true" aria-label="正在加载页面"><Skeleton style={{ width: '45%', height: 50 }}/><Skeleton style={{ height: 280 }}/><Skeleton /></div>; }
