import type { HealthResponse, ReleaseInfo, SessionUser, SystemVersionInfo, UpdateTask, UpdateTaskStatus } from '@hub/shared';
import { MockError } from './error';

// 仅 HUB_MOCK 路由使用；mockScenario 可固定各阶段，便于浏览器验收。
export const systemMockScenarios = ['no-update', 'available', 'no-release', 'checking', 'downloading', 'verifying', 'extracting', 'switching', 'restarting', 'succeeded', 'failed', 'rolled_back', 'development', 'query-error'] as const;
type Scenario = typeof systemMockScenarios[number];
type State = { scenario: Scenario; info: SystemVersionInfo; moving: boolean };
const scope = globalThis as typeof globalThis & { __hubSystemMock?: State };
const stages: UpdateTaskStatus[] = ['checking', 'downloading', 'verifying', 'extracting', 'switching', 'restarting', 'succeeded'];
const latest: ReleaseInfo = {
  version: 'v0.1.1', name: 'v0.1.1 · 更清晰的检测，更可靠的更新', publishedAt: '2026-10-23T08:00:00.000Z',
  url: 'https://github.com/FluxCode666/2api-hub/releases/tag/v0.1.1', assetName: '2api-hub-v0.1.1.tar.gz', assetSize: 84213760,
  notesMd: '## 本次更新\n\n让渠道评测更透明，让维护更从容。\n\n### 新增\n- **按模型展示可信分**，支持查看八项检测依据。\n- 管理后台支持在线更新，健康检查失败时自动回退。\n\n### 改进\n| 功能 | 变化 |\n| --- | --- |\n| 榜单 | 筛选更紧凑，分页可分享 |\n| 主题 | 纸白与暗色均通过对比度校验 |\n\n- [x] 保留配置与数据库\n- [x] 校验发布包完整性\n\n详情见 [发布说明](https://github.com/FluxCode666/2api-hub/releases)。\n\n> 更新前建议备份数据库。\n\n`hub_session` 与站点配置保持不变。',
};

function fixture(scenario: Scenario): SystemVersionInfo {
  const info: SystemVersionInfo = {
    current: { version: 'v0.1.0', commit: 'a1b2c3d4e5f6', buildDate: '2026-10-22T05:30:00.000Z', startedAt: '2026-10-23T01:12:00.000Z' },
    latest: structuredClone(latest), latestError: null, checkedAt: new Date().toISOString(), updateAvailable: true,
    canUpdate: true, reason: null, previousVersion: 'v0.0.9', task: null,
  };
  if (scenario === 'no-update') { info.latest = { ...latest, version: 'v0.1.0' }; info.updateAvailable = false; info.canUpdate = false; info.reason = '当前已是最新版本'; }
  if (scenario === 'no-release' || scenario === 'development') {
    info.latest = null; info.updateAvailable = false; info.canUpdate = false; info.previousVersion = null;
    info.reason = scenario === 'development' ? '当前为开发环境，不支持在线更新' : '暂无正式版本';
    if (scenario === 'development') info.current.version = '0.1.0-dev';
  }
  if (scenario === 'query-error') { info.latest = null; info.latestError = 'GitHub 暂时无法连接，请稍后检查更新。'; info.canUpdate = false; info.updateAvailable = false; }
  if (stages.includes(scenario as UpdateTaskStatus) || ['failed', 'rolled_back'].includes(scenario)) {
    info.task = { id: `preview-${scenario}`, kind: 'update', fromVersion: 'v0.1.0', targetVersion: latest.version,
      status: scenario as UpdateTaskStatus, progress: scenario === 'downloading' ? 0.63 : null,
      message: scenario === 'failed' ? '发布包 SHA-256 校验失败，已保留当前版本。' : scenario === 'rolled_back' ? '新版本未通过健康检查，已恢复旧版本。' : null,
      startedAt: new Date().toISOString(), finishedAt: ['succeeded', 'failed', 'rolled_back'].includes(scenario) ? new Date().toISOString() : null, requestedBy: null };
    info.canUpdate = false;
    if (scenario === 'succeeded') { info.current.version = latest.version; info.previousVersion = 'v0.1.0'; info.updateAvailable = false; }
  }
  return info;
}
function state(): State { return scope.__hubSystemMock ??= { scenario: 'available', info: fixture('available'), moving: false }; }
function advance() {
  const current = state();
  if (!current.moving || !current.info.task) return;
  const task = current.info.task;
  const elapsed = Date.now() - Date.parse(task.startedAt);
  task.status = stages[Math.min(stages.length - 1, Math.floor(elapsed / 3000))]!;
  task.progress = task.status === 'downloading' ? (elapsed % 3000) / 3000 : null;
  if (task.status === 'succeeded') {
    task.finishedAt = new Date().toISOString(); current.info.current.version = task.targetVersion;
    current.info.previousVersion = task.fromVersion; current.info.updateAvailable = task.targetVersion !== latest.version;
    current.info.canUpdate = current.info.updateAvailable; current.moving = false;
  }
}
export function mockSystem(path: string, method: string, body: unknown, user: SessionUser): SystemVersionInfo | UpdateTask {
  const url = new URL(path, 'http://mock.internal');
  if (method === 'GET' && url.pathname === '/admin/system/version') {
    const scenario = url.searchParams.get('mockScenario');
    if (scenario && systemMockScenarios.includes(scenario as Scenario) && state().scenario !== scenario) scope.__hubSystemMock = { scenario: scenario as Scenario, info: fixture(scenario as Scenario), moving: false };
    advance(); state().info.checkedAt = new Date().toISOString(); return structuredClone(state().info);
  }
  if (method === 'POST' && ['/admin/system/update', '/admin/system/rollback'].includes(url.pathname)) {
    advance();
    const info = state().info;
    if (info.task && !['succeeded', 'failed', 'rolled_back'].includes(info.task.status)) throw new MockError(409, 'update_in_progress', '已有更新任务正在执行');
    const rollback = url.pathname.endsWith('/rollback');
    if (info.reason?.includes('开发环境') || !rollback && !info.canUpdate) throw new MockError(400, 'update_unavailable', info.reason ?? '当前无法更新');
    const target = rollback ? info.previousVersion : (body as { targetVersion?: string } | null)?.targetVersion;
    if (!target || !rollback && target !== info.latest?.version) throw new MockError(400, 'invalid_version', '目标版本不可用');
    info.task = { id: crypto.randomUUID(), kind: rollback ? 'rollback' : 'update', fromVersion: info.current.version,
      targetVersion: target, status: 'checking', message: null, progress: null, startedAt: new Date().toISOString(), finishedAt: null, requestedBy: { id: user.id, email: user.email } };
    state().moving = true; return structuredClone(info.task);
  }
  throw new MockError(404, 'not_found', '没有找到该接口');
}
export function mockHealth(): HealthResponse {
  advance();
  if (state().moving && state().info.task?.status === 'restarting') throw new MockError(503, 'restarting', '服务正在重启');
  return { ok: true, version: state().info.current.version };
}
