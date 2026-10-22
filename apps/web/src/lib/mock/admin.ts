import {themes} from '@/lib/theme';
import { actualRatio, computeRecommendScore, DEFAULT_SETTINGS } from '@hub/shared';
import type { AdminModel, AdminOverview, AdminReview, AdminSite, AdminSiteDetail, AdminUser, AdminVendor, Announcement, AuditLog, ChannelInput, FeedbackItem, MerchantChannel, ModelInput, Paginated, ProbeKind, ProbeRun, ProbeTask, ReviewStatus, Role, SessionUser, SettingsMap, SiteInput, SiteReviewAction, VendorInput, VendorRef } from '@hub/shared';
import { mockAnnouncements, mockModels, mockReport, mockUsers, mockVendors } from './fixtures';
import { getMockMerchantOwner, getMockMerchantRuns, getMockMerchantSites, getMockMerchantTasks, updateMockMerchantSite } from './merchant';
import { mockCommunityStore } from './store';
import { MockError } from './error';

type State = { vendors: AdminVendor[]; models: AdminModel[]; announcements: Announcement[]; settings: SettingsMap; audit: AuditLog[]; siteExtras: Record<number, { sortWeight: number; clickCount: number }>; userStatus: Record<string, 'active' | 'banned'>; reviewStatuses: Record<number, ReviewStatus>; tasks: ProbeTask[]; nextId: number };
const scope = globalThis as typeof globalThis & { __hubAdminMock?: State };
const now = () => new Date().toISOString();
function state(): State {
  return scope.__hubAdminMock ??= structuredClone({ vendors: mockVendors.map(vendor => ({ ...vendor, website: null, description: null, sortOrder: vendor.id })), models: mockModels.map(model => ({ ...model, isActive: true, sortOrder: model.id })), announcements: mockAnnouncements, settings: DEFAULT_SETTINGS, audit: [], siteExtras: {}, userStatus: {}, reviewStatuses: {}, tasks: [], nextId: 100000 });
}
function record(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new MockError(400, 'validation', '请求内容必须是有效对象');
  return body as Record<string, unknown>;
}
function audit(actor: SessionUser, action: string, targetType: string, targetId: string | number, meta: Record<string, unknown>) {
  const safeMeta = Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, /api.?key|password|secret/i.test(key) ? '[已隐藏]' : value]));
  state().audit.unshift({ id: state().nextId++, actor: { id: actor.id, email: actor.email, nickname: actor.nickname }, action, targetType, targetId: String(targetId), meta: safeMeta, ip: '127.0.0.1', createdAt: now() });
}
function page<T>(items: T[], query: URLSearchParams): Paginated<T> {
  const current = Math.max(1, Number(query.get('page')) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.get('pageSize')) || 20));
  return { items: items.slice((current - 1) * pageSize, current * pageSize), total: items.length, page: current, pageSize };
}
function match(text: string, query: URLSearchParams) { return text.toLocaleLowerCase().includes((query.get('q') ?? '').toLocaleLowerCase()); }
function vendorRef(vendor: VendorRef): VendorRef { return { slug: vendor.slug, name: vendor.name, nameZh: vendor.nameZh, color: vendor.color, iconUrl: vendor.iconUrl }; }
function siteDetail(id: number): AdminSiteDetail {
  const site = getMockMerchantSites().find(item => item.id === id);
  if (!site) throw new MockError(404, 'not_found', '站点不存在');
  const owner = mockCommunityStore.users.find(user => user.id === getMockMerchantOwner(id)) ?? mockUsers.find(user => user.role === 'merchant') ?? mockUsers[0]!;
  const extra = state().siteExtras[id] ?? { sortWeight: 0, clickCount: 0 };
  return { ...site, ...extra, owner: { id: owner.id, email: owner.email, nickname: owner.nickname }, reports: site.channels.flatMap(channel => channel.latestReport ? [channel.latestReport] : []) };
}
function channelById(id: number) {
  const site = getMockMerchantSites().find(item => item.channels.some(channel => channel.id === id));
  const channel = site?.channels.find(item => item.id === id);
  if (!site || !channel) throw new MockError(404, 'not_found', '渠道不存在');
  return { site, channel };
}
function createTask(channelId: number, kind: ProbeKind): ProbeTask {
  const task: ProbeTask = { id: state().nextId++, channelId, kind, trigger: 'admin', status: 'queued', payload: {}, result: null, error: null, createdAt: now(), startedAt: null, finishedAt: null };
  state().tasks.unshift(task); return task;
}
function advanceTasks() {
  for (const task of state().tasks) {
    if (!['queued', 'running'].includes(task.status)) continue;
    const age = Date.now() - Date.parse(task.createdAt);
    if (age < 1000) continue;
    task.status = 'running'; task.startedAt ??= now();
    if (age < 2800) continue;
    try {
      const { channel } = channelById(task.channelId);
      if (task.kind === 'authenticity') {
        const report = { ...structuredClone(mockReport), id: state().nextId++, channelId: channel.id, model: channel.primaryModel, protocol: channel.protocol, trigger: 'admin' as const, createdAt: now() };
        channel.latestReport = report; task.result = report;
        channel.models.forEach(model => { model.trustScore = report.score; model.trustVerdict = report.verdict; });
        if (channel.stats) { channel.stats.trustScore = report.score; channel.stats.trustVerdict = report.verdict; }
      } else if (task.kind === 'availability') {
        const ok = !channel.baseUrl.includes('/dead');
        const run: ProbeRun = { id: state().nextId++, channelId: channel.id, model: channel.primaryModel, protocol: channel.protocol, kind: 'availability', trigger: 'admin', success: ok, httpStatus: ok ? 200 : 503, errorCode: ok ? null : 'http_5xx', errorMessage: ok ? null : '上游暂时不可用', latencyMs: ok ? 836 : null, ttftMs: ok ? 260 : null, outputTokens: ok ? 4 : null, tokensPerSec: ok ? 78 : null, createdAt: now() };
        getMockMerchantRuns().unshift(run); task.result = run; channel.lastTestOk = ok; channel.lastTestAt = run.createdAt;
      } else task.result = channel.models;
      task.status = 'done'; task.finishedAt = now();
    } catch { task.status = 'failed'; task.error = '渠道不存在或已删除'; task.finishedAt = now(); }
  }
}
function users(): AdminUser[] {
  return mockCommunityStore.users.map(user => ({ id: user.id, email: user.email, nickname: user.nickname, role: user.role, status: mockCommunityStore.userStatus[user.id] ?? 'active', siteCount: getMockMerchantSites().filter(site => getMockMerchantOwner(site.id) === user.id).length, createdAt: user.createdAt, lastLoginAt: null }));
}

export async function mockAdmin(path: string, method: string, body: unknown, user: SessionUser | null): Promise<unknown> {
  if (!path.startsWith('/admin/')) return undefined;
  if (!user) throw new MockError(401, 'unauthorized', '请先登录');
  if (user.role !== 'admin') throw new MockError(403, 'forbidden', '需要管理员权限');
  const url = new URL(path, 'http://hub.local'); const route = url.pathname; const query = url.searchParams; const db = state();
  advanceTasks();
  if (route === '/admin/overview' && method === 'GET') {
    const sites = getMockMerchantSites(); const channels = sites.flatMap(site => site.channels); const runs = getMockMerchantRuns().filter(run => Date.now() - Date.parse(run.createdAt) < 86400000); const tasks = [...db.tasks, ...getMockMerchantTasks()]; const allUsers = users();
    const result: AdminOverview = { pendingSites: sites.filter(site => site.status === 'pending').length, sites: { total: sites.length, approved: sites.filter(site => site.status === 'approved').length, suspended: sites.filter(site => site.status === 'suspended').length }, channels: { total: channels.length, active: channels.filter(channel => channel.status === 'active').length, invalid: channels.filter(channel => channel.status === 'invalid').length }, users: { total: allUsers.length, merchants: allUsers.filter(item => item.role === 'merchant').length }, probes24h: { total: runs.length, failed: runs.filter(run => !run.success).length }, queue: { queued: tasks.filter(task => task.status === 'queued').length, running: tasks.filter(task => task.status === 'running').length }, recentFailures: runs.filter(run => !run.success).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8).map(run => ({ ...run, channelName: channels.find(channel => channel.id === run.channelId)?.name ?? '已删除渠道', siteName: sites.find(site => site.channels.some(channel => channel.id === run.channelId))?.name ?? '已删除站点' })) }; return result;
  }
  if (route === '/admin/sites' && method === 'GET') {
    const sites: AdminSite[] = getMockMerchantSites().map(site => { const { channels: _channels, reports: _reports, ...summary } = siteDetail(site.id); return summary; }).filter(site => (!query.get('status') || site.status === query.get('status')) && match(`${site.name} ${site.owner.email} ${site.slug}`, query)).sort((a, b) => (b.submittedAt ?? b.createdAt).localeCompare(a.submittedAt ?? a.createdAt)); return page(sites, query);
  }
  const siteMatch = route.match(/^\/admin\/sites\/(\d+)(?:\/(review))?$/);
  if (siteMatch) {
    const id = Number(siteMatch[1]); const site = siteDetail(id);
    if (!siteMatch[2] && method === 'GET') return site;
    if (siteMatch[2] === 'review' && method === 'POST') {
      const input = record(body) as unknown as SiteReviewAction;
      if (!['approve', 'reject', 'suspend', 'restore'].includes(input.action)) throw new MockError(400, 'validation', '无效的审核操作');
      if (['reject', 'suspend'].includes(input.action) && !input.reason?.trim()) throw new MockError(400, 'reason_required', '请填写驳回或下架原因');
      if (['approve', 'reject'].includes(input.action) && site.status !== 'pending') throw new MockError(409, 'invalid_state', '只有待审核站点可以通过或驳回');
      if (input.action === 'restore' && site.status !== 'suspended') throw new MockError(409, 'invalid_state', '只有已下架站点可以恢复');
      if (input.action === 'suspend' && site.status !== 'approved') throw new MockError(409, 'invalid_state', '只有已上线站点可以下架');
      updateMockMerchantSite(id, { status: input.action === 'approve' || input.action === 'restore' ? 'approved' : input.action === 'reject' ? 'rejected' : 'suspended', reviewNote: input.reason?.trim() || null, ...(input.action === 'approve' || input.action === 'restore' ? { approvedAt: now() } : {}) });
      if (input.action === 'approve') { const owner = mockCommunityStore.users.find(item => item.id === site.owner.id); if (owner?.role === 'user') owner.role = 'merchant'; }
      const notifications = mockCommunityStore.notifications[site.owner.id] ??= [];
      notifications.unshift({ id: db.nextId++, type: `site_${input.action}`, title: input.action === 'approve' ? `${site.name} 已通过审核` : input.action === 'reject' ? `${site.name} 需要修改` : input.action === 'suspend' ? `${site.name} 已下架` : `${site.name} 已恢复上线`, body: input.reason?.trim() || null, link: `/merchant/sites/${id}`, readAt: null, createdAt: now() });
      audit(user, `site.${input.action}`, 'site', id, { reason: input.reason ?? null }); return siteDetail(id);
    }
    if (!siteMatch[2] && method === 'PATCH') {
      const input = record(body) as Partial<SiteInput & Pick<AdminSite, 'isFeatured' | 'isVerified' | 'sortWeight'>>;
      if (input.name !== undefined && !input.name.trim()) throw new MockError(400, 'validation', '站点名称不能为空');
      if (input.slug !== undefined && getMockMerchantSites().some(item => item.slug === input.slug && item.id !== id)) throw new MockError(409, 'slug_exists', '站点标识已存在');
      if (input.rechargeRatio !== undefined && (!Number.isFinite(input.rechargeRatio) || input.rechargeRatio <= 0)) throw new MockError(400, 'validation', '充值倍率必须大于 0');
      if (input.homepageUrl !== undefined) { try { const parsed = new URL(input.homepageUrl); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); } catch { throw new MockError(400, 'validation', '请填写有效的站点网址'); } }
      const allowed = ['name', 'slug', 'homepageUrl', 'inviteUrl', 'logoUrl', 'description', 'type', 'rechargeRatio', 'contact', 'tags', 'paymentMethods', 'isFeatured', 'isVerified'] as const;
      const patch = Object.fromEntries(allowed.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
      const updated = updateMockMerchantSite(id, patch)!;
      if (input.sortWeight !== undefined) db.siteExtras[id] = { sortWeight: input.sortWeight, clickCount: site.clickCount };
      updated.channels.forEach(channel => { channel.actualRatio = actualRatio(channel.groupRatio, updated.rechargeRatio); if (input.rechargeRatio !== undefined && input.rechargeRatio !== site.rechargeRatio && updated.status === 'approved') createTask(channel.id, 'authenticity'); });
      audit(user, 'site.update', 'site', id, record(body)); return siteDetail(id);
    }
  }
  const channelMatch = route.match(/^\/admin\/channels\/(\d+)(?:\/(probe))?$/);
  if (channelMatch) {
    const id = Number(channelMatch[1]); const { channel, site } = channelById(id);
    if (channelMatch[2] === 'probe' && method === 'POST') {
      const kind = record(body).kind;
      if (kind !== 'availability' && kind !== 'authenticity' && kind !== 'discovery') throw new MockError(400, 'validation', '请选择有效的探测类型');
      const task = createTask(id, kind); audit(user, 'channel.probe', 'channel', id, { kind }); return task;
    }
    if (!channelMatch[2] && method === 'PATCH') {
      const input = record(body) as Partial<MerchantChannel & ChannelInput>;
      if (input.groupRatio !== undefined && (!Number.isFinite(input.groupRatio) || input.groupRatio <= 0)) throw new MockError(400, 'validation', '分组倍率必须大于 0');
      if (input.probeIntervalSec !== undefined && (!Number.isInteger(input.probeIntervalSec) || input.probeIntervalSec < 30)) throw new MockError(400, 'validation', '探测间隔至少为 30 秒');
      if (input.status && !['active', 'paused', 'invalid'].includes(input.status)) throw new MockError(400, 'validation', '渠道状态不合法');
      const critical = input.baseUrl !== undefined && input.baseUrl !== channel.baseUrl || input.groupRatio !== undefined && input.groupRatio !== channel.groupRatio || Boolean(input.apiKey);
      const allowed = ['name', 'description', 'protocol', 'baseUrl', 'groupRatio', 'billingType', 'primaryModel', 'backupModel', 'rpmLimit', 'status', 'probeEnabled', 'probeIntervalSec'] as const;
      Object.assign(channel, Object.fromEntries(allowed.filter(key => input[key] !== undefined).map(key => [key, input[key]])), { updatedAt: now() });
      if (input.apiKey) channel.apiKeyMask = `sk-****${input.apiKey.slice(-4)}`;
      channel.actualRatio = actualRatio(channel.groupRatio, site.rechargeRatio);
      if (critical && site.status === 'approved') createTask(id, 'authenticity');
      audit(user, 'channel.update', 'channel', id, record(body)); return channel;
    }
  }
  if (route === '/admin/probe-runs' && method === 'GET') return page(getMockMerchantRuns().filter(run => (!query.get('channelId') || run.channelId === Number(query.get('channelId'))) && (!query.has('success') || String(run.success) === query.get('success')) && (!query.get('kind') || run.kind === query.get('kind')) && match(`${run.model} ${run.errorMessage ?? ''}`, query)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), query);
  if (route === '/admin/tasks' && method === 'GET') return page([...db.tasks, ...getMockMerchantTasks()].filter(task => (!query.get('status') || task.status === query.get('status')) && match(`${task.id} ${task.channelId} ${task.kind}`, query)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), query);
  if (route === '/admin/users' && method === 'GET') return page(users().filter(item => (!query.get('role') || item.role === query.get('role')) && match(`${item.email} ${item.nickname}`, query)), query);
  const userMatch = route.match(/^\/admin\/users\/([^/]+)$/);
  if (userMatch && method === 'PATCH') {
    const target = mockCommunityStore.users.find(item => item.id === decodeURIComponent(userMatch[1]!));
    if (!target) throw new MockError(404, 'not_found', '用户不存在');
    const input = record(body);
    if (input.role !== undefined && !['user', 'merchant', 'admin'].includes(String(input.role))) throw new MockError(400, 'validation', '角色不合法');
    if (input.status !== undefined && !['active', 'banned'].includes(String(input.status))) throw new MockError(400, 'validation', '用户状态不合法');
    if (target.id === user.id && (input.role !== undefined && input.role !== 'admin' || input.status === 'banned')) throw new MockError(409, 'self_lockout', '不能降级或封禁当前管理员账号');
    if (input.role !== undefined) target.role = input.role as Role;
    if (input.status !== undefined) mockCommunityStore.userStatus[target.id] = input.status as 'active' | 'banned';
    audit(user, 'user.update', 'user', target.id, input); return users().find(item => item.id === target.id);
  }
  if (route === '/admin/vendors' && method === 'GET') return getMockAdminVendors();
  const vendorMatch = route.match(/^\/admin\/vendors(?:\/(\d+))?$/);
  if (vendorMatch && ['POST', 'PATCH', 'DELETE'].includes(method)) {
    const id = vendorMatch[1] ? Number(vendorMatch[1]) : null; const existing = db.vendors.find(item => item.id === id);
    if (id !== null && !existing) throw new MockError(404, 'not_found', '厂商不存在');
    if (method === 'DELETE') {
      if (db.models.some(model => model.vendor.slug === existing?.slug)) throw new MockError(409, 'vendor_in_use', '厂商仍有模型，无法删除');
      db.vendors = db.vendors.filter(item => item.id !== id); audit(user, 'vendor.delete', 'vendor', id!, {}); return { ok: true };
    }
    const input = record(body) as unknown as VendorInput;
    if (!input.name?.trim() || !input.slug?.trim()) throw new MockError(400, 'validation', '请填写厂商名称和标识');
    if (db.vendors.some(item => item.slug === input.slug && item.id !== id)) throw new MockError(409, 'slug_exists', '厂商标识已存在');
    const value: AdminVendor = { id: id ?? db.nextId++, slug: input.slug, name: input.name, nameZh: input.nameZh ?? null, color: input.color ?? themes.light.primary, iconUrl: input.iconUrl !== undefined ? input.iconUrl : existing?.iconUrl ?? null, website: input.website !== undefined ? input.website : existing?.website ?? null, description: input.description !== undefined ? input.description : existing?.description ?? null, modelCount: existing?.modelCount ?? 0, channelCount: existing?.channelCount ?? 0, sortOrder: input.sortOrder ?? existing?.sortOrder ?? 0 };
    if (existing) { const previousSlug = existing.slug; Object.assign(existing, value); db.models.forEach(model => { if (model.vendor.slug === previousSlug) model.vendor = vendorRef(value); }); } else db.vendors.push(value);
    audit(user, `vendor.${existing ? 'update' : 'create'}`, 'vendor', value.id, record(body)); return value;
  }
  if (route === '/admin/models' && method === 'GET') return db.models.filter(model => match(`${model.displayName} ${model.slug} ${model.vendor.name}`, query));
  const modelMatch = route.match(/^\/admin\/models(?:\/(\d+))?$/);
  if (modelMatch && ['POST', 'PATCH', 'DELETE'].includes(method)) {
    const id = modelMatch[1] ? Number(modelMatch[1]) : null; const existing = db.models.find(item => item.id === id);
    if (id !== null && !existing) throw new MockError(404, 'not_found', '模型不存在');
    if (method === 'DELETE') { db.models = db.models.filter(item => item.id !== id); audit(user, 'model.delete', 'model', id!, {}); return { ok: true }; }
    const input = record(body) as unknown as ModelInput;
    const vendor = db.vendors.find(item => item.slug === input.vendorSlug);
    if (!input.displayName?.trim() || !input.slug?.trim() || !vendor) throw new MockError(400, 'validation', '请填写模型名称、标识并选择厂商');
    if (db.models.some(item => item.slug === input.slug && item.id !== id)) throw new MockError(409, 'slug_exists', '模型标识已存在');
    const value: AdminModel = { id: id ?? db.nextId++, slug: input.slug, displayName: input.displayName, vendor: vendorRef(vendor), family: input.family ?? null, modality: input.modality ?? 'text', tier: input.tier ?? 'standard', aliases: input.aliases ?? [], defaultProtocol: input.defaultProtocol ?? 'openai_chat', officialInputPrice: input.officialInputPrice ?? null, officialOutputPrice: input.officialOutputPrice ?? null, contextWindow: input.contextWindow ?? null, knowledgeCutoff: input.knowledgeCutoff ?? null, releasedAt: input.releasedAt ?? null, description: input.description ?? null, expectedTps: input.expectedTps ?? null, isFeatured: input.isFeatured ?? false, isActive: input.isActive ?? true, sortOrder: input.sortOrder ?? 0, channelCount: existing?.channelCount ?? 0, minInputPriceCny: existing?.minInputPriceCny ?? null, bestUptime24h: existing?.bestUptime24h ?? null };
    if (existing) Object.assign(existing, value); else db.models.push(value);
    audit(user, `model.${existing ? 'update' : 'create'}`, 'model', value.id, record(body)); return value;
  }
  if (route === '/admin/feedback' && method === 'GET') return page(mockCommunityStore.feedback.filter(item => (!query.get('status') || item.status === query.get('status')) && match(`${item.content} ${item.siteName ?? ''}`, query)), query);
  const feedbackMatch = route.match(/^\/admin\/feedback\/(\d+)$/);
  if (feedbackMatch && method === 'PATCH') {
    const item: FeedbackItem | undefined = mockCommunityStore.feedback.find(feedback => feedback.id === Number(feedbackMatch[1]));
    if (!item) throw new MockError(404, 'not_found', '反馈不存在');
    const status = record(body).status;
    if (status !== 'new' && status !== 'read' && status !== 'handled') throw new MockError(400, 'validation', '反馈状态不合法');
    item.status = status; audit(user, 'feedback.update', 'feedback', item.id, { status }); return item;
  }
  if (route === '/admin/reviews' && method === 'GET') {
    const items: AdminReview[] = mockCommunityStore.reviews.flatMap(review => { const site = getMockMerchantSites().find(item => item.id === review.siteId); if (!site) return []; return [{ id: review.id, rating: review.rating, content: review.content, user: review.user, createdAt: review.createdAt, updatedAt: review.updatedAt, status: review.status ?? 'visible', site: { id: site.id, slug: site.slug, name: site.name } }]; }); return page(items.filter(item => (!query.get('status') || item.status === query.get('status')) && match(`${item.content} ${item.site.name}`, query)), query);
  }
  const reviewMatch = route.match(/^\/admin\/reviews\/(\d+)$/);
  if (reviewMatch && method === 'PATCH') {
    const id = Number(reviewMatch[1]); const item = mockCommunityStore.reviews.find(review => review.id === id);
    if (!item) throw new MockError(404, 'not_found', '评价不存在');
    const status = record(body).status;
    if (status !== 'visible' && status !== 'hidden') throw new MockError(400, 'validation', '评价状态不合法');
    item.status = status; audit(user, 'review.update', 'review', id, { status }); return { ...item, status };
  }
  if (route === '/admin/announcements' && method === 'GET') return db.announcements;
  const announcementMatch = route.match(/^\/admin\/announcements(?:\/(\d+))?$/);
  if (announcementMatch && ['POST', 'PATCH', 'DELETE'].includes(method)) {
    const id = announcementMatch[1] ? Number(announcementMatch[1]) : null; const existing = db.announcements.find(item => item.id === id);
    if (id !== null && !existing) throw new MockError(404, 'not_found', '公告不存在');
    if (method === 'DELETE') { db.announcements = db.announcements.filter(item => item.id !== id); audit(user, 'announcement.delete', 'announcement', id!, {}); return { ok: true }; }
    const input = record(body) as Partial<Announcement>;
    if (!existing && (!input.title?.trim() || !input.contentMd?.trim())) throw new MockError(400, 'validation', '请填写公告标题和内容');
    const value: Announcement = { id: id ?? db.nextId++, title: input.title ?? existing!.title, contentMd: input.contentMd ?? existing!.contentMd, enabled: input.enabled ?? existing?.enabled ?? true, pinned: input.pinned ?? existing?.pinned ?? false, createdAt: existing?.createdAt ?? now() };
    if (existing) Object.assign(existing, value); else db.announcements.unshift(value);
    audit(user, `announcement.${existing ? 'update' : 'create'}`, 'announcement', value.id, record(body)); return value;
  }
  if (route === '/admin/settings' && method === 'GET') return db.settings;
  if (route === '/admin/settings' && method === 'PUT') {
    const input = record(body) as Partial<SettingsMap>; const weights = input['scoring.weights'];
    if (weights !== undefined && (!weights || ['uptime', 'latency', 'trust', 'stability'].some(key => typeof record(weights)[key] !== 'number' || !Number.isFinite(record(weights)[key]) || Number(record(weights)[key]) < 0) || Object.values(weights).reduce((a, b) => a + b, 0) <= 0)) throw new MockError(400, 'validation', '评分权重必须为非负数，且总和大于 0');
    const keys = Object.keys(DEFAULT_SETTINGS) as (keyof SettingsMap)[];
    for (const key of keys) { const value = input[key]; const expected = DEFAULT_SETTINGS[key]; if (value === undefined || key === 'scoring.weights') continue; if (typeof value !== typeof expected || typeof expected === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) throw new MockError(400, 'validation', '请填写有效的系统设置，数值必须大于 0'); }
    Object.assign(db.settings, Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]])));
    if (weights) getMockMerchantSites().flatMap(site => site.channels).forEach(channel => { const stats = channel.stats; if (stats) stats.recommendScore = computeRecommendScore({ uptime24h: stats.uptime24h, latencyP50: stats.latencyP50, trustScore: stats.trustScore, consecutiveFailures: stats.consecutiveFailures, samples24h: stats.samples24h, weights: db.settings['scoring.weights'] }); });
    audit(user, 'settings.update', 'settings', 'global', record(body)); return db.settings;
  }
  if (route === '/admin/audit-logs' && method === 'GET') return page(db.audit.filter(item => match(`${item.action} ${item.targetType} ${item.actor?.email ?? ''}`, query)), query);
  return undefined;
}

export function getMockAdminAnnouncements(): Announcement[] { return state().announcements; }
export function getMockAdminModels(): AdminModel[] { return state().models; }
export function getMockAdminVendors(): AdminVendor[] { const db = state(); return db.vendors.map(vendor => ({ ...vendor, modelCount: db.models.filter(model => model.vendor.slug === vendor.slug).length })).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id); }
export function getMockReviewStatus(id: number): ReviewStatus { return mockCommunityStore.reviews.find(review => review.id === id)?.status ?? 'visible'; }
export function getMockUserStatus(id: string): 'active' | 'banned' { return mockCommunityStore.userStatus[id] ?? 'active'; }
