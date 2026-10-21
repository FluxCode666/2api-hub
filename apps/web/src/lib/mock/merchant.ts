import { actualRatio, AUTH_CHECKS } from '@hub/shared';
import type { AuthenticityReport, ChannelInput, ChannelModelsInput, MerchantChannel, MerchantChannelModel, MerchantOverview, MerchantSite, MerchantSiteDetail, Paginated, ProbeResult, ProbeRun, ProbeTask, SessionUser, SiteInput } from '@hub/shared';
import { mockChannels, mockModels, mockSites, mockUsers, mockVendors } from './fixtures';
import { MockError } from './error';

type State = { sites: MerchantSiteDetail[]; owners: Record<number, string>; invalidKeys: Record<number, boolean>; manualChecks: Record<number, string[]>; tasks: ProbeTask[]; runs: ProbeRun[]; nextSite: number; nextChannel: number; nextTask: number };
const scope = globalThis as typeof globalThis & { __hubMerchantMock?: State };
const now = () => new Date().toISOString();
const maskKey = (key: string) => `sk-****${key.length > 4 ? key.slice(-4) : ''}`;
function modelItem(upstreamName: string, id: number): MerchantChannelModel {
  const model = mockModels.find((m) => m.slug === upstreamName || m.aliases.includes(upstreamName));
  return { id, upstreamName, modelSlug: model?.slug ?? null, displayName: model?.displayName ?? null, priceOverrideInput: null, priceOverrideOutput: null, lastStatus: 'untested', lastLatencyMs: null, lastTestedAt: null, lastError: null, trustScore: null, trustVerdict: 'unknown' };
}
function state(): State {
  if (scope.__hubMerchantMock) { scope.__hubMerchantMock.manualChecks ??= {}; return scope.__hubMerchantMock; }
  const owner = mockUsers.find((u) => u.role === 'merchant')?.id ?? 'mock-merchant';
  const sites: MerchantSiteDetail[] = mockSites.map((s) => ({ id: s.id, slug: s.slug, name: s.name, homepageUrl: s.homepageUrl, inviteUrl: null, logoUrl: s.logoUrl, description: s.description, type: s.type, rechargeRatio: s.rechargeRatio, contact: s.contact, tags: s.tags, paymentMethods: s.paymentMethods, status: 'approved', reviewNote: null, submittedAt: s.createdAt, approvedAt: s.approvedAt, isVerified: s.isVerified, isFeatured: s.isFeatured, channelCount: s.channels.length, stats: s.stats, createdAt: s.createdAt, updatedAt: s.createdAt, channels: mockChannels.filter((c) => c.site.id === s.id).map((c) => ({ id: c.id, siteId: s.id, name: c.name, description: c.description, vendor: c.vendor, protocol: c.protocol, baseUrl: 'https://api.example.com', apiKeyMask: 'sk-****demo', groupRatio: c.groupRatio, actualRatio: c.actualRatio, billingType: c.billingType, primaryModel: c.primaryModel, backupModel: c.backupModel, rpmLimit: 120, status: c.status, probeEnabled: true, probeIntervalSec: 600, lastTestOk: c.stats.consecutiveFailures === 0, lastTestAt: c.stats.lastProbeAt, models: c.models.map((m) => ({ id: m.id, upstreamName: m.upstreamName, modelSlug: m.modelSlug, displayName: m.displayName, priceOverrideInput: null, priceOverrideOutput: null, lastStatus: m.lastStatus, lastLatencyMs: m.lastLatencyMs, lastTestedAt: m.lastTestedAt, lastError: m.lastError, trustScore: m.trustScore, trustVerdict: m.trustVerdict })), stats: c.stats, latestReport: c.latestReport, createdAt: c.createdAt, updatedAt: c.createdAt })) }));
  let nextSite = Math.max(0, ...sites.map((s) => s.id)) + 1;
  let nextChannel = Math.max(0, ...mockChannels.map((c) => c.id)) + 1;
  for (const [index, name] of ['青禾中转', '远山 AI'].entries()) {
    const template = sites[index]; if (!template?.channels[0]) continue;
    const site = structuredClone(template); site.id = nextSite++; site.slug = `pending-${site.id}`; site.name = name; site.homepageUrl = `https://${site.slug}.example.com`; site.status = 'pending'; site.reviewNote = null; site.approvedAt = null; site.submittedAt = now(); site.createdAt = now(); site.updatedAt = now(); site.isVerified = false; site.isFeatured = false; site.channelCount = 1;
    const channel = site.channels[0]!; channel.id = nextChannel++; channel.siteId = site.id; channel.name = '首发标准渠道'; channel.lastTestOk = true; channel.lastTestAt = now(); channel.models.forEach((m, i) => { m.id = channel.id * 100 + i; });
    if (channel.latestReport) { channel.latestReport.id = channel.id + 1000; channel.latestReport.channelId = channel.id; channel.latestReport.trigger = 'onboarding'; }
    site.channels = [channel]; if (site.stats) site.stats.channelCount = 1; sites.push(site);
  }
  const runs: ProbeRun[] = mockChannels.flatMap((c) => c.stats.sparkline.map((p, i) => ({ id: c.id * 1000 + i, channelId: c.id, model: c.primaryModel, protocol: c.protocol, kind: 'availability', trigger: 'schedule', success: p.ok, httpStatus: p.ok ? 200 : 502, errorCode: p.ok ? null : 'http_5xx', errorMessage: p.ok ? null : '上游暂时不可用', latencyMs: p.ms, ttftMs: p.ms === null ? null : Math.round(p.ms * .4), outputTokens: p.ok ? 4 : null, tokensPerSec: p.ok ? 75 : null, createdAt: p.t })));
  scope.__hubMerchantMock = structuredClone({ sites, owners: Object.fromEntries(sites.map((s) => [s.id, owner])), invalidKeys: {}, manualChecks: {}, tasks: [], runs, nextSite, nextChannel, nextTask: 1 });
  return scope.__hubMerchantMock;
}
export function getMockMerchantSites(): MerchantSiteDetail[] { return state().sites; }
export function getMockMerchantOwner(id: number): string | undefined { return state().owners[id]; }
export function updateMockMerchantSite(id: number, patch: Partial<MerchantSite>): MerchantSiteDetail | undefined {
  const s = state().sites.find((site) => site.id === id);
  if (s) Object.assign(s, patch, { updatedAt: now() });
  return s;
}
export function getMockMerchantTasks(): ProbeTask[] { state().tasks.forEach(advanceTask); return state().tasks; }
export function getMockMerchantRuns(): ProbeRun[] { return state().runs; }
function visible(user: SessionUser) { return state().sites.filter((s) => user.role === 'admin' || state().owners[s.id] === user.id); }
function ownSite(id: number, user: SessionUser) {
  const site = visible(user).find((s) => s.id === id);
  if (!site) throw new MockError(404, 'not_found', '站点不存在或无权访问');
  return site;
}
function ownChannel(id: number, user: SessionUser) {
  const site = visible(user).find((s) => s.channels.some((c) => c.id === id));
  const channel = site?.channels.find((c) => c.id === id);
  if (!site || !channel) throw new MockError(404, 'not_found', '渠道不存在或无权访问');
  return { site, channel };
}
function createTask(channelId: number, trigger: ProbeTask['trigger'], models?: string[]): ProbeTask {
  const task: ProbeTask = { id: state().nextTask++, channelId, kind: 'authenticity', trigger, status: 'queued', payload: models?.length ? { models } : {}, result: null, error: null, createdAt: now(), startedAt: null, finishedAt: null };
  state().tasks.unshift(task);
  return task;
}
function advanceTask(task: ProbeTask) {
  if (!['queued', 'running'].includes(task.status)) return;
  const age = Date.now() - Date.parse(task.createdAt);
  if (age < 1000) return;
  task.status = 'running'; task.startedAt ??= now();
  if (age < 2800) return;
  const channel = state().sites.flatMap((s) => s.channels).find((c) => c.id === task.channelId);
  if (!channel) { task.status = 'failed'; task.error = '渠道已删除'; task.finishedAt = now(); return; }
  const pass = !state().invalidKeys[channel.id] && !channel.baseUrl.includes('/dead');
  const report: AuthenticityReport = { id: task.id + 10000, channelId: channel.id, model: task.payload.models?.[0] ?? channel.primaryModel, protocol: channel.protocol, score: pass ? 95 : 10, verdict: pass ? 'genuine' : 'fake', checks: AUTH_CHECKS.map((c) => ({ id: c.id, name: c.name, weight: c.weight, passed: pass, detail: pass ? '检测样本符合目录模型特征。' : '样本未通过对应特征检查。' })), durationMs: 2800, trigger: task.trigger, createdAt: now() };
  task.status = 'done'; task.result = report; task.finishedAt = now(); channel.latestReport = report;
  channel.models.forEach((m) => { if (!task.payload.models?.length || task.payload.models.includes(m.upstreamName)) { m.trustScore = report.score; m.trustVerdict = report.verdict; } });
  if (channel.stats) { channel.stats.trustScore = report.score; channel.stats.trustVerdict = report.verdict; }
}
function validateSite(input: SiteInput) {
  if (!input.name?.trim() || !input.homepageUrl || !Number.isFinite(input.rechargeRatio) || input.rechargeRatio <= 0) throw new MockError(400, 'validation', '请填写站点名称、官网和有效充值倍率');
  try { const url = new URL(input.homepageUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { throw new MockError(400, 'validation', '请填写有效的站点网址'); }
}
function validateChannel(input: ChannelInput, creating = false) {
  if (!input.name?.trim() || !input.baseUrl || !input.primaryModel?.trim() || !Number.isFinite(input.groupRatio) || input.groupRatio <= 0 || (creating && !input.apiKey)) throw new MockError(400, 'validation', '请完整填写渠道名称、接口地址、主测模型、倍率和 API Key');
  try { const url = new URL(input.baseUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { throw new MockError(400, 'validation', '接口地址必须是有效的 HTTP 或 HTTPS 网址'); }
}
export async function mockMerchant(path: string, method: string, body: unknown, user: SessionUser | null): Promise<unknown> {
  if (!path.startsWith('/merchant/')) return undefined;
  if (!user) throw new MockError(401, 'unauthorized', '请先登录');
  const url = new URL(path, 'http://hub.local');
  const pathname = url.pathname;
  const db = state();
  if (pathname === '/merchant/overview' && method === 'GET') {
    const sites = visible(user); const channels = sites.flatMap((s) => s.channels); const uptimes = channels.flatMap((c) => c.stats?.uptime24h == null ? [] : [c.stats.uptime24h]);
    const overview: MerchantOverview = { siteCount: sites.length, approvedSiteCount: sites.filter((s) => s.status === 'approved').length, pendingSiteCount: sites.filter((s) => s.status === 'pending').length, channelCount: channels.length, activeChannelCount: channels.filter((c) => c.status === 'active').length, avgUptime24h: uptimes.length ? uptimes.reduce((a, b) => a + b, 0) / uptimes.length : null, alerts: channels.filter((c) => c.status === 'invalid' || (c.stats?.consecutiveFailures ?? 0) > 0).map((c) => ({ channelId: c.id, channelName: c.name, siteName: sites.find((s) => s.id === c.siteId)?.name ?? '', type: c.status === 'invalid' ? 'invalid' : 'degraded', message: c.status === 'invalid' ? '渠道已暂停自动探测，请检查接口后重新测试。' : '近期出现失败探测，请关注接口稳定性。', at: c.stats?.lastProbeAt ?? c.updatedAt })), channels: channels.map((c) => ({ id: c.id, name: c.name, siteId: c.siteId, siteName: sites.find((s) => s.id === c.siteId)?.name ?? '', status: c.status, stats: c.stats })) };
    return overview;
  }
  if (pathname === '/merchant/sites' && method === 'GET') return visible(user).map(({ channels: _channels, ...s }) => s);
  if (pathname === '/merchant/sites' && method === 'POST') {
    const input = body as SiteInput; validateSite(input);
    const id = db.nextSite++; const slug = input.slug?.trim() || `site-${id}`;
    if (db.sites.some((s) => s.slug === slug)) throw new MockError(409, 'slug_exists', '此站点标识已被使用');
    const site: MerchantSiteDetail = { id, slug, name: input.name.trim(), homepageUrl: input.homepageUrl, inviteUrl: input.inviteUrl ?? null, logoUrl: input.logoUrl ?? null, description: input.description ?? null, type: input.type, rechargeRatio: input.rechargeRatio, contact: input.contact ?? {}, tags: input.tags ?? [], paymentMethods: input.paymentMethods ?? [], status: 'draft', reviewNote: null, submittedAt: null, approvedAt: null, isVerified: false, isFeatured: false, channelCount: 0, stats: null, createdAt: now(), updatedAt: now(), channels: [] };
    db.sites.push(site); db.owners[id] = user.id; return site;
  }
  const siteMatch = pathname.match(/^\/merchant\/sites\/(\d+)(?:\/(submit|channels))?$/);
  if (siteMatch) {
    const site = ownSite(Number(siteMatch[1]), user); const action = siteMatch[2];
    if (!action && method === 'GET') return site;
    if (!action && method === 'PATCH') {
      const input = { ...site, ...body as Partial<SiteInput> }; validateSite(input);
      const prevRatio = site.rechargeRatio;
      const fields: (keyof SiteInput)[] = ['name', 'homepageUrl', 'inviteUrl', 'logoUrl', 'description', 'type', 'rechargeRatio', 'contact', 'tags', 'paymentMethods'];
      const patch = Object.fromEntries(fields.filter((key) => key in (body as object)).map((key) => [key, input[key]]));
      Object.assign(site, patch, { updatedAt: now() }); site.channels.forEach((c) => { c.actualRatio = actualRatio(c.groupRatio, site.rechargeRatio); if (prevRatio !== site.rechargeRatio && site.status === 'approved') createTask(c.id, 'merchant'); }); return site;
    }
    if (!action && method === 'DELETE') {
      if (!['draft', 'rejected'].includes(site.status)) throw new MockError(409, 'site_locked', '仅草稿或被驳回的站点可删除');
      const channelIds = new Set(site.channels.map((c) => c.id));
      db.tasks = db.tasks.filter((t) => !channelIds.has(t.channelId)); db.runs = db.runs.filter((r) => !channelIds.has(r.channelId));
      for (const channelId of channelIds) { delete db.invalidKeys[channelId]; delete db.manualChecks[channelId]; }
      delete db.owners[site.id]; db.sites = db.sites.filter((s) => s.id !== site.id); return { ok: true };
    }
    if (action === 'submit' && method === 'POST') {
      if (!['draft', 'rejected'].includes(site.status)) throw new MockError(409, 'site_locked', '当前状态无需重复提交');
      if (!site.channels.some((c) => c.lastTestOk)) throw new MockError(400, 'test_required', '请先让至少一个渠道通过连接测试');
      site.status = 'pending'; site.submittedAt = now(); site.reviewNote = null; site.channels.forEach((c) => createTask(c.id, 'onboarding')); return site;
    }
    if (action === 'channels' && method === 'POST') {
      const input = body as ChannelInput; validateChannel(input, true); const id = db.nextChannel++;
      const channel: MerchantChannel = { id, siteId: site.id, name: input.name, description: input.description ?? null, vendor: mockVendors.find((v) => v.slug === input.vendorSlug) ?? null, protocol: input.protocol, baseUrl: input.baseUrl, apiKeyMask: maskKey(input.apiKey ?? ''), groupRatio: input.groupRatio, actualRatio: actualRatio(input.groupRatio, site.rechargeRatio), billingType: input.billingType ?? 'per_token', primaryModel: input.primaryModel, backupModel: input.backupModel ?? null, rpmLimit: input.rpmLimit ?? null, status: 'active', probeEnabled: true, probeIntervalSec: 600, lastTestOk: null, lastTestAt: null, models: (input.declaredModels?.length ? [...new Set(input.declaredModels)] : [input.primaryModel]).map((name, index) => modelItem(name, id * 100 + index)), stats: null, latestReport: null, createdAt: now(), updatedAt: now() };
      db.invalidKeys[id] = input.apiKey === 'invalid-key'; site.channels.push(channel); site.channelCount = site.channels.length; return channel;
    }
  }
  const channelMatch = pathname.match(/^\/merchant\/channels\/(\d+)(?:\/(test|discover|models|authenticity|runs))?$/);
  if (channelMatch) {
    const { channel, site } = ownChannel(Number(channelMatch[1]), user); const action = channelMatch[2];
    if (!action && method === 'PATCH') {
      const input = body as Partial<ChannelInput>; const merged: ChannelInput = { ...channel, ...input }; validateChannel(merged);
      const connectionChanged = (input.baseUrl !== undefined && input.baseUrl !== channel.baseUrl) || Boolean(input.apiKey) || (input.primaryModel !== undefined && input.primaryModel !== channel.primaryModel) || (input.protocol !== undefined && input.protocol !== channel.protocol);
      const critical = connectionChanged || (input.groupRatio !== undefined && input.groupRatio !== channel.groupRatio);
      const { apiKey: _apiKey, declaredModels: _declaredModels, vendorSlug: _vendorSlug, ...values } = input;
      Object.assign(channel, values, { updatedAt: now() });
      if (input.apiKey) { channel.apiKeyMask = maskKey(input.apiKey); db.invalidKeys[channel.id] = input.apiKey === 'invalid-key'; }
      if (connectionChanged) channel.lastTestOk = null;
      if (input.vendorSlug !== undefined) channel.vendor = mockVendors.find((v) => v.slug === input.vendorSlug) ?? null;
      if (input.declaredModels) channel.models = [...new Set(input.declaredModels)].map((name, index) => channel.models.find((m) => m.upstreamName === name) ?? modelItem(name, channel.id * 100 + index));
      channel.actualRatio = actualRatio(channel.groupRatio, site.rechargeRatio);
      if (critical && site.status === 'approved') createTask(channel.id, 'merchant');
      return channel;
    }
    if (!action && method === 'DELETE') { site.channels = site.channels.filter((c) => c.id !== channel.id); site.channelCount = site.channels.length; db.tasks = db.tasks.filter((t) => t.channelId !== channel.id); db.runs = db.runs.filter((r) => r.channelId !== channel.id); delete db.invalidKeys[channel.id]; delete db.manualChecks[channel.id]; return { ok: true }; }
    if (action === 'test' && method === 'POST') {
      const success = !db.invalidKeys[channel.id] && !channel.baseUrl.includes('/dead');
      const result: ProbeResult = { success, model: (body as { model?: string } | null)?.model ?? channel.primaryModel, protocol: channel.protocol, httpStatus: success ? 200 : db.invalidKeys[channel.id] ? 401 : 503, errorCode: success ? null : db.invalidKeys[channel.id] ? 'http_401' : 'http_5xx', errorMessage: success ? null : '连接失败，请检查接口地址、模型和检测密钥。', latencyMs: success ? 846 : null, ttftMs: success ? 316 : null, inputTokens: success ? 12 : null, outputTokens: success ? 4 : null, tokensPerSec: success ? 78 : null, sample: success ? 'pong' : null, at: now() };
      channel.lastTestOk = success; channel.lastTestAt = result.at;
      const model = channel.models.find((m) => m.upstreamName === result.model); if (model) { model.lastStatus = success ? 'pass' : 'fail'; model.lastTestedAt = result.at; model.lastLatencyMs = result.latencyMs; model.lastError = result.errorMessage; }
      db.runs.unshift({ id: Date.now(), channelId: channel.id, model: result.model, protocol: channel.protocol, kind: 'availability', trigger: 'merchant', success, httpStatus: result.httpStatus, errorCode: result.errorCode, errorMessage: result.errorMessage, latencyMs: result.latencyMs, ttftMs: result.ttftMs, outputTokens: result.outputTokens, tokensPerSec: result.tokensPerSec, createdAt: result.at }); return result;
    }
    if (action === 'discover' && method === 'POST') {
      if (db.invalidKeys[channel.id] || channel.baseUrl.includes('/dead')) throw new MockError(502, 'discovery_failed', '获取上游模型失败，请先检查连接');
      const models = mockModels.filter((m) => !channel.vendor || m.vendor.slug === channel.vendor.slug).slice(0, 5);
      channel.models = [...new Set([channel.primaryModel, ...models.map((m) => m.slug)])].map((name, index) => channel.models.find((m) => m.upstreamName === name) ?? modelItem(name, channel.id * 100 + index)); return channel.models;
    }
    if (action === 'models' && method === 'PUT') {
      const input = body as ChannelModelsInput;
      channel.models = input.models.map((m, index) => { const model = m.modelSlug ? mockModels.find((v) => v.slug === m.modelSlug) : undefined; return { ...(channel.models.find((v) => v.upstreamName === m.upstreamName) ?? modelItem(m.upstreamName, channel.id * 100 + index)), modelSlug: model?.slug ?? null, displayName: model?.displayName ?? null, priceOverrideInput: m.priceOverrideInput ?? null, priceOverrideOutput: m.priceOverrideOutput ?? null }; }); return channel.models;
    }
    if (action === 'authenticity' && method === 'POST') {
      const day = now().slice(0, 10); const checks = (db.manualChecks[channel.id] ?? []).filter((value) => value === day);
      if (checks.length >= 3) throw new MockError(429, 'daily_limit', '本渠道今日手动检测次数已达上限（3 次）');
      db.manualChecks[channel.id] = [...checks, day];
      return createTask(channel.id, 'merchant', (body as { models?: string[] } | null)?.models);
    }
    if (action === 'runs' && method === 'GET') {
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1); const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 20));
      const runs = db.runs.filter((r) => r.channelId === channel.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const result: Paginated<ProbeRun> = { items: runs.slice((page - 1) * pageSize, page * pageSize), total: runs.length, page, pageSize }; return result;
    }
  }
  const taskMatch = pathname.match(/^\/merchant\/tasks\/(\d+)$/);
  if (taskMatch && method === 'GET') {
    const task = db.tasks.find((t) => t.id === Number(taskMatch[1]));
    if (!task) throw new MockError(404, 'not_found', '任务不存在');
    ownChannel(task.channelId, user); advanceTask(task); return task;
  }
  return undefined;
}
