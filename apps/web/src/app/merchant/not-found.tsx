import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
export default function NotFound() { return <Card><CardHeader><CardTitle>没有找到这个站点或渠道</CardTitle><CardDescription>它可能已被移除，或不属于当前账号。</CardDescription></CardHeader><CardContent><Button asChild><Link href="/merchant/sites">返回我的站点</Link></Button></CardContent></Card>; }
