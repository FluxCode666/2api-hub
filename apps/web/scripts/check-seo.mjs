import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const web = (process.env.HUB_WEB_URL ?? 'http://127.0.0.1:3210').replace(/\/$/, '');
const api = (process.env.HUB_API_URL ?? 'http://127.0.0.1:8711').replace(/\/$/, '');
const results = [];
const pages = new Map();
const decode = value => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
const attr = (html, name) => decode(html.match(new RegExp(`<meta[^>]+(?:name|property)="${name}"[^>]+content="([^"]*)"`))?.[1] ?? '');

async function check(label, run) {
  try { const detail = await run(); results.push({ label, status: 'PASS', detail: detail ?? '' }); console.log(`PASS ${label}`); }
  catch (error) { results.push({ label, status: 'FAIL', detail: error.message }); console.log(`FAIL ${label}: ${error.message}`); }
}

async function json(path) {
  const response = await fetch(`${api}/api/v1${path}`, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, path);
  return response.json();
}

async function html(path) {
  if (!pages.has(path)) {
    const response = await fetch(`${web}${path}`, { headers: { 'user-agent': 'Googlebot' }, signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, path);
    const text = await response.text();
    assert(!text.includes('NEXT_HTTP_ERROR_FALLBACK') && !text.includes('"name":"ApiRequestError"'), `${path} 返回错误页`);
    pages.set(path, text);
  }
  return pages.get(path);
}

function structured(text) {
  return [...text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(match => JSON.parse(match[1]));
}

const [models, vendors, sites, channels] = await Promise.all([json('/models'), json('/vendors'), json('/sites?pageSize=100'), json('/channels?pageSize=100')]);
const model = models.find(item => item.channelCount > 0) ?? models[0];
const site = sites.items[0];
const channel = channels.items[0];
assert(model && site && channel && vendors[0], '需要公开种子数据');
const modelPath = `/models/${encodeURIComponent(model.slug)}`;
const sitePath = `/sites/${encodeURIComponent(site.slug)}`;
const channelPath = `/channels/${channel.id}`;
const paths = ['/', '/rankings', '/models', '/vendors', '/sites', '/verify', '/join', '/guide', '/compare', '/login', '/register', modelPath, sitePath, channelPath, `/vendors/${encodeURIComponent(vendors[0].slug)}`];
const titles = new Set();
let canonicalOrigin;

for (const path of paths) await check(`独立 metadata ${path}`, async () => {
  const text = await html(path);
  const title = decode(text.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
  assert(title.includes('2API Hub') && title.length > 12, '缺少页面标题');
  assert(!titles.has(title), '页面标题重复'); titles.add(title);
  assert(attr(text, 'description').length >= 20, '描述缺失或过短');
  const canonical = new URL(decode(text.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? ''));
  canonicalOrigin ??= canonical.origin;
  assert.equal(canonical.origin, canonicalOrigin);
  assert.equal(canonical.pathname, path);
  assert.equal(canonical.search, '');
  assert.equal(attr(text, 'og:locale'), 'zh_CN');
  assert.equal(attr(text, 'twitter:card'), 'summary_large_image');
  if (['/compare', '/login', '/register'].includes(path)) assert(attr(text, 'robots').includes('noindex'));
  return title;
});

await check('模型/站点/渠道动态摘要', async () => {
  assert(attr(await html(modelPath), 'description').includes(`${model.channelCount} 个`));
  assert(attr(await html(modelPath), 'description').includes(model.displayName));
  assert(attr(await html(sitePath), 'description').includes(site.name));
  assert(attr(await html(channelPath), 'description').includes(`${channel.actualRatio.toFixed(2)}×`));
});

await check('首页 WebSite 与 SearchAction', async () => {
  const website = structured(await html('/')).find(item => item['@type'] === 'WebSite');
  assert.equal(website?.potentialAction?.['@type'], 'SearchAction');
  assert(website.potentialAction.target.urlTemplate.includes('{search_term_string}'));
});
await check('模型 ItemList 排名', async () => {
  const list = structured(await html(modelPath)).find(item => item['@type'] === 'ItemList');
  assert(list && Array.isArray(list.itemListElement));
  assert(list.itemListElement.length > 0);
  list.itemListElement.forEach((item, index) => { assert.equal(item.position, index + 1); assert(new URL(item.url).pathname.startsWith('/channels/')); });
});
await check('站点 Organization 与评价摘要', async () => {
  const detail = await json(`/sites/${encodeURIComponent(site.slug)}`);
  const organization = structured(await html(sitePath)).find(item => item['@type'] === 'Organization');
  assert.equal(organization?.name, detail.name);
  if (detail.ratingSummary.count > 0 && detail.ratingSummary.avg !== null) {
    assert.equal(organization.aggregateRating.ratingCount, detail.ratingSummary.count);
    assert.equal(organization.aggregateRating.ratingValue, detail.ratingSummary.avg);
  } else assert.equal(organization.aggregateRating, undefined);
});
await check('指南 FAQPage 与可见内容一致', async () => {
  const text = await html('/guide');
  const faq = structured(text).find(item => item['@type'] === 'FAQPage');
  assert(faq && faq.mainEntity.length >= 5);
  faq.mainEntity.forEach(item => { assert(text.includes(item.name)); assert(text.includes(item.acceptedAnswer.text)); });
});
await check('robots 禁止私有路径', async () => {
  const response = await fetch(`${web}/robots.txt`); assert.equal(response.status, 200);
  const text = await response.text();
  for (const path of ['/merchant', '/admin', '/me', '/api']) assert(text.includes(`Disallow: ${path}`));
  assert(text.includes(`${canonicalOrigin}/sitemap.xml`));
});
await check('sitemap 完整收录公开目录', async () => {
  const response = await fetch(`${web}/sitemap.xml`); assert.equal(response.status, 200);
  const text = await response.text();
  const urls = [...text.matchAll(/<loc>(.*?)<\/loc>/g)].map(item => decode(item[1]));
  assert.equal(new Set(urls).size, urls.length);
  const expected = [...models.map(item => `/models/${encodeURIComponent(item.slug)}`), ...vendors.map(item => `/vendors/${encodeURIComponent(item.slug)}`), ...sites.items.map(item => `/sites/${encodeURIComponent(item.slug)}`), ...channels.items.map(item => `/channels/${item.id}`)];
  expected.forEach(path => assert(urls.includes(`${canonicalOrigin}${path}`), `缺少 ${path}`));
  urls.forEach(url => { assert.equal(new URL(url).origin, canonicalOrigin); assert(!/^\/(?:merchant|admin|me|api|login|register|compare)(?:\/|$)/.test(new URL(url).pathname)); });
  return `${urls.length} 个唯一 URL`;
});

for (const path of ['/', modelPath, sitePath]) await check(`OG 图像 ${path}`, async () => {
  const imageUrl = new URL(attr(await html(path), 'og:image'));
  const response = await fetch(`${web}${imageUrl.pathname}${imageUrl.search}`, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200); assert(response.headers.get('content-type')?.includes('image/png'));
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.readUInt32BE(16), 1200); assert.equal(bytes.readUInt32BE(20), 630);
  return `${bytes.length} bytes，1200×630`;
});

const summary = { checkedAt: new Date().toISOString(), web, passed: results.filter(item => item.status === 'PASS').length, failed: results.filter(item => item.status === 'FAIL').length, checks: results };
await writeFile(new URL('../artifacts/seo-checks.json', import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
console.log({ passed: summary.passed, failed: summary.failed });
process.exitCode = summary.failed ? 1 : 0;
