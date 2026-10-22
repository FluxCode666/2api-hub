'use client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <Card><CardHeader><CardTitle>站点数据暂时无法加载</CardTitle><CardDescription>请检查网络连接，稍后重试。</CardDescription></CardHeader><CardContent><Button variant="outline" onClick={reset}>重新加载</Button></CardContent></Card>; }
