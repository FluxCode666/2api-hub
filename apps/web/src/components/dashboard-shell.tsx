'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, Fragment, useContext, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { SessionUser } from '@hub/shared';
import { SquaresFour, Globe, PlusCircle, ChartLine, Clock, Stack, Users, ChatCircle, Star, Megaphone, Gear, ClipboardText, ShieldCheck, Cube, Buildings } from '@phosphor-icons/react';
import { SidebarProvider, Sidebar, SidebarHeader, SidebarContent, SidebarGroup, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarFooter, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbSeparator, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SystemVersionControl, SystemVersionProvider } from '@/components/system-version';

const merchant = [['/merchant', '工作台总览', SquaresFour], ['/merchant/sites', '我的站点', Globe], ['/merchant/onboarding', '站点入驻', PlusCircle]] as const;
const admin = [['/admin', '管理总览', SquaresFour], ['/admin/reviews', '入驻审核', ShieldCheck], ['/admin/sites', '站点管理', Globe], ['/admin/channels', '渠道管理', Stack], ['/admin/probe-runs', '探测日志', ChartLine], ['/admin/tasks', '任务队列', Clock], ['/admin/models', '模型目录', Cube], ['/admin/vendors', '厂商管理', Buildings], ['/admin/users', '用户管理', Users], ['/admin/feedback', '用户反馈', ChatCircle], ['/admin/ratings', '站点评价', Star], ['/admin/announcements', '公告管理', Megaphone], ['/admin/settings', '系统设置', Gear], ['/admin/audit-logs', '审计日志', ClipboardText]] as const;
type Crumb = { label: string; href?: string };
type Trail = { pathname: string; items: Crumb[] } | null;
const TrailContext = createContext<Dispatch<SetStateAction<Trail>> | null>(null);

// 详情页直接提供已经取得的资源名称，避免导航为解析面包屑重复请求 API。
export function DashboardTrail({ items, editableSite = false }: { items: Crumb[]; editableSite?: boolean }) {
  const pathname = usePathname();
  const setTrail = useContext(TrailContext);
  useEffect(() => {
    const trail = editableSite && pathname.endsWith('/edit') ? [...items, { label: '编辑站点' }] : items;
    setTrail?.({ pathname, items: trail });
    return () => setTrail?.(current => current?.pathname === pathname ? null : current);
  }, [pathname, items, editableSite, setTrail]);
  return null;
}

export function DashboardShell({ kind, user, children, mockEnabled = false }: { kind: 'merchant' | 'admin'; user: SessionUser; children: ReactNode; mockEnabled?: boolean }) {
  const pathname = usePathname();
  const [trail, setTrail] = useState<Trail>(null);
  const items = kind === 'admin' ? admin : merchant;
  const channelPage = kind === 'merchant' && pathname.startsWith('/merchant/channels/');
  const current = items.find(([href]) => href !== `/${kind}` && pathname.startsWith(href)) ?? items[0];
  const fallback: Crumb[] = channelPage ? [{ label: '我的站点', href: '/merchant/sites' }, { label: '渠道详情' }] :
    /\/sites\/\d+(?:\/edit)?$/.test(pathname) ? [{ label: kind === 'admin' ? '站点管理' : '我的站点', href: `/${kind}/sites` }, { label: pathname.endsWith('/edit') ? '编辑站点' : '站点详情' }] : [{ label: current[1] }];
  const crumbs = trail?.pathname === pathname ? trail.items : fallback;
  const shell = <TrailContext.Provider value={setTrail}><SidebarProvider style={{ '--sidebar-width': '220px' } as React.CSSProperties} className="min-h-[calc(100svh-82px)]">
    <Sidebar collapsible="icon" className="top-[82px] h-[calc(100svh-82px)] max-md:top-0 max-md:h-svh">
      <SidebarHeader><SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg" asChild><Link href={`/${kind}`}><SquaresFour /><span>2API Hub <span className="text-xs text-muted-foreground">· {kind === 'admin' ? '管理' : '站长'}</span></span></Link></SidebarMenuButton></SidebarMenuItem></SidebarMenu>{kind === 'admin' && <SystemVersionControl />}</SidebarHeader>
      <SidebarContent><SidebarGroup><SidebarMenu>{items.map(([href, label, Icon]) => <SidebarMenuItem key={href}><SidebarMenuButton asChild tooltip={label} isActive={href === `/${kind}` ? pathname === href : pathname.startsWith(href) || channelPage && href === '/merchant/sites'}><Link href={href}><Icon /><span>{label}</span></Link></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup></SidebarContent>
      <SidebarFooter><SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild tooltip="返回公开站"><Link href="/"><Globe /><span>返回公开站</span></Link></SidebarMenuButton></SidebarMenuItem></SidebarMenu><div className="overflow-hidden px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden"><div>{user.nickname}</div><div className="truncate text-[10px]">{user.email}</div></div></SidebarFooter>
    </Sidebar>
    <SidebarInset><div className="flex min-h-14 items-center gap-3 border-b px-5 py-3"><SidebarTrigger aria-label="切换侧边栏" /><Separator orientation="vertical" className="h-4" /><Breadcrumb aria-label="当前位置"><BreadcrumbList><BreadcrumbItem><BreadcrumbLink asChild><Link href={`/${kind}`}>{kind === 'admin' ? '平台管理' : '站长工作台'}</Link></BreadcrumbLink></BreadcrumbItem>{crumbs.map((crumb, index) => <Fragment key={`${index}-${crumb.label}`}><BreadcrumbSeparator /><BreadcrumbItem>{index === crumbs.length - 1 ? <BreadcrumbPage>{crumb.label}</BreadcrumbPage> : <BreadcrumbLink asChild><Link href={crumb.href ?? `/${kind}`}>{crumb.label}</Link></BreadcrumbLink>}</BreadcrumbItem></Fragment>)}</BreadcrumbList></Breadcrumb></div><main id="main" className="dashboard-main">{children}</main></SidebarInset>
  </SidebarProvider></TrailContext.Provider>;
  return kind === 'admin' ? <SystemVersionProvider mockEnabled={mockEnabled}>{shell}</SystemVersionProvider> : shell;
}
