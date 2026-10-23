import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * supervisor 单元测试：用假发布包（假 api/worker/web/migrate 子进程脚本）模拟
 * 崩溃退避、SIGHUP 热切换、健康失败自动回退、损坏包回退。
 * 真实 supervisor 以子进程方式运行（避免测试进程自身接管信号）。
 */

const SUPERVISOR = new URL('../supervisor.mjs', import.meta.url).pathname;
let dataDir: string;
let bundleDir: string;
let sup: import('node:child_process').ChildProcess | undefined;

/** 造一个假发布包 */
function makeRelease(dir: string, version: string, { healthy = true, crash = false, migrateOk = true }: { healthy?: boolean; crash?: boolean; migrateOk?: boolean } = {}): void {
  mkdirSync(join(dir, version), { recursive: true });
  writeFileSync(join(dir, version, 'release.json'), JSON.stringify({ version, commit: 'test', buildDate: '2026-01-01T00:00:00Z' }));
  for (const sub of ['api', 'worker', 'migrate', 'web']) {
    mkdirSync(join(dir, version, sub), { recursive: true });
  }
  // migrate
  writeFileSync(join(dir, version, 'migrate/index.mjs'), `process.exit(${migrateOk ? 0 : 1});\n`);
  // api（模拟 /healthz）：healthy 时起一个 2s http 服务；crash 时立即退出
  const apiScript = crash
    ? 'process.exit(1);\n'
    : `import http from 'node:http';
       const port = Number(process.env.API_PORT);
       if (!Number.isFinite(port) || port <= 0) process.exit(2);
       http.createServer((req, res) => {
         if (req.url === '/healthz') { res.end('{"ok":true}'); }
         else { res.statusCode = 404; res.end(); }
       }).listen(port, '127.0.0.1');\n`;
  writeFileSync(join(dir, version, 'api/index.mjs'), apiScript);
  writeFileSync(join(dir, version, 'worker/index.mjs'), 'setInterval(() => {}, 60000);\n');
  writeFileSync(join(dir, version, 'web/server.js'), 'setInterval(() => {}, 60000);\n');
  mkdirSync(join(dir, version, 'drizzle'), { recursive: true });
}

const TEST_API_PORT = 28711;

function startSupervisor(env: Record<string, string> = {}) {
  return spawn('node', [SUPERVISOR], {
    env: {
      ...process.env,
      HUB_DATA_DIR: dataDir,
      HUB_BUNDLE_DIR: bundleDir,
      HUB_API_PORT: String(TEST_API_PORT),
      HUB_IMAGE_VERSION: env.HUB_IMAGE_VERSION ?? 'v0.0.0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // 独立进程组：killAll 可整组清理而不误伤 vitest worker
    detached: true,
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealthy(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_API_PORT}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch { /* 未就绪 */ }
    await wait(300);
  }
  return false;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'hub-sup-test-'));
  bundleDir = mkdtempSync(join(tmpdir(), 'hub-sup-bundle-'));
});

/** 杀掉 supervisor 及其残留子进程（假子进程 cwd 都在 dataDir/bundleDir 下，用 pkill 按路径匹配） */
async function killAll() {
  // 杀 supervisor 的整个进程组（其子进程未 detach → 同 pgid），
  // 不用 pkill 模式匹配（会误伤 vitest worker）
  if (sup && sup.exitCode === null && sup.pid) {
    try {
      process.kill(-sup.pid, 'SIGKILL');
    } catch {
      try { sup.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
  }
  await wait(500);
  // 端口兜底：只杀监听 TEST_API_PORT 的进程（supervisor 死后孤儿 api 可能残留）
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('bash', ['-c', `lsof -ti :${TEST_API_PORT} 2>/dev/null | xargs kill -9 2>/dev/null || true`], { stdio: 'ignore' });
  } catch {
    // 无占用
  }
  await wait(300);
}

afterEach(async () => {
  await killAll();
});

afterAll(async () => {
  await killAll();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(bundleDir, { recursive: true, force: true });
});

describe('semver', () => {
  // compareVersions/maxVersion 是 supervisor.mjs 的导出，动态导入
  it('比较与 max', async () => {
    const mod = await import('../supervisor.mjs');
    expect(mod.compareVersions('v0.10.0', 'v0.9.3')).toBeGreaterThan(0);
    expect(mod.compareVersions('v0.1.0', 'v0.1.0')).toBe(0);
    expect(mod.compareVersions('v0.2.0-rc.1', 'v0.2.0')).toBeLessThan(0);
    expect(mod.maxVersion('v0.9.3', 'v0.10.0')).toBe('v0.10.0');
    expect(mod.maxVersion('v1.0.0', 'v0.10.0')).toBe('v1.0.0');
    expect(mod.isValidVersion('v1.2.3')).toBe(true);
    expect(mod.isValidVersion('abc')).toBe(false);
  });
});

describe('supervisor 集成（真实子进程）', () => {
  it('首次启动：镜像版本 → 复制到 data → migrate → 3 子进程 → healthz', async () => {
    makeRelease(bundleDir, 'v0.1.0');
    sup = startSupervisor({ HUB_IMAGE_VERSION: 'v0.1.0' });
    const healthy = await waitHealthy();
    expect(healthy).toBe(true);
    // data 里有发布包 + current 指向 v0.1.0
    expect(existsSync(join(dataDir, 'releases/v0.1.0/api/index.mjs'))).toBe(true);
    expect(realpathSync(join(dataDir, 'current')).split('/').pop()).toBe('v0.1.0');
    // supervisor.json
    const sj = JSON.parse(readFileSync(join(dataDir, 'supervisor.json'), 'utf8'));
    expect(sj.version).toBe('v0.1.0');
  }, 60_000);

  it('SIGHUP 热切换：放入更高版本 → 切 current → SIGHUP → 新版本运行', async () => {
    makeRelease(join(dataDir, 'releases'), 'v0.2.0');
    // 用例独立的 supervisor（上一个用例的已被 afterEach 清理）
    sup = startSupervisor({ HUB_IMAGE_VERSION: 'v0.1.0' });
    await waitHealthy(20_000);
    // 切 current（与站内更新相同的原子 symlink 方式）
    const { switchCurrent } = await import('../supervisor.mjs');
    switchCurrent(dataDir, 'v0.2.0');
    sup?.kill('SIGHUP');
    // 等新版本起来（旧 api 进程退出 → 新 api 监听）
    await wait(2500);
    const healthy = await waitHealthy(20_000);
    expect(healthy).toBe(true);
    const sj = JSON.parse(readFileSync(join(dataDir, 'supervisor.json'), 'utf8'));
    expect(sj.version).toBe('v0.2.0');
    // previous 记录了 v0.1.0
    expect(readFileSync(join(dataDir, 'previous'), 'utf8').trim()).toBe('v0.1.0');
  }, 90_000);

  it('损坏包回退：切换到坏版本 → 60s 健康窗口失败 → 自动回退 + update-task.json', async () => {
    // v0.3.0：api 永远 crash（迁移成功但健康不就绪）
    makeRelease(join(dataDir, 'releases'), 'v0.3.0', { crash: true });
    sup = startSupervisor({ HUB_IMAGE_VERSION: 'v0.2.0' });
    await waitHealthy(20_000);
    const { switchCurrent } = await import('../supervisor.mjs');
    switchCurrent(dataDir, 'v0.3.0');
    sup?.kill('SIGHUP');
    // 新版本健康窗口 60s + 退避重启 5 次崩溃判定（更快路径：崩溃 5 次触发回退）
    // 等待回退完成：update-task.json 出现 rolled_back
    const deadline = Date.now() + 90_000;
    let task = null;
    while (Date.now() < deadline) {
      try {
        task = JSON.parse(readFileSync(join(dataDir, 'update-task.json'), 'utf8'));
        if (task.status === 'rolled_back') break;
      } catch { /* 尚未写出 */ }
      await wait(1000);
    }
    expect(task).not.toBeNull();
    expect(task.status).toBe('rolled_back');
    expect(task.to).toBe('v0.2.0');
    // 回退后 v0.2.0 恢复健康
    const healthy = await waitHealthy(20_000);
    expect(healthy).toBe(true);
  }, 150_000);
});
