import type { ReactNode } from 'react';
import { requireSession } from '@/lib/api/server';
import { DashboardShell } from '@/components/dashboard-shell';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireSession(true);
  if (!user) return <main className="container section"><div className="empty"><p className="eyebrow">403</p><h1>需要管理员权限</h1><p className="muted">当前账号没有访问管理后台的权限。</p></div></main>;
  return <DashboardShell kind="admin" user={user}>{children}</DashboardShell>;
}
