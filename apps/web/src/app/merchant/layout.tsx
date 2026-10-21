import type { ReactNode } from 'react';
import { requireSession } from '@/lib/api/server';
import { DashboardShell } from '@/components/dashboard-shell';
import './merchant.css';
export default async function MerchantLayout({ children }: { children: ReactNode }) {
  const user = await requireSession();
  if (!user) return null;
  return <DashboardShell kind="merchant" user={user}>{children}</DashboardShell>;
}
