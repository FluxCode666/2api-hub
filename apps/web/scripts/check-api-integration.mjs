import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 运行时只校验 @hub/shared 契约的必要字段，不输出凭据或完整响应。
/** @typedef {import('@hub/shared').MyReview} MyReview */
/** @typedef {import('@hub/shared').ChannelListItem} ChannelListItem */
const apiOrigin = (process.env.HUB_API_URL ?? process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:8711').replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
const webOrigin = process.env.HUB_WEB_URL?.replace(/\/$/, '');
const writes = process.env.HUB_INTEGRATION_WRITES === '1';
const directory = fileURLToPath(new URL('../artifacts/', import.meta.url));
const results = [];
const protocolValues = ['openai_chat', 'openai_responses', 'anthropic', 'gemini'];
let retainedAccount = false;

function shape(value, fields, label = 'response') {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} 应为对象`);
  for (const [field, declared] of Object.entries(fields)) {
    assert(Object.hasOwn(value, field), `${label}.${field} 缺失`);
    const nullable = declared.endsWith('?');
    if (nullable && value[field] === null) continue;
    const type = nullable ? declared.slice(0, -1) : declared;
    if (type === 'array') assert(Array.isArray(value[field]), `${label}.${field} 应为数组`);
    else if (type === 'iso') assert(typeof value[field] === 'string' && Number.isFinite(Date.parse(value[field])), `${label}.${field} 应为 ISO 时间`);
    else if (type === 'number') assert(typeof value[field] === 'number' && Number.isFinite(value[field]), `${label}.${field} 应为有限数值`);
    else if (type === 'object') assert(value[field] && typeof value[field] === 'object' && !Array.isArray(value[field]), `${label}.${field} 应为对象`);
    else assert.equal(typeof value[field], type, `${label}.${field} 类型不符`);
  }
  return value;
}
function page(value, validate) {
  shape(value, { items: 'array', total: 'number', page: 'number', pageSize: 'number' });
  assert(Number.isInteger(value.total) && value.total >= 0 && value.page >= 1 && value.pageSize >= 1, '分页字段无效');
  assert(value.items.length <= value.pageSize, '返回条数超过 pageSize');
  value.items.forEach(validate);
  return value;
}
function vendor(value) { shape(value, { slug: 'string', name: 'string', nameZh: 'string?', color: 'string', iconUrl: 'string?' }, 'vendor'); }
function model(value) {
  shape(value, { id: 'number', slug: 'string', displayName: 'string', family: 'string?', modality: 'string', tier: 'string', officialInputPrice: 'number?', officialOutputPrice: 'number?', contextWindow: 'number?', isFeatured: 'boolean', channelCount: 'number', minInputPriceCny: 'number?', bestUptime24h: 'number?' }, 'model');
  vendor(value.vendor);
}
function stats(value) {
  shape(value, { uptime1h: 'number?', uptime24h: 'number?', uptime7d: 'number?', samples24h: 'number', latencyP50: 'number?', latencyP95: 'number?', ttftAvg: 'number?', consecutiveFailures: 'number', lastSuccessAt: 'iso?', lastFailureAt: 'iso?', lastProbeAt: 'iso?', trustScore: 'number?', trustVerdict: 'string', recommendScore: 'number?', sparkline: 'array' }, 'stats');
  for (const key of ['uptime1h', 'uptime24h', 'uptime7d']) assert(value[key] === null || value[key] >= 0 && value[key] <= 1, `${key} 应为 0–1 或 null`);
  for (const point of value.sparkline) shape(point, { t: 'iso', ok: 'boolean', ms: 'number?' }, 'sparkline');
  assert(value.sparkline.length <= 60, 'sparkline 超过 60 格');
}
function channel(value) {
  shape(value, { id: 'number', rank: 'number', name: 'string', description: 'string?', protocol: 'string', billingType: 'string', status: 'string', groupRatio: 'number', rechargeRatio: 'number', actualRatio: 'number', modelCount: 'number', models: 'array', isFavorite: 'boolean' }, 'channel');
  shape(value.site, { id: 'number', slug: 'string', name: 'string', logoUrl: 'string?', homepageUrl: 'string', type: 'string', isVerified: 'boolean' }, 'channel.site');
  assert(protocolValues.includes(value.protocol), '渠道协议不属于契约枚举');
  assert(Math.abs(value.groupRatio / value.rechargeRatio - value.actualRatio) < 0.0002, '实际倍率与分组/充值倍率不一致');
  if (value.vendor !== null) vendor(value.vendor);
  if (value.price !== null) shape(value.price, { modelSlug: 'string', upstreamName: 'string', inputCny: 'number?', outputCny: 'number?', isOverride: 'boolean' }, 'price');
  value.models.forEach(item => shape(item, { upstreamName: 'string', modelSlug: 'string?', displayName: 'string?', vendorSlug: 'string?', lastStatus: 'string', trustScore: 'number?', trustVerdict: 'string' }, 'channel.models'));
  stats(value.stats);
}
function site(value) {
  shape(value, { id: 'number', slug: 'string', name: 'string', logoUrl: 'string?', homepageUrl: 'string', type: 'string', description: 'string?', tags: 'array', isVerified: 'boolean', isFeatured: 'boolean', createdAt: 'iso' }, 'site');
  shape(value.stats, { channelCount: 'number', modelCount: 'number', avgUptime24h: 'number?', bestRecommendScore: 'number?', minActualRatio: 'number?', vendorSlugs: 'array', reviewCount: 'number', avgRating: 'number?' }, 'site.stats');
}
function review(value) {
  shape(value, { id: 'number', rating: 'number', content: 'string', createdAt: 'iso', updatedAt: 'iso' }, 'review');
  shape(value.user, { nickname: 'string', avatarUrl: 'string?' }, 'review.user');
  assert(Number.isInteger(value.rating) && value.rating >= 1 && value.rating <= 5, '评价评分超出 1–5');
}
/** @param {MyReview} value */
function myReview(value) {
  review(value); shape(value.site, { id: 'number', slug: 'string', name: 'string' }, 'myReview.site');
  assert(['visible', 'hidden'].includes(value.status), '我的评价缺少审核状态');
  assert(!('userId' in value) && !('siteId' in value), '我的评价不应暴露内部关联字段');
}
function session(value) { shape(value, { id: 'string', email: 'string', nickname: 'string', avatarUrl: 'string?', role: 'string', createdAt: 'iso' }, 'session'); }
function report(value) {
  shape(value, { id: 'number?', channelId: 'number?', model: 'string', protocol: 'string', score: 'number?', verdict: 'string', checks: 'array', durationMs: 'number', trigger: 'string', createdAt: 'iso' }, 'report');
  value.checks.forEach(check => shape(check, { id: 'string', name: 'string', passed: 'boolean?', weight: 'number', detail: 'string' }, 'report.checks'));
}
function noSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert(!['apikey', 'api_key', 'apikeyenc', 'api_key_enc', 'password', 'passwordhash', 'password_hash'].includes(key.toLowerCase()), '响应出现敏感字段');
    noSecrets(nested);
  }
}
async function request(path, { method = 'GET', body, cookie = '', origin = apiOrigin, status = 200, timeout = 20000 } = {}) {
  const response = await fetch(`${origin}/api/v1${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  let data; try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
  assert((Array.isArray(status) ? status : [status]).includes(response.status), `${method} ${path.split('?')[0]}：HTTP ${response.status}，预期 ${status}`);
  if (response.status >= 400) shape(data?.error, { code: 'string', message: 'string' }, 'error');
  if (data !== undefined) noSecrets(data);
  return { data, response };
}
async function check(label, execute) {
  const start = Date.now();
  try { const detail = await execute(); results.push({ label, status: 'PASS', ms: Date.now() - start, detail: typeof detail === 'string' ? detail : '' }); console.log(`PASS ${label}`); return true; }
  catch (error) { const detail = error instanceof Error ? error.message : '检查失败'; results.push({ label, status: 'FAIL', ms: Date.now() - start, detail }); console.log(`FAIL ${label}：${detail}`); return false; }
}
function skip(label, detail) { results.push({ label, status: 'SKIP', ms: 0, detail }); }
function cookieFrom(response) {
  const header = response.headers.get('set-cookie') ?? '';
  assert(/hub_session=/.test(header) && /httponly/i.test(header) && /samesite=lax/i.test(header), '登录缺少 hub_session / HttpOnly / SameSite=Lax');
  const cookie = header.split(';')[0];
  assert(!cookie.includes('=mock-'), '目标仍为 mock 模式，请检查 HUB_API_URL / HUB_WEB_URL');
  return cookie;
}
async function finish(blocked = false) {
  await mkdir(directory, { recursive: true });
  const summary = { apiOrigin, webOrigin: webOrigin ?? null, writes, retainedAccount, generatedAt: new Date().toISOString(), blocked, passed: results.filter(item => item.status === 'PASS').length, failed: results.filter(item => item.status === 'FAIL').length, skipped: results.filter(item => item.status === 'SKIP').length, checks: results };
  await writeFile(`${directory}api-integration-results.json`, `${JSON.stringify(summary, null, 2)}\n`);
  const file = `${directory}api-integration-findings.md`;
  const marker = '<!-- runtime-results -->';
  let previous = ''; try { previous = (await readFile(file, 'utf8')).split(marker)[0]; } catch { previous = '# 真实 API 联调记录\n\n'; }
  const failures = results.filter(item => item.status === 'FAIL');
  const rows = results.map(item => `| ${item.status} | ${item.label.replaceAll('|', '/')} | ${item.detail.replaceAll('|', '/').replaceAll('\n', ' ')} |`).join('\n');
  await writeFile(file, `${previous.trimEnd()}\n\n${marker}\n\n## 最近运行\n\n- 时间：${summary.generatedAt}\n- API：${apiOrigin}\n- Web：${webOrigin ?? '未配置，未运行 Next 代理/SSR 检查'}\n- 结果：${summary.passed} 通过 / ${summary.failed} 失败 / ${summary.skipped} 跳过${blocked ? '；API 尚未可达' : ''}\n- 写入测试：${writes ? '已启用；测试收藏和评价会清理，测试注册账号保留' : '未启用'}\n\n| 状态 | 检查 | 说明 |\n| --- | --- | --- |\n${rows}\n\n${failures.length ? '失败项需要修复后复跑对应检查。' : blocked ? '等待 API 服务启动后重新执行。' : '本次已执行项目全部通过，SKIP 项仍需按运行条件补齐。'}\n`);
  process.exitCode = blocked ? 2 : summary.failed ? 1 : 0;
}

const healthy = await check('真实 API /healthz', async () => {
  const response = await fetch(`${apiOrigin}/healthz`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
});
if (!healthy) { await finish(true); } else {
  let models = []; let sites = []; let channels = []; let controlCookie = '';
  await check('公开 /meta /vendors /models 与共享契约', async () => {
    const { data: meta } = await request('/meta'); shape(meta, { vendors: 'array', featuredModels: 'array', lastProbeAt: 'iso?' }); shape(meta.counts, { sites: 'number', channels: 'number', models: 'number', probes24h: 'number' }); meta.vendors.forEach(vendor); meta.featuredModels.forEach(model);
    const { data: vendors } = await request('/vendors'); assert(Array.isArray(vendors)); vendors.forEach(value => { vendor(value); shape(value, { id: 'number', modelCount: 'number', channelCount: 'number' }); });
    const { data: modelRows } = await request('/models'); assert(Array.isArray(modelRows)); modelRows.forEach(model); models = modelRows;
    if (vendors[0]) { const { data } = await request(`/vendors/${encodeURIComponent(vendors[0].slug)}`); vendor(data); shape(data, { website: 'string?', description: 'string?', models: 'array' }); data.models.forEach(model); }
    if (models[0]) { const { data } = await request(`/models/${encodeURIComponent(models[0].slug)}`); model(data); shape(data, { aliases: 'array', defaultProtocol: 'string', knowledgeCutoff: 'string?', releasedAt: 'string?', description: 'string?', expectedTps: 'number?' }); }
  });
  await check('公开站点列表分页与契约', async () => {
    const { data } = await request('/sites?pageSize=100'); page(data, site); sites = data.items;
  });
  await check('渠道契约、倍率公式与连续排名', async () => {
    const { data } = await request('/channels?pageSize=100'); page(data, channel); channels = data.items;
    channels.forEach((item, index) => assert.equal(item.rank, index + 1));
    if (data.total > 2) { const second = (await request('/channels?page=2&pageSize=2')).data; assert.equal(second.items[0].rank, 3); }
  });
  // 目录失败时仍独立验证站点详情与个人写入，目录错误会保留为 FAIL。
  const availableSites = sites.length ? sites : [...new Map(channels.map(item => [item.site.id, item.site])).values()];
  if (availableSites[0]) await check('公开站点详情与评价分页', async () => {
    const slug = encodeURIComponent(availableSites[0].slug);
    const { data: detail } = await request(`/sites/${slug}`); site(detail); shape(detail, { contact: 'object', paymentMethods: 'array', rechargeRatio: 'number', approvedAt: 'iso?', channels: 'array', ratingSummary: 'object' }); detail.channels.forEach(channel); shape(detail.ratingSummary, { avg: 'number?', count: 'number', distribution: 'object' }); shape(detail.ratingSummary.distribution, { '1': 'number', '2': 'number', '3': 'number', '4': 'number', '5': 'number' });
    page((await request(`/sites/${slug}/reviews?pageSize=2`)).data, review);
    return sites.length ? '' : '使用渠道关联站点；站点列表错误单独保留';
  }); else skip('公开站点详情与评价分页', '无公开站点或渠道，需 seed/审核站点后补齐');
  await check('stableOnly=true 稳定性筛选', async () => { const { data } = await request('/channels?stableOnly=true&pageSize=100'); page(data, channel); assert(data.items.every(item => item.stats.uptime24h >= 0.95 && item.stats.samples24h >= 12)); });
  await check('stableOnly=false 不应开启稳定筛选', async () => { const all = (await request('/channels?pageSize=1')).data; const off = (await request('/channels?stableOnly=false&pageSize=1')).data; assert.equal(off.total, all.total, '字符串 false 被当成 true'); });
  await check('featured=false 不应只返回精选模型', async () => { const { data } = await request('/models?featured=false'); assert.equal(data.length, models.length, '字符串 false 被当成 true'); });
  if (models[0]) await check('模型厂商/关键词筛选', async () => { const selected = models[0]; const { data } = await request(`/models?${new URLSearchParams({ vendor: selected.vendor.slug, q: selected.slug })}`); assert(data.length > 0); assert(data.every(item => item.vendor.slug === selected.vendor.slug && `${item.slug} ${item.displayName}`.toLowerCase().includes(selected.slug.toLowerCase()))); });
  if (channels[0]) {
    const id = channels[0].id;
    await check('渠道详情与检测报告契约', async () => { const { data } = await request(`/channels/${id}`); channel(data); shape(data, { primaryModel: 'string', backupModel: 'string?', createdAt: 'iso' }); data.models.forEach(item => shape(item, { id: 'number', lastLatencyMs: 'number?', lastTestedAt: 'iso?', lastError: 'string?', inputPriceCny: 'number?', outputPriceCny: 'number?' })); if (data.latestReport !== null) report(data.latestReport); const { data: reports } = await request(`/channels/${id}/reports`); assert(Array.isArray(reports)); reports.forEach(report); });
    await check('渠道站点/厂商/关键词/协议/倍率/阈值组合筛选', async () => {
      const selected = channels[0]; const query = new URLSearchParams({ siteId: String(selected.site.id), q: selected.site.name, protocol: selected.protocol, maxRatio: String(selected.actualRatio + 0.0001), pageSize: '100' });
      if (selected.vendor) query.set('vendor', selected.vendor.slug); if (selected.stats.uptime24h !== null) query.set('minUptime', String(Math.max(0, selected.stats.uptime24h - 0.001))); if (selected.stats.trustScore !== null) query.set('minTrust', String(selected.stats.trustScore));
      const { data } = await request(`/channels?${query}`); page(data, channel); assert(data.total > 0); assert(data.items.every(item => item.site.id === selected.site.id && item.protocol === selected.protocol && item.actualRatio <= selected.actualRatio + 0.0002));
      if (selected.vendor) assert(data.items.every(item => item.vendor?.slug === selected.vendor.slug || item.models.some(model => model.vendorSlug === selected.vendor.slug)));
      if (query.has('minUptime')) assert(data.items.every(item => item.stats.uptime24h !== null && item.stats.uptime24h >= Number(query.get('minUptime')))); if (query.has('minTrust')) assert(data.items.every(item => item.stats.trustScore !== null && item.stats.trustScore >= Number(query.get('minTrust'))));
    });
    for (const [window, bucketSec] of [['1h', 60], ['24h', 1800], ['7d', 10800], ['30d', 43200]]) await check(`渠道 history ${window}`, async () => { const { data } = await request(`/channels/${id}/history?window=${window}`); shape(data, { window: 'string', bucketSec: 'number', points: 'array', recentRuns: 'array' }); assert.equal(data.window, window); assert.equal(data.bucketSec, bucketSec); data.points.forEach(point => shape(point, { t: 'iso', total: 'number', ok: 'number', latencyP50: 'number?', ttftAvg: 'number?' })); data.recentRuns.forEach(run => shape(run, { id: 'number', channelId: 'number', model: 'string', protocol: 'string', kind: 'string', trigger: 'string', success: 'boolean', httpStatus: 'number?', errorCode: 'string?', errorMessage: 'string?', latencyMs: 'number?', ttftMs: 'number?', outputTokens: 'number?', tokensPerSec: 'number?', createdAt: 'iso' })); });
    await check('按 ids 批量对比', async () => { const ids = channels.slice(0, 2).map(item => item.id); const { data } = await request(`/channels?ids=${ids.join(',')}&pageSize=4`); page(data, channel); assert(data.items.every(item => ids.includes(item.id))); assert.equal(data.total, ids.length); });
    await check('/go/:channelId 返回 302 与站点地址', async () => { const { response } = await request(`/go/${id}`, { status: 302 }); assert(/^https?:\/\//.test(response.headers.get('location') ?? '')); });
  } else skip('渠道详情/history/对比/go', '无公开渠道，需 seed/审核站点后补齐');
  const pricedModel = models.find(item => item.officialInputPrice !== null && item.channelCount > 0);
  if (pricedModel) await check('指定模型报价、价格升序与 null 最后', async () => {
    const { data } = await request(`/channels?model=${encodeURIComponent(pricedModel.slug)}&sort=price&order=asc&pageSize=100`); page(data, channel);
    let previous = -Infinity; let nullSeen = false;
    for (const item of data.items) { assert.equal(item.price?.modelSlug, pricedModel.slug); const price = item.price.inputCny; if (price === null) nullSeen = true; else { assert(!nullSeen); assert(price >= previous); previous = price; if (!item.price.isOverride) assert(Math.abs(price - pricedModel.officialInputPrice * item.actualRatio) <= pricedModel.officialInputPrice * 0.0001 + 0.002, '模型输入价未遵循官方价×实际倍率'); } }
  }); else skip('指定模型价格', '无带价格且有渠道的模型');
  await check('首页 Top3 与启用公告', async () => { const { data } = await request('/rankings/overview'); shape(data, { updatedAt: 'iso?', models: 'array' }); for (const row of data.models) { model(row.model); assert(Array.isArray(row.top) && row.top.length <= 3); row.top.forEach(channel); } const { data: announcements } = await request('/announcements'); assert(Array.isArray(announcements)); announcements.forEach(item => { shape(item, { id: 'number', title: 'string', contentMd: 'string', enabled: 'boolean', pinned: 'boolean', createdAt: 'iso' }); assert(item.enabled); }); });
  await check('公开校验失败与标准错误结构', async () => { await request('/channels?page=0', { status: 400 }); await request('/channels/2147483647', { status: 404 }); await request('/verify', { method: 'POST', body: {}, status: 400 }); await request('/feedback', { method: 'POST', body: {}, status: 400 }); });
  await check('游客认证/收藏/个人评价/通知均 401', async () => { for (const path of ['/auth/me', '/me/favorites', '/me/reviews', '/me/notifications']) await request(path, { status: 401 }); await request('/me/reviews/2147483647', { method: 'DELETE', status: 401 }); });
  await check('真实登录 Cookie、会话、用户接口与 admin 403', async () => {
    const { data, response } = await request('/auth/login', { method: 'POST', body: { email: process.env.HUB_INTEGRATION_EMAIL ?? 'user@2api.hub', password: process.env.HUB_INTEGRATION_PASSWORD ?? 'user123456' } }); session(data); controlCookie = cookieFrom(response);
    session((await request('/auth/me', { cookie: controlCookie })).data); assert(Array.isArray((await request('/me/favorites', { cookie: controlCookie })).data)); page((await request('/me/reviews?page=1&pageSize=2', { cookie: controlCookie })).data, myReview); assert(Array.isArray((await request('/me/notifications', { cookie: controlCookie })).data)); if (data.role !== 'admin') await request('/admin/overview', { cookie: controlCookie, status: 403 });
  });
  if (writes && availableSites.length && channels.length) await check('注册→收藏→我的评价分页/更新/越权/删除→清理', async () => {
    const password = randomUUID(); const { data: user, response } = await request('/auth/register', { method: 'POST', body: { email: `web-integration-${Date.now()}@example.test`, password, nickname: '接口联调账号' }, status: [200, 201] }); session(user); const cookie = cookieFrom(response); retainedAccount = true; const created = [];
    try {
      await request(`/me/favorites/${channels[0].id}`, { method: 'POST', cookie, status: [200, 201] }); assert((await request('/me/favorites', { cookie })).data.some(item => item.id === channels[0].id && item.isFavorite)); assert((await request(`/channels?ids=${channels[0].id}`, { cookie })).data.items[0].isFavorite);
      for (const item of availableSites.slice(0, 2)) { const { data } = await request(`/sites/${encodeURIComponent(item.slug)}/reviews`, { method: 'POST', cookie, body: { rating: 4, content: '真实 API 联调评价，脚本结束时自动清理。' }, status: [200, 201] }); if (typeof data?.id === 'number') created.push(data); review(data); }
      const first = page((await request('/me/reviews?page=1&pageSize=1', { cookie })).data, myReview); assert.equal(first.total, created.length); assert.equal(first.items.length, 1);
      if (created.length > 1) { const second = page((await request('/me/reviews?page=2&pageSize=1', { cookie })).data, myReview); assert.notEqual(second.items[0].id, first.items[0].id); }
      const update = await request(`/sites/${encodeURIComponent(availableSites[0].slug)}/reviews`, { method: 'POST', cookie, body: { rating: 5, content: '同一用户同一站点评价应更新，随后删除。' } }); assert.equal(update.data.id, created[0].id); assert.equal((await request('/me/reviews', { cookie })).data.total, created.length);
      if (controlCookie) await request(`/me/reviews/${created[0].id}`, { method: 'DELETE', cookie: controlCookie, status: [403, 404] });
      await request(`/me/reviews/${created[0].id}`, { method: 'DELETE', cookie }); await request(`/me/reviews/${created[0].id}`, { method: 'DELETE', cookie, status: 404 }); assert.equal((await request('/me/reviews', { cookie })).data.total, created.length - 1);
      await request('/me/notifications/read', { method: 'POST', cookie, body: {} });
    } finally {
      const cleanup = await Promise.allSettled([
        ...created.map(item => request(`/me/reviews/${item.id}`, { method: 'DELETE', cookie, status: [200, 404] })),
        request(`/me/favorites/${channels[0].id}`, { method: 'DELETE', cookie }),
      ]);
      assert(cleanup.every(item => item.status === 'fulfilled'), '测试数据清理失败，请检查 API 连通性后清理测试账号的评价/收藏');
      assert.equal((await request('/me/reviews', { cookie })).data.total, 0, '测试评价未完全清理');
      assert.equal((await request('/me/favorites', { cookie })).data.length, 0, '测试收藏未完全清理');
      const logout = await request('/auth/logout', { method: 'POST', cookie }); assert(/max-age=0|expires=Thu, 01 Jan 1970/i.test(logout.response.headers.get('set-cookie') ?? ''), '退出未清除会话 Cookie');
    }
    return '测试收藏与评价已清理；无删除用户接口，保留一个无业务数据测试账号';
  }); else skip('用户写入与 MyReview CRUD', writes ? '缺少公开站点或渠道' : '设置 HUB_INTEGRATION_WRITES=1 执行');
  if (webOrigin && controlCookie) await check('Next 同源 API 代理与真实 Cookie', async () => {
    session((await request('/auth/me', { origin: webOrigin, cookie: controlCookie })).data); page((await request('/me/reviews?pageSize=2', { origin: webOrigin, cookie: controlCookie })).data, myReview);
  }); else skip('Next 真实 API 代理', '设置 HUB_WEB_URL 并将 Web 切换为真实 API 模式后执行');
  if (process.env.HUB_VERIFY_BASE_URL && process.env.HUB_VERIFY_API_KEY && process.env.HUB_VERIFY_MODEL) await check('实际快速鉴定报告契约与 Key 不回传', async () => {
    const { data } = await request('/verify', { method: 'POST', timeout: 70000, body: { baseUrl: process.env.HUB_VERIFY_BASE_URL, apiKey: process.env.HUB_VERIFY_API_KEY, model: process.env.HUB_VERIFY_MODEL, protocol: process.env.HUB_VERIFY_PROTOCOL ?? 'openai_chat' } }); report(data); assert.equal(data.id, null); assert.equal(data.channelId, null); assert(!JSON.stringify(data).includes(process.env.HUB_VERIFY_API_KEY), '报告回传了输入 Key');
  }); else skip('实际快速鉴定', '未提供 HUB_VERIFY_BASE_URL / HUB_VERIFY_API_KEY / HUB_VERIFY_MODEL，仅检查了输入校验');
  await finish();
}
