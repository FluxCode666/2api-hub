import assert from 'node:assert/strict';

const base = process.env.WEB_TEST_URL ?? 'http://127.0.0.1:3210';
const mock = process.env.HUB_TEST_MOCK === '1';
let cookie = '';
let checks = 0;
const verify = (condition, message) => { assert.ok(condition, message); checks++; };
async function request(path, options = {}, authenticated = true) {
  const response = await fetch(`${base}/api/v1${path}`, { ...options, headers: { ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, signal: AbortSignal.timeout(10000) });
  return { response, data: await response.json() };
}
const denied = await request('/admin/system/version', {}, false);
verify(denied.response.status === 401, '版本详情必须要求登录');
const login = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@2api.hub', password: 'admin123456' }) }, false);
assert.equal(login.response.status, 200);
cookie = login.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const health = await request('/healthz', {}, false);
verify(health.response.ok && health.data.ok === true && typeof health.data.version === 'string', '公开健康检查应含版本');
const version = await request('/admin/system/version?refresh=true');
verify(version.response.ok && typeof version.data.current.version === 'string', '当前版本契约');
verify(typeof version.data.current.startedAt === 'string' && typeof version.data.canUpdate === 'boolean', '构建信息和环境能力契约');
if (!mock) {
  verify(version.data.canUpdate === false && version.data.reason === '当前为开发环境，不支持在线更新', '本地开发环境禁止在线更新');
  verify(version.data.latest === null && version.data.latestError === null, '无正式 Release 应为正常空结果');
} else {
  for (const scenario of ['no-update', 'available', 'no-release', 'checking', 'downloading', 'verifying', 'extracting', 'switching', 'restarting', 'succeeded', 'failed', 'rolled_back', 'development', 'query-error']) {
    const { response, data } = await request(`/admin/system/version?mockScenario=${scenario}`);
    verify(response.ok && typeof data.updateAvailable === 'boolean', `mock ${scenario} 可读`);
    if (['checking', 'downloading', 'verifying', 'extracting', 'switching', 'restarting', 'succeeded', 'failed', 'rolled_back'].includes(scenario)) verify(data.task.status === scenario, `mock ${scenario} 任务状态`);
    if (scenario === 'downloading') verify(data.task.progress === 0.63, '下载进度在 0–1 范围');
    if (scenario === 'available') verify(data.latest.notesMd.includes('| 功能 |') && data.canUpdate, '可更新场景含 GFM 说明');
    if (scenario === 'development') verify(!data.canUpdate && data.reason.includes('开发环境'), 'mock 开发环境禁用');
    if (scenario === 'query-error') verify(!!data.latestError, '查询错误有独立原因');
  }
  await request('/admin/system/version?mockScenario=available');
  const started = await request('/admin/system/update', { method: 'POST', body: JSON.stringify({ targetVersion: 'v0.1.1' }) });
  verify(started.response.status === 202 && started.data.status === 'checking', '更新任务异步接受');
  const duplicate = await request('/admin/system/rollback', { method: 'POST' });
  verify(duplicate.response.status === 409, '进行中拒绝重复提交');
  await request('/admin/system/version?mockScenario=development');
  const disabled = await request('/admin/system/update', { method: 'POST', body: JSON.stringify({ targetVersion: 'v0.1.1' }) });
  verify(disabled.response.status === 400, '开发环境拒绝启动更新');
  const previous = await request('/admin/system/version?mockScenario=no-update');
  const rollback = await request('/admin/system/rollback', { method: 'POST' });
  verify(rollback.response.status === 202 && rollback.data.kind === 'rollback', '回退任务异步接受');
  verify(rollback.data.targetVersion === previous.data.previousVersion, '回退目标来自 previousVersion');
}
console.log(JSON.stringify({ base, mode: mock ? 'mock' : 'real', passed: checks, failed: 0, version: version.data.current.version }, null, 2));
