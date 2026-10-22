import {
  DEFAULT_SORT_ORDER,
  type ChannelDetail, type ChannelHistory, type ChannelListItem, type ChannelSort, type FeedbackItem,
  type HistoryWindow, type MyReview, type Paginated, type ProbeRun, type SessionUser, type SiteDetail,
  type VerifyRequest,
} from '@hub/shared';
import { getMockAdminAnnouncements, getMockAdminVendors, mockAdmin } from './admin';
import { getMockMerchantSites, mockMerchant } from './merchant';
import { MockError } from './error';
import { mockNow, mockReport, mockUsers } from './fixtures';
import { mockCommunityStore, type StoredReview } from './store';
import { publicChannels, publicModels, publicSites, publicVendors } from './public';
export { mockCommunityStore } from './store';

export function mockCookieToken(user: SessionUser): string {
  const seed = mockUsers.find((item) => item.id === user.id);
  return seed ? `mock-${seed.role}` : `mock-${user.id}`;
}

export function mockSession(cookie: string): SessionUser | null {
  const match = cookie.match(/(?:^|;\s*)hub_session=([^;]+)/);
  if (!match) return null;
  let token: string;
  try { token = decodeURIComponent(match[1]!); } catch { return null; }
  return mockCommunityStore.users.find((user) => mockCookieToken(user) === token && mockCommunityStore.userStatus[user.id] !== 'banned') ?? null;
}

export function paginate<T>(items: T[], query: URLSearchParams): Paginated<T> {
  const positive = (key: string, fallback: number) => {
    const value = Number(query.get(key) ?? fallback);
    if (!Number.isInteger(value) || value < 1) throw new MockError(400, 'invalid_pagination', '分页参数必须为正整数。');
    return value;
  };
  const page = positive('page', 1);
  const pageSize = Math.min(100, positive('pageSize', 20));
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MockError(400, 'invalid_body', '请提交有效的表单内容。');
  return body as Record<string, unknown>;
}
function requiredUser(user: SessionUser | null): SessionUser {
  if (!user) throw new MockError(401, 'unauthorized', '请先登录。');
  return user;
}
function textMatch(text: string, query: string | null): boolean {
  return !query || query.toLocaleLowerCase().trim().split(/\s+/).every((word) => text.toLocaleLowerCase().includes(word));
}
function channelFor(id: number): ChannelDetail {
  const channel = publicChannels().find((item) => item.id === id);
  if (!channel) throw new MockError(404, 'channel_not_found', '没有找到该渠道。');
  return channel;
}
function siteFor(slug: string): SiteDetail {
  const site = publicSites().find((item) => item.slug === slug);
  if (!site) throw new MockError(404, 'site_not_found', '没有找到该站点。');
  return site;
}
function withFavorite<T extends ChannelListItem>(channel: T, user: SessionUser | null): T {
  return { ...channel, isFavorite: user ? (mockCommunityStore.favorites[user.id] ?? []).includes(channel.id) : false };
}

function channelList(query: URLSearchParams, user: SessionUser | null): ChannelListItem[] {
  const ids = query.get('ids')?.split(',').map(Number);
  const model = query.get('model');
  for (const key of ['siteId', 'maxRatio', 'minUptime', 'minTrust']) {
    if (query.has(key) && !Number.isFinite(Number(query.get(key)))) throw new MockError(400, 'invalid_filter', '筛选数值无效。');
  }
  const sort = (query.get('sort') ?? 'recommend') as ChannelSort;
  if (!Object.hasOwn(DEFAULT_SORT_ORDER, sort)) throw new MockError(400, 'invalid_sort', '不支持的排序方式。');
  const order = query.get('order') ?? DEFAULT_SORT_ORDER[sort];
  if (!['asc', 'desc'].includes(order)) throw new MockError(400, 'invalid_order', '排序方向无效。');
  const items = publicChannels().filter((channel) => {
    if (ids && !ids.includes(channel.id)) return false;
    if (model && !channel.models.some((item) => item.modelSlug === model)) return false;
    const vendor = query.get('vendor');
    if (vendor && channel.vendor?.slug !== vendor && !channel.models.some((item) => item.vendorSlug === vendor)) return false;
    if (!textMatch(`${channel.site.name} ${channel.name} ${channel.description ?? ''}`, query.get('q'))) return false;
    if (query.has('siteId') && channel.site.id !== Number(query.get('siteId'))) return false;
    if (query.has('maxRatio') && channel.actualRatio > Number(query.get('maxRatio'))) return false;
    if (query.has('minUptime') && (channel.stats.uptime24h === null || channel.stats.uptime24h < Number(query.get('minUptime')))) return false;
    if (query.has('minTrust') && (channel.stats.trustScore === null || channel.stats.trustScore < Number(query.get('minTrust')))) return false;
    if (query.get('stableOnly') === 'true' && ((channel.stats.uptime24h ?? 0) < 0.95 || channel.stats.samples24h < 12)) return false;
    if (query.get('protocol') && channel.protocol !== query.get('protocol')) return false;
    return true;
  }).map((channel) => {
    const selected = model ? channel.models.find((item) => item.modelSlug === model) : null;
    return withFavorite({ ...channel, price: selected && model ? { modelSlug: model, upstreamName: selected.upstreamName, inputCny: selected.inputPriceCny, outputCny: selected.outputPriceCny, isOverride: false } : channel.price }, user);
  });
  const value = (item: ChannelListItem): number | null => {
    switch (sort) {
      case 'price': return item.price?.inputCny ?? null;
      case 'ratio': return item.actualRatio;
      case 'uptime': return item.stats.uptime24h;
      case 'latency': return item.stats.latencyP50;
      case 'trust': return item.stats.trustScore;
      case 'updated': return item.stats.lastProbeAt ? Date.parse(item.stats.lastProbeAt) : null;
      default: return item.stats.recommendScore;
    }
  };
  return items.sort((a, b) => {
    const av = value(a); const bv = value(b);
    if (av === null) return bv === null ? a.id - b.id : 1;
    if (bv === null) return -1;
    return (order === 'asc' ? av - bv : bv - av) || a.id - b.id;
  }).map((channel, index) => ({ ...channel, rank: index + 1 }));
}

export function mockRuns(channel: ChannelDetail): ProbeRun[] {
  return channel.stats.sparkline.slice(-50).reverse().map((point, index) => ({
    id: channel.id * 10000 + index, channelId: channel.id, model: channel.primaryModel, protocol: channel.protocol,
    kind: 'availability', trigger: 'schedule', success: point.ok, httpStatus: point.ok ? 200 : 503,
    errorCode: point.ok ? null : 'http_5xx', errorMessage: point.ok ? null : '演示数据：上游服务暂时不可用。',
    latencyMs: point.ms, ttftMs: point.ms === null ? null : Math.round(point.ms * 0.45), outputTokens: point.ok ? 16 : null,
    tokensPerSec: point.ok ? 80 : null, createdAt: point.t,
  }));
}

function channelHistory(channel: ChannelDetail, query: URLSearchParams): ChannelHistory {
  const window = (query.get('window') ?? '24h') as HistoryWindow;
  const windows: Record<HistoryWindow, [number, number]> = { '1h': [60, 60], '24h': [1800, 48], '7d': [10800, 56], '30d': [43200, 60] };
  if (!Object.hasOwn(windows, window)) throw new MockError(400, 'invalid_window', '请选择 1h、24h、7d 或 30d。');
  const [bucketSec, count] = windows[window];
  return { window, bucketSec, points: channel.stats.samples24h === 0 ? [] : Array.from({ length: count }, (_, index) => {
    const sample = channel.stats.sparkline[index % channel.stats.sparkline.length]!;
    return { t: new Date(Date.parse(mockNow) - (count - 1 - index) * bucketSec * 1000).toISOString(), total: 3, ok: sample.ok ? 3 : 0,
      latencyP50: sample.ms, ttftAvg: sample.ms === null ? null : Math.round(sample.ms * 0.45) };
  }), recentRuns: mockRuns(channel) };
}

export async function mockRequest(path: string, method: string, body: unknown, user: SessionUser | null): Promise<unknown> {
  const url = new URL(path.replace(/^\/api\/v1(?=\/|$)/, ''), 'http://mock.internal');
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  const query = url.searchParams;
  const verb = method.toUpperCase();
  if (pathname.startsWith('/merchant')) return mockMerchant(`${pathname}${url.search}`, verb, body, requiredUser(user));
  if (pathname.startsWith('/admin')) {
    const admin = requiredUser(user);
    if (admin.role !== 'admin') throw new MockError(403, 'forbidden', '仅管理员可访问。');
    return mockAdmin(`${pathname}${url.search}`, verb, body, admin);
  }

  if (verb === 'GET' && pathname === '/meta') return {
    vendors: publicVendors(), featuredModels: publicModels().filter((model) => model.isFeatured),
    counts: { sites: publicSites().length, channels: publicChannels().length, models: publicModels().length, probes24h: publicChannels().reduce((sum, channel) => sum + channel.stats.samples24h, 0) }, lastProbeAt: mockNow,
  };
  if (verb === 'GET' && pathname === '/vendors') return publicVendors();
  if (verb === 'GET' && pathname.startsWith('/vendors/')) {
    const vendor = publicVendors().find((item) => item.slug === pathname.split('/')[2]);
    if (!vendor) throw new MockError(404, 'vendor_not_found', '没有找到该厂商。');
    const details = getMockAdminVendors().find((item) => item.slug === vendor.slug);
    return { ...vendor, website: details?.website ?? null,
      description: details?.description ?? `${vendor.name} 模型目录与公开渠道。`, models: publicModels().filter((model) => model.vendor.slug === vendor.slug) };
  }
  if (verb === 'GET' && pathname === '/models') return publicModels().filter((model) =>
    (!query.get('vendor') || model.vendor.slug === query.get('vendor')) && textMatch(`${model.slug} ${model.displayName} ${model.vendor.name}`, query.get('q')) &&
    (!query.get('modality') || model.modality === query.get('modality')) && (query.get('featured') !== 'true' || model.isFeatured));
  if (verb === 'GET' && pathname.startsWith('/models/')) {
    const model = publicModels().find((item) => item.slug === pathname.split('/')[2]);
    if (!model) throw new MockError(404, 'model_not_found', '没有找到该模型。');
    return model;
  }
  if (verb === 'GET' && pathname === '/channels') return paginate(channelList(query, user), query);
  const channelPath = pathname.match(/^\/channels\/(\d+)(?:\/(history|reports|runs))?$/);
  if (verb === 'GET' && channelPath) {
    const channel = channelFor(Number(channelPath[1]));
    if (channelPath[2] === 'history') return channelHistory(channel, query);
    if (channelPath[2] === 'runs') {
      const success = query.get('success'); const kind = query.get('kind');
      if (success !== null && !['true', 'false'].includes(success)) throw new MockError(400, 'invalid_success', '成功状态必须为 true 或 false。');
      if (kind !== null && !['availability', 'authenticity', 'discovery'].includes(kind)) throw new MockError(400, 'invalid_kind', '不支持的探测类型。');
      return paginate(mockRuns(channel).filter(run => (!kind || run.kind === kind) && (!success || run.success === (success === 'true'))).slice(0, 10000), query);
    }
    if (channelPath[2] === 'reports') return channel.latestReport ? [channel.latestReport] : [];
    return withFavorite(channel, user);
  }
  if (verb === 'GET' && pathname === '/sites') {
    const sites = publicSites().filter((site) => textMatch(`${site.name} ${site.description ?? ''}`, query.get('q')) &&
      (!query.get('type') || site.type === query.get('type')) && (!query.get('vendor') || site.stats.vendorSlugs.includes(query.get('vendor')!)));
    const sort = query.get('sort') ?? 'score';
    if (!['score', 'uptime', 'channels', 'newest'].includes(sort)) throw new MockError(400, 'invalid_sort', '不支持的排序方式。');
    const value = (site: SiteDetail) => sort === 'uptime' ? site.stats.avgUptime24h : sort === 'channels' ? site.stats.channelCount : sort === 'newest' ? Date.parse(site.createdAt) : site.stats.bestRecommendScore;
    sites.sort((a, b) => (value(b) ?? -Infinity) - (value(a) ?? -Infinity));
    return paginate(sites, query);
  }
  const sitePath = pathname.match(/^\/sites\/([^/]+)(?:\/(reviews))?$/);
  if (sitePath) {
    const site = siteFor(decodeURIComponent(sitePath[1]!));
    if (verb === 'GET' && sitePath[2] === 'reviews') return paginate(mockCommunityStore.reviews.filter((review) => review.siteId === site.id && review.status !== 'hidden').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id).map(({ userId: _userId, siteId: _siteId, status: _status, ...review }) => review), query);
    if (verb === 'POST' && sitePath[2] === 'reviews') {
      const actor = requiredUser(user); const data = objectBody(body);
      if (!Number.isInteger(data.rating) || Number(data.rating) < 1 || Number(data.rating) > 5 || typeof data.content !== 'string' || !data.content.trim()) throw new MockError(400, 'invalid_review', '请填写 1–5 分评分与评价内容。');
      const existing = mockCommunityStore.reviews.find((review) => review.userId === actor.id && review.siteId === site.id);
      const review: StoredReview = { id: existing?.id ?? Date.now(), siteId: site.id, userId: actor.id, rating: Number(data.rating), content: data.content.trim(), user: { nickname: actor.nickname, avatarUrl: actor.avatarUrl }, createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
      if (existing) Object.assign(existing, review); else mockCommunityStore.reviews.push(review);
      const { userId: _userId, siteId: _siteId, status: _status, ...result } = review;
      return result;
    }
    if (verb === 'GET' && !sitePath[2]) return { ...site, channels: site.channels.map((channel) => withFavorite(channel, user)) };
  }
  if (verb === 'GET' && pathname === '/rankings/overview') return {
    updatedAt: mockNow, models: publicModels().filter((model) => model.isFeatured).map((model) => ({ model, top: channelList(new URLSearchParams({ model: model.slug }), user).slice(0, 3) })),
  };
  if (verb === 'GET' && pathname === '/announcements') return getMockAdminAnnouncements().filter((announcement) => announcement.enabled);
  if (verb === 'GET' && /^\/go\/\d+$/.test(pathname)) return { url: channelFor(Number(pathname.split('/')[2])).site.homepageUrl };

  if (verb === 'POST' && pathname === '/verify') {
    const data = objectBody(body);
    if (typeof data.baseUrl !== 'string' || typeof data.apiKey !== 'string' || !data.apiKey || typeof data.model !== 'string' || !data.model || !['openai_chat', 'openai_responses', 'anthropic', 'gemini'].includes(String(data.protocol))) throw new MockError(400, 'invalid_verify', '请填写完整的 API 地址、Key、模型与协议。');
    let target: URL;
    try { target = new URL(data.baseUrl); } catch { throw new MockError(400, 'invalid_url', '请输入有效的 API 地址。'); }
    if (!['https:', 'http:'].includes(target.protocol)) throw new MockError(400, 'invalid_url', '仅支持 HTTP 或 HTTPS 地址。');
    const request = data as unknown as VerifyRequest;
    const failed = request.apiKey === 'invalid-key';
    return { ...mockReport, id: null, channelId: null, model: request.model, protocol: request.protocol, trigger: 'public', createdAt: new Date().toISOString(),
      score: failed ? null : 100, verdict: failed ? 'unknown' : 'genuine', durationMs: 0,
      checks: mockReport.checks.map((check) => ({ ...check, passed: failed ? check.id === 'connectivity' ? false : null : true,
        detail: failed ? '演示模式：输入了 invalid-key，模拟鉴权失败；未向目标地址发起请求。' : '演示模式：此结果为模拟报告，未向目标地址发起请求，也未保存 API Key。' })) };
  }
  if (verb === 'POST' && pathname === '/feedback') {
    const data = objectBody(body);
    if (!['recommend_site', 'suggestion', 'complaint', 'bug'].includes(String(data.type)) || typeof data.content !== 'string' || !data.content.trim()) throw new MockError(400, 'invalid_feedback', '请选择反馈类型并填写内容。');
    const feedback: FeedbackItem = { id: Date.now(), type: data.type as FeedbackItem['type'], content: data.content.trim(),
      siteName: typeof data.siteName === 'string' ? data.siteName : null, siteUrl: typeof data.siteUrl === 'string' ? data.siteUrl : null,
      contact: typeof data.contact === 'string' ? data.contact : null, status: 'new', user: user ? { id: user.id, email: user.email, nickname: user.nickname } : null, createdAt: new Date().toISOString() };
    mockCommunityStore.feedback.push(feedback); return { id: feedback.id };
  }
  if (verb === 'GET' && pathname === '/auth/me') return requiredUser(user);
  if (verb === 'POST' && pathname === '/auth/logout') return { ok: true };
  if (verb === 'POST' && (pathname === '/auth/login' || pathname === '/auth/register')) {
    const data = objectBody(body);
    if (typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || typeof data.password !== 'string' || data.password.length < 8 || data.password.length > 100) throw new MockError(400, 'invalid_credentials', '请填写有效邮箱和 8–100 位密码。');
    const email = data.email.toLowerCase().trim();
    const existing = mockCommunityStore.users.find((item) => item.email === email);
    if (pathname === '/auth/login') {
      if (!existing || mockCommunityStore.passwords[email] !== data.password) throw new MockError(401, 'invalid_credentials', '邮箱或密码错误。');
      if (mockCommunityStore.userStatus[existing.id] === 'banned') throw new MockError(403, 'account_banned', '该账号已停用。');
      return existing;
    }
    if (existing) throw new MockError(409, 'email_exists', '该邮箱已注册。');
    const created: SessionUser = { id: crypto.randomUUID(), email, nickname: typeof data.nickname === 'string' && data.nickname.trim() ? data.nickname.trim() : email.split('@')[0]!, avatarUrl: null, role: 'user', createdAt: new Date().toISOString() };
    mockCommunityStore.users.push(created); mockCommunityStore.passwords[email] = data.password; return created;
  }
  if (pathname.startsWith('/me/')) {
    const actor = requiredUser(user);
    if (verb === 'GET' && pathname === '/me/reviews') {
      const sites = getMockMerchantSites();
      const reviews: MyReview[] = mockCommunityStore.reviews.filter((review) => review.userId === actor.id)
        .flatMap(({ userId: _userId, siteId, status, ...review }) => {
          const site = sites.find((item) => item.id === siteId);
          return site ? [{ ...review, status: status ?? 'visible', site: { id: site.id, slug: site.slug, name: site.name } }] : [];
        }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
      return paginate(reviews, query);
    }
    const myReviewPath = pathname.match(/^\/me\/reviews\/(\d+)$/);
    if (verb === 'DELETE' && myReviewPath) {
      const review = mockCommunityStore.reviews.find((item) => item.id === Number(myReviewPath[1]) && item.userId === actor.id);
      if (!review) throw new MockError(404, 'review_not_found', '没有找到该评价。');
      mockCommunityStore.reviews = mockCommunityStore.reviews.filter((item) => item !== review);
      return { ok: true };
    }
    const favorites = mockCommunityStore.favorites[actor.id] ??= [];
    if (verb === 'GET' && pathname === '/me/favorites') return paginate(publicChannels().filter((channel) => favorites.includes(channel.id)).map((channel, index) => ({ ...withFavorite(channel, actor), rank: index + 1 })), query);
    const favoritePath = pathname.match(/^\/me\/favorites\/(\d+)$/);
    if (favoritePath && ['POST', 'DELETE'].includes(verb)) {
      const channel = channelFor(Number(favoritePath[1]));
      if (verb === 'POST' && !favorites.includes(channel.id)) favorites.push(channel.id);
      if (verb === 'DELETE') mockCommunityStore.favorites[actor.id] = favorites.filter((id) => id !== channel.id);
      return { ok: true };
    }
    const notifications = mockCommunityStore.notifications[actor.id] ??= [{ id: 1, type: 'welcome', title: '欢迎来到 2API Hub', body: '收藏感兴趣的渠道，随时比较价格与稳定性。此通知为演示数据。', link: '/rankings', readAt: null, createdAt: mockNow }];
    if (verb === 'GET' && pathname === '/me/notifications') return { ...paginate([...notifications].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), query), unreadCount: notifications.filter(item => !item.readAt).length };
    if (verb === 'POST' && pathname === '/me/notifications/read') {
      const data = body ? objectBody(body) : {};
      if (data.ids !== undefined && (!Array.isArray(data.ids) || !data.ids.every((id) => Number.isInteger(id)))) throw new MockError(400, 'invalid_ids', '通知编号必须为数字数组。');
      for (const notification of notifications) if (!data.ids || (data.ids as number[]).includes(notification.id)) notification.readAt = new Date().toISOString();
      return { ok: true };
    }
  }
  throw new MockError(404, 'not_found', '没有找到该接口。');
}
