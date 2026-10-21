import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 通过真实 HTTP 检查页面，不替代浏览器交互和接口业务验收。
const run = promisify(execFile);
const origin = (process.env.HUB_WEB_URL ?? 'http://127.0.0.1:3210').replace(/\/$/, '');
const mode = process.env.HUB_ROUTE_MODE ?? 'real';
assert(['real', 'mock'].includes(mode), 'HUB_ROUTE_MODE 只能是 real 或 mock');
const results = [];
const skipped = [];
const directory = fileURLToPath(new URL('../artifacts/', import.meta.url));

async function json(path, cookie = '') {
  const response = await fetch(`${origin}/api/v1${path}`, {
    headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, `${path} HTTP ${response.status}`);
  return response.json();
}

async function checkedJson(path, cookie, fallback) {
  try { return await json(path, cookie); } catch (error) { results.push({ group: 'api-setup', path, passed: false, error: error.message }); return fallback; }
}

async function login(email, password) {
  const response = await fetch(`${origin}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, `登录 HTTP ${response.status}`);
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert(cookie.includes('hub_session='), '登录未设置会话 Cookie');
  if (mode === 'real') assert(!cookie.includes('=mock-'), 'Web 仍在 Mock 模式');
  return cookie;
}

async function route(path, group, cookie = '', expected = 200) {
  try {
    const { stdout } = await run('curl', [
      '-sS', '--max-time', '30', '-w', '\n%{http_code}',
      ...(cookie ? ['-H', `Cookie: ${cookie}`] : []), `${origin}${path}`,
    ], { maxBuffer: 8 * 1024 * 1024 });
    const split = stdout.lastIndexOf('\n');
    const status = Number(stdout.slice(split + 1));
    const body = stdout.slice(0, split);
    const guard = group === 'guest-guard';
    const redirected = status === 307 || /NEXT_REDIRECT|http-equiv="refresh"/.test(body);
    const runtimeError = /数据暂时无法加载|Internal Server Error/.test(body) || (!guard && body.includes('id="__next_error__"'));
    const passed = guard ? [200, 307].includes(status) && redirected && !runtimeError : status === expected && !runtimeError;
    results.push({ group, path, status, expected, runtimeError, passed });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${path} HTTP ${status}${runtimeError ? ' 页面错误' : ''}`);
  } catch (error) {
    results.push({ group, path, passed: false, error: error.message.split('\n')[0].replace(/Cookie:.*/, 'Cookie: [redacted]') });
    console.log(`FAIL ${path} 请求失败`);
  }
}

try {
  /** @type {import('@hub/shared').ModelSummary[]} */
  const models = await checkedJson('/models', '', []);
  /** @type {import('@hub/shared').VendorSummary[]} */
  const vendors = await checkedJson('/vendors', '', []);
  /** @type {import('@hub/shared').Paginated<import('@hub/shared').SiteListItem>} */
  const sites = await checkedJson('/sites', '', {items:[]});
  /** @type {import('@hub/shared').Paginated<import('@hub/shared').ChannelListItem>} */
  const channels = await checkedJson('/channels', '', {items:[]});
  const publicPaths = ['/', '/rankings', '/models', '/vendors', '/sites', '/verify', '/join', '/guide', '/login', '/register', '/compare'];
  if (models[0]) publicPaths.push(`/models/${encodeURIComponent(models[0].slug)}`); else skipped.push('模型详情：未找到模型');
  if (vendors[0]) publicPaths.push(`/vendors/${encodeURIComponent(vendors[0].slug)}`); else skipped.push('厂商详情：未找到厂商');
  const publicSiteSlug = sites.items[0]?.slug ?? channels.items[0]?.site.slug;
  if (publicSiteSlug) publicPaths.push(`/sites/${encodeURIComponent(publicSiteSlug)}`); else skipped.push('站点详情：未找到公开站点');
  if (channels.items[0]) publicPaths.push(`/channels/${channels.items[0].id}`); else skipped.push('渠道详情：未找到公开渠道');
  if (channels.items.length >= 2) publicPaths.push(`/compare?ids=${channels.items.slice(0, 2).map(channel => channel.id).join(',')}`); else skipped.push('多渠道对比：少于两个公开渠道');
  for (const path of publicPaths) await route(path, 'public');
  for (const path of ['/me', '/merchant', '/admin']) await route(path, 'guest-guard', '', 307);

  const merchant = await login(process.env.HUB_ROUTE_MERCHANT_EMAIL ?? 'merchant@2api.hub', process.env.HUB_ROUTE_MERCHANT_PASSWORD ?? 'merchant123456');
  /** @type {import('@hub/shared').MerchantSite[]} */
  const ownSites = await checkedJson('/merchant/sites', merchant, []);
  const merchantPaths = ['/me', '/merchant', '/merchant/sites', '/merchant/onboarding'];
  if (ownSites[0]) {
    /** @type {import('@hub/shared').MerchantSiteDetail} */
    const site = await checkedJson(`/merchant/sites/${ownSites[0].id}`, merchant, {id:ownSites[0].id,channels:[]});
    merchantPaths.push(`/merchant/sites/${site.id}`, `/merchant/sites/${site.id}/edit`, `/merchant/onboarding?siteId=${site.id}`);
    if (site.channels[0]) merchantPaths.push(`/merchant/channels/${site.channels[0].id}`); else skipped.push('站长渠道详情：没有自有渠道');
  } else skipped.push('站长站点/编辑/向导恢复/渠道详情：没有自有站点');
  for (const path of merchantPaths) await route(path, 'merchant', merchant);

  const admin = await login(process.env.HUB_ROUTE_ADMIN_EMAIL ?? 'admin@2api.hub', process.env.HUB_ROUTE_ADMIN_PASSWORD ?? 'admin123456');
  const adminPaths = ['/admin', ...['reviews', 'sites', 'channels', 'probe-runs', 'tasks', 'models', 'vendors', 'users', 'feedback', 'ratings', 'announcements', 'settings', 'audit-logs'].map(section => `/admin/${section}`)];
  const allSites = await checkedJson('/admin/sites', admin, {items:[]});
  if (allSites.items[0]) adminPaths.push(`/admin/sites/${allSites.items[0].id}`); else skipped.push('管理站点详情：没有站点');
  for (const path of adminPaths) await route(path, 'admin', admin);
} catch (error) {
  results.push({ group: 'setup', passed: false, error: error.message });
  console.log(`FAIL 准备数据：${error.message}`);
}

const report = { mode, origin, checkedAt: new Date().toISOString(), results, skipped, passed: results.length > 0 && results.every(result => result.passed) && skipped.length === 0 };
await mkdir(directory, { recursive: true });
await writeFile(`${directory}${mode}-route-checks.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log({ checked: results.length, failed: results.filter(result => !result.passed).length, skipped });
process.exitCode = report.passed ? 0 : 1;
