import Link from 'next/link';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import type { AdminSite, AdminSiteDetail, AdminUser, AdminModel, AdminVendor, AdminReview, AuditLog, FeedbackItem, Paginated, ProbeRun, ProbeTask, SettingsMap, Announcement } from '@hub/shared';
import { requireSession, serverApi } from '@/lib/api/server';
import { PageHead } from '@/components/ui';
import { SiteTable, ChannelsTable, RunsTable, TasksTable, UsersTable, FeedbackTable, RatingsTable, AuditTable } from '@/components/admin/resources';
import { CatalogManager } from '@/components/admin/catalog';
import { SettingsEditor } from '@/components/admin/settings';

const sections: Record<string, { title: string; description: string }> = {
  reviews: { title: '入驻审核', description: '依据连接结果与检测证据，逐项审阅站点申请。' }, sites: { title: '站点管理', description: '管理全量站点、认证标识与展示状态。' }, channels: { title: '渠道管理', description: '调整渠道配置，按需触发探测和模型检测。' }, 'probe-runs': { title: '探测日志', description: '追踪可用性、首 Token 延迟及失败原因。' }, tasks: { title: '检测任务队列', description: '查看排队、执行和已完成任务。' }, models: { title: '模型目录', description: '平台标准模型与官方价格。' }, vendors: { title: '厂商管理', description: '维护模型提供方信息。' }, users: { title: '用户管理', description: '管理用户角色与账号状态。' }, feedback: { title: '用户反馈', description: '处理收录推荐、建议与投诉。' }, ratings: { title: '评价管理', description: '审核用户评价的公开状态。' }, announcements: { title: '公告管理', description: '发布、置顶或停用平台公告。' }, settings: { title: '系统设置', description: '配置探测参数、评分权重及站点功能。' }, 'audit-logs': { title: '审计日志', description: '保留管理操作的完整变更记录。' },
};
const statusOptions: Record<string, [string, string][]> = {
  sites: [['draft', '草稿'], ['pending', '审核中'], ['approved', '已上线'], ['rejected', '已驳回'], ['suspended', '已下架']],
  tasks: [['queued', '排队中'], ['running', '运行中'], ['done', '已完成'], ['failed', '失败'], ['canceled', '已取消']],
  feedback: [['new', '待阅读'], ['read', '已阅读'], ['handled', '已处理']], ratings: [['visible', '公开'], ['hidden', '隐藏']],
};
function list<T>(data: Paginated<T> | T[]) { return Array.isArray(data) ? data : data.items; }
export default async function AdminSectionPage({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!await requireSession(true)) return null;
  const { section } = await params;
  const info = sections[section];
  if (!info) notFound();
  const search = await searchParams;
  const query = new URLSearchParams({ pageSize: '100' });
  for (const key of ['page', 'q', 'status', 'role', 'channelId', 'success', 'kind', 'vendor']) { const value = search[key]; if (typeof value === 'string' && value) query.set(key, value); }
  let content: ReactNode;
  let vendorOptions: AdminVendor[] = [];
  let pagination: { total: number; page: number; pageSize: number } | null = null;
  if (section === 'sites' || section === 'reviews' || section === 'channels') {
    if (section === 'reviews') query.set('status', 'pending');
    const data = await serverApi<Paginated<AdminSite>>(`/admin/sites?${query}`);
    pagination = data;
    if (section === 'channels') {
      const sites = await Promise.all(data.items.map(site => serverApi<AdminSiteDetail>(`/admin/sites/${site.id}`)));
      content = <ChannelsTable items={sites.flatMap(site => site.channels)} />;
    } else content = <SiteTable items={data.items} review={section === 'reviews'} />;
  } else if (section === 'models') {
    const [models, vendors] = await Promise.all([serverApi<AdminModel[] | Paginated<AdminModel>>(`/admin/models?${query}`), serverApi<AdminVendor[]>('/admin/vendors')]);
    if (!Array.isArray(models)) pagination = models;
    vendorOptions = list(vendors);
    content = <CatalogManager kind="models" models={list(models)} vendors={vendorOptions} />;
  } else if (section === 'vendors') content = <CatalogManager kind="vendors" vendors={await serverApi<AdminVendor[]>('/admin/vendors')} />;
  else if (section === 'announcements') content = <CatalogManager kind="announcements" vendors={[]} announcements={list(await serverApi<Announcement[] | Paginated<Announcement>>('/admin/announcements'))} />;
  else if (section === 'settings') content = <SettingsEditor settings={await serverApi<SettingsMap>('/admin/settings')} />;
  else if (section === 'probe-runs') { const data = await serverApi<Paginated<ProbeRun>>(`/admin/probe-runs?${query}`); pagination = data; content = <RunsTable items={data.items} />; }
  else if (section === 'tasks') { const data = await serverApi<Paginated<ProbeTask>>(`/admin/tasks?${query}`); pagination = data; content = <TasksTable items={data.items} />; }
  else if (section === 'users') { const data = await serverApi<Paginated<AdminUser>>(`/admin/users?${query}`); pagination = data; content = <UsersTable items={data.items} />; }
  else if (section === 'feedback') { const data = await serverApi<Paginated<FeedbackItem>>(`/admin/feedback?${query}`); pagination = data; content = <FeedbackTable items={data.items} />; }
  else if (section === 'ratings') { const data = await serverApi<Paginated<AdminReview>>(`/admin/reviews?${query}`); pagination = data; content = <RatingsTable items={data.items} />; }
  else if (section === 'audit-logs') { const data = await serverApi<Paginated<AuditLog>>(`/admin/audit-logs?${query}`); pagination = data; content = <AuditTable items={data.items} />; }
  const pageHref = (page: number) => { const next = new URLSearchParams(query); next.set('page', String(page)); return `/admin/${section}?${next}`; };
  return <div className="stack"><PageHead title={info.title} description={info.description} />{pagination && ['sites', 'reviews', 'users', 'models', 'tasks', 'feedback', 'ratings', 'probe-runs'].includes(section) && <form action={`/admin/${section}`} method="get" className="row panel" style={{ gap: 12 }}>
    {['sites', 'reviews', 'users', 'models'].includes(section) && <label className="field" style={{ flex: '1 1 220px' }}>搜索全部记录<input className="input" name="q" placeholder="输入关键词" defaultValue={typeof search.q === 'string' ? search.q : ''} /></label>}
    {section === 'models' && <label className="field">所属厂商<select className="select" name="vendor" defaultValue={typeof search.vendor === 'string' ? search.vendor : ''}><option value="">全部厂商</option>{vendorOptions.map(vendor => <option key={vendor.id} value={vendor.slug}>{vendor.name}</option>)}</select></label>}
    {statusOptions[section] && <label className="field">状态<select className="select" name="status" defaultValue={typeof search.status === 'string' ? search.status : ''}><option value="">全部状态</option>{statusOptions[section].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}
    {section === 'users' && <label className="field">角色<select className="select" name="role" defaultValue={typeof search.role === 'string' ? search.role : ''}><option value="">全部角色</option><option value="user">用户</option><option value="merchant">站长</option><option value="admin">管理员</option></select></label>}
    {section === 'probe-runs' && <><label className="field">渠道编号<input className="input mono" type="number" name="channelId" min="1" defaultValue={typeof search.channelId === 'string' ? search.channelId : ''} /></label><label className="field">结果<select name="success" className="select" defaultValue={typeof search.success === 'string' ? search.success : ''}><option value="">全部结果</option><option value="true">成功</option><option value="false">失败</option></select></label><label className="field">探测类型<select className="select" name="kind" defaultValue={typeof search.kind === 'string' ? search.kind : ''}><option value="">全部类型</option><option value="availability">可用性</option><option value="authenticity">真伪检测</option><option value="discovery">模型发现</option></select></label></>}
    <button className="btn" style={{ alignSelf: 'flex-end' }}>应用筛选</button><Link href={`/admin/${section}`} className="btn btn-ghost" style={{ alignSelf: 'flex-end' }}>重置</Link>
  </form>}{content}{pagination && <div className="row between"><span className="muted mono">共 {pagination.total} 条 · 第 {pagination.page} 页</span><div className="row" style={{ gap: 8 }}>{pagination.page > 1 && <Link className="btn btn-small" href={pageHref(pagination.page - 1)}>上一页</Link>}{pagination.page * pagination.pageSize < pagination.total && <Link className="btn btn-small" href={pageHref(pagination.page + 1)}>下一页</Link>}</div></div>}</div>;
}
