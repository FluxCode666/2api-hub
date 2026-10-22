import type { ReactNode } from 'react';
import Link from 'next/link';
import { ShieldWarning } from '@phosphor-icons/react/dist/ssr';
import { requireSession } from '@/lib/api/server';
import { DashboardShell } from '@/components/dashboard-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireSession(true);
  if (!user) return <main className="flex min-h-svh items-center justify-center bg-background px-4 py-16"><Card className="w-full max-w-md"><CardHeader className="gap-3"><ShieldWarning className="size-8 text-primary" /><p className="font-mono text-xs tabular-nums text-muted-foreground">403</p><CardTitle><h1>需要管理员权限</h1></CardTitle><CardDescription>当前账号没有访问管理后台的权限。</CardDescription></CardHeader><CardContent><Button asChild variant="outline"><Link href="/">返回首页</Link></Button></CardContent></Card></main>;
  return <DashboardShell kind="admin" user={user}>{children}</DashboardShell>;
}
