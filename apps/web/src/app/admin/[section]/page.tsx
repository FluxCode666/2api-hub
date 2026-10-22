import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { AdminSite, AdminChannel, AdminUser, AdminModel, AdminVendor, AdminReview, AuditLog, FeedbackItem, Paginated, ProbeRun, ProbeTask, SettingsMap, Announcement } from '@hub/shared';
import { PROTOCOL_LABELS } from '@hub/shared';
import { requireSession, serverApi } from '@/lib/api/server';
import { PageHead } from '@/components/page-kit';
import { DataPagination } from '@/components/data-pagination';
import { paginationValues, slicePage } from '@/lib/pagination';
import { searchString, type SearchValues } from '@/lib/query';
import { SiteTable, ChannelsTable, RunsTable, TasksTable, UsersTable, FeedbackTable, RatingsTable, AuditTable } from '@/components/admin/resources';
import { CatalogManager } from '@/components/admin/catalog';
import { SettingsEditor } from '@/components/admin/settings';
import { AdminFilters } from '@/components/admin/filters';
import { Button } from '@/components/ui/button';

const sections: Record<string, { title: string; description: string }> = {
  reviews: { title: '入驻审核', description: '依据连接结果与检测证据，逐项审阅站点申请。' }, sites: { title: '站点管理', description: '管理全量站点、认证标识与展示状态。' }, channels: { title: '渠道管理', description: '调整渠道配置，按需触发探测和模型检测。' }, 'probe-runs': { title: '探测日志', description: '追踪可用性、首 Token 延迟及失败原因。' }, tasks: { title: '检测任务队列', description: '查看排队、执行和已完成任务。' }, models: { title: '模型目录', description: '维护平台标准模型、官方价格与检测基准。' }, vendors: { title: '厂商管理', description: '维护模型提供方资料与展示顺序。' }, users: { title: '用户管理', description: '管理用户角色与账号状态。' }, feedback: { title: '用户反馈', description: '处理收录推荐、建议与投诉。' }, ratings: { title: '评价管理', description: '审核用户评价的公开状态。' }, announcements: { title: '公告管理', description: '发布、置顶或停用平台公告。' }, settings: { title: '系统设置', description: '配置探测参数、评分权重及站点功能。' }, 'audit-logs': { title: '审计日志', description: '查看管理操作的完整变更记录。' },
};
const statuses: Record<string, { value: string; label: string }[]> = {
  channels: [{ value: 'active', label: '正常' }, { value: 'paused', label: '已暂停' }, { value: 'invalid', label: '已失效' }],
  sites: [{ value: 'draft', label: '草稿' }, { value: 'pending', label: '审核中' }, { value: 'approved', label: '已上线' }, { value: 'rejected', label: '已驳回' }, { value: 'suspended', label: '已下架' }],
  tasks: [{ value: 'queued', label: '排队中' }, { value: 'running', label: '运行中' }, { value: 'done', label: '已完成' }, { value: 'failed', label: '失败' }, { value: 'canceled', label: '已取消' }],
  feedback: [{ value: 'new', label: '待阅读' }, { value: 'read', label: '已阅读' }, { value: 'handled', label: '已处理' }], ratings: [{ value: 'visible', label: '公开' }, { value: 'hidden', label: '隐藏' }],
};
export default async function AdminSectionPage({ params, searchParams }: { params: Promise<{ section: string }>; searchParams: Promise<SearchValues> }) {
  if (!await requireSession(true)) return null;
  const { section } = await params; const info = sections[section]; if (!info) notFound();
  const values = await searchParams; const { page, pageSize } = paginationValues(values); const base = `/admin/${section}`;
  const query = searchString(values, { page: String(page), pageSize: String(pageSize), ...(section === 'reviews' ? { status: 'pending' } : {}) });
  let content: ReactNode; let pagination: { page: number; pageSize: number; total: number } | undefined;
  const filters: Parameters<typeof AdminFilters>[0]['filters'] = [];
  if (['sites', 'reviews', 'users', 'models', 'channels'].includes(section)) filters.push({ key: 'q', label: '关键词', placeholder: section === 'channels' ? '站点、渠道名称或上游域名' : '输入名称或标识' });
  if (statuses[section]) filters.push({ key: 'status', label: '状态', options: statuses[section] });
  if (section === 'sites' || section === 'reviews') {
    const data = await serverApi<Paginated<AdminSite>>(`/admin/sites?${query}`); pagination = data; content = <SiteTable items={data.items} review={section === 'reviews'} />;
  } else if (section === 'channels') {
    const [data, vendors] = await Promise.all([serverApi<Paginated<AdminChannel>>(`/admin/channels?${query}`), serverApi<AdminVendor[]>('/admin/vendors')]);
    filters.push(
      { key: 'vendor', label: '厂商', options: vendors.map(vendor => ({ value: vendor.slug, label: vendor.nameZh ?? vendor.name })) },
      { key: 'sort', label: '排序', defaultValue: 'recent', options: [{ value: 'recent', label: '最近更新' }, { value: 'uptime', label: '可用率从低到高' }, { value: 'trust', label: '可信分从低到高' }, { value: 'failures', label: '连续失败最多' }] },
      { key: 'siteStatus', label: '站点状态', options: statuses.sites },
      { key: 'protocol', label: '协议', options: Object.entries(PROTOCOL_LABELS).map(([value, label]) => ({ value, label })) },
      { key: 'siteId', label: '站点编号', type: 'number' },
    );
    pagination = data; content = <ChannelsTable items={data.items} />;
  } else if (section === 'models') {
    const [data, vendors] = await Promise.all([serverApi<Paginated<AdminModel> | AdminModel[]>(`/admin/models?${query}`), serverApi<AdminVendor[]>('/admin/vendors')]);
    const items = Array.isArray(data) ? data.filter(model => !values.vendor || model.vendor.slug === values.vendor) : data.items;
    pagination = Array.isArray(data) ? { page, pageSize, total: items.length } : data;
    filters.push({ key: 'vendor', label: '厂商', options: vendors.map(vendor => ({ value: vendor.slug, label: vendor.nameZh ?? vendor.name })) });
    content = <CatalogManager kind="models" models={Array.isArray(data) ? slicePage(items, page, pageSize) : items} vendors={vendors} values={values} />;
  } else if (section === 'vendors') content = <CatalogManager kind="vendors" vendors={await serverApi<AdminVendor[]>('/admin/vendors')} values={values} />;
  else if (section === 'announcements') {
    const data = await serverApi<Announcement[] | Paginated<Announcement>>('/admin/announcements'); content = <CatalogManager kind="announcements" vendors={[]} announcements={Array.isArray(data) ? data : data.items} values={values} />;
  } else if (section === 'settings') content = <SettingsEditor settings={await serverApi<SettingsMap>('/admin/settings')} />;
  else if (section === 'probe-runs') {
    filters.push({ key: 'channelId', label: '渠道编号', type: 'number' }, { key: 'success', label: '结果', options: [{ value: 'true', label: '成功' }, { value: 'false', label: '失败' }] }, { key: 'kind', label: '类型', options: [{ value: 'availability', label: '可用性' }, { value: 'authenticity', label: '真伪检测' }, { value: 'discovery', label: '模型发现' }] });
    const data = await serverApi<Paginated<ProbeRun>>(`/admin/probe-runs?${query}`); pagination = data; content = <RunsTable items={data.items} />;
  } else if (section === 'tasks') { const data = await serverApi<Paginated<ProbeTask>>(`/admin/tasks?${query}`); pagination = data; content = <TasksTable items={data.items} />; }
  else if (section === 'users') {
    filters.push({ key: 'role', label: '角色', options: [{ value: 'user', label: '用户' }, { value: 'merchant', label: '站长' }, { value: 'admin', label: '管理员' }] });
    const data = await serverApi<Paginated<AdminUser>>(`/admin/users?${query}`); pagination = data; content = <UsersTable items={data.items} />;
  } else if (section === 'feedback') { const data = await serverApi<Paginated<FeedbackItem>>(`/admin/feedback?${query}`); pagination = data; content = <FeedbackTable items={data.items} />; }
  else if (section === 'ratings') { const data = await serverApi<Paginated<AdminReview>>(`/admin/reviews?${query}`); pagination = data; content = <RatingsTable items={data.items} />; }
  else if (section === 'audit-logs') { const data = await serverApi<Paginated<AuditLog>>(`/admin/audit-logs?${query}`); pagination = data; content = <AuditTable items={data.items} />; }
  return <div className="space-y-6"><PageHead title={info.title} description={info.description} />{section === 'channels' && <div className="flex flex-wrap items-center gap-2 text-sm"><span className="text-muted-foreground">问题渠道</span><Button asChild size="sm" variant={values.status === 'invalid' ? 'secondary' : 'outline'}><Link href={`${base}?${searchString(values, { status: 'invalid', sort: 'failures', page: undefined })}`}>已失效</Link></Button><Button asChild size="sm" variant={values.sort === 'failures' && !values.status ? 'secondary' : 'outline'}><Link href={`${base}?${searchString(values, { status: undefined, sort: 'failures', page: undefined })}`}>按连续失败排查</Link></Button></div>}{filters.length > 0 && <AdminFilters key={query} base={base} values={values} filters={filters} searchLabel={section === 'channels' ? '搜索站点、渠道或域名' : undefined} />}{content}{pagination && <DataPagination {...pagination} base={base} values={values} />}</div>;
}
