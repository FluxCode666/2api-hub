import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync, symlinkSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
function makeRelease(
  dir: string,
  version: string,
  { healthy = true, crash = false, migrateOk = true, webProxyOk = true }: { healthy?: boolean; crash?: boolean; migrateOk?: boolean; webProxyOk?: boolean } = {},
): void {
  mkdirSync(join(dir, version), { recursive: true });
  writeFileSync(join(dir, version, 'release.json'), JSON.stringify({ version, commit: 'test', buildDate: '2026-01-01T00:00:00Z' }));
  for (const sub of ['api', 'worker', 'migrate', 'web']) {
    mkdirSync(join(dir, version, sub), { recursive: true });
  }
  // migrate
  writeFileSync(join(dir, version, 'migrate/index.mjs'), `process.exit(${migrateOk ? 0 : 1});\n`);
  // api（模拟 /healthz，带 version 字段——supervisor 会校验）
  const apiScript = crash
    ? 'process.exit(1);\n'
    : `import http from 'node:http';
       const port = Number(process.env.API_PORT);
       if (!Number.isFinite(port) || port <= 0) process.exit(2);
       const version = process.env.HUB_VERSION ?? 'unknown';
       http.createServer((req, res) => {
         if (req.url === '/healthz') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ ok: true, version })); }
         else { res.statusCode = 404; res.end(); }
       }).listen(port, '127.0.0.1');\n`;
  writeFileSync(join(dir, version, 'api/index.mjs'), apiScript);
  writeFileSync(join(dir, version, 'worker/index.mjs'), 'setInterval(() => {}, 60000);\n');
  // web（模拟代理链路 /api/v1/healthz：webProxyOk=false 时 500——复现 v0.1.1 事故）
  const webScript = webProxyOk
    ? `import http from 'node:http';
       const port = Number(process.env.PORT);
       const apiPort = Number(process.env.API_INTERNAL_URL?.split(':').pop() ?? 8711);
       http.createServer(async (req, res) => {
         if (req.url === '/api/v1/healthz') {
           try {
             const r = await fetch(\`http://127.0.0.1:\${apiPort}/healthz\`);
             const body = await r.text();
             res.statusCode = r.status;
             res.setHeader('content-type','application/json');
             res.end(body);
           } catch { res.statusCode = 502; res.end(); }
         } else { res.statusCode = 404; res.end(); }
       }).listen(port, '127.0.0.1');\n`
    : `import http from 'node:http';
       // 事故复现：web 的 API 代理坏了（对应 [...path]/route.js 缺失 → 全部 500）
       http.createServer((req, res) => { res.statusCode = 500; res.end('proxy broken'); }).listen(Number(process.env.PORT), '127.0.0.1');\n`;
  writeFileSync(join(dir, version, 'web/server.js'), webScript);
  mkdirSync(join(dir, version, 'drizzle'), { recursive: true });
  // 新版本必须有清单，测试包与真实发布包使用相同契约。
  const root = join(dir, version);
  symlinkSync('api/index.mjs', join(root, 'api-link'));
  writeFileSync(join(root, 'files.symlinks'), 'api-link -> api/index.mjs\n');
  const hashes: string[] = [];
  function walk(path: string, rel = '') {
    for (const name of readdirSync(path)) {
      const p = join(path, name), r = rel ? `${rel}/${name}` : name, st = lstatSync(p);
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) hashes.push(`${createHash('sha256').update(readFileSync(p)).digest('hex')}  ${r}`);
    }
  }
  walk(root);
  writeFileSync(join(root, 'files.sha256'), hashes.join('\n') + '\n');
}

const TEST_API_PORT = 28711;
const TEST_WEB_PORT = 23210;

function startSupervisor(env: Record<string, string> = {}) {
  return spawn('node', [SUPERVISOR], {
    env: {
      ...process.env,
      HUB_DATA_DIR: dataDir,
      HUB_BUNDLE_DIR: bundleDir,
      HUB_API_PORT: String(TEST_API_PORT),
      HUB_WEB_PORT: String(TEST_WEB_PORT),
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

/** 健康判定与 supervisor 一致：API 直连 + web 代理链路都要通且 version 匹配 */
async function waitHealthy(expectedVersion: string | null = null, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const apiOk = await fetchOk(`http://127.0.0.1:${TEST_API_PORT}/healthz`, expectedVersion);
    const webOk = await fetchOk(`http://127.0.0.1:${TEST_WEB_PORT}/api/v1/healthz`, expectedVersion);
    if (apiOk && webOk) return true;
    await wait(300);
  }
  return false;
}

async function fetchOk(url: string, expectedVersion: string | null): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    if (expectedVersion !== null) {
      const body = (await res.json()) as { version?: string };
      if (body.version !== expectedVersion) return false;
    }
    return true;
  } catch {
    return false;
  }
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
    expect(mod.compareVersions('v0.2.0-rc.10', 'v0.2.0-rc.2')).toBeGreaterThan(0);
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
    const healthy = await waitHealthy('v0.1.0');
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
    await waitHealthy('v0.1.0', 20_000);
    // 切 current（与站内更新相同的原子 symlink 方式）
    const { switchCurrent } = await import('../supervisor.mjs');
    switchCurrent(dataDir, 'v0.2.0');
    sup?.kill('SIGHUP');
    // 等新版本起来（旧 api 进程退出 → 新 api 监听）
    await wait(2500);
    const healthy = await waitHealthy('v0.2.0', 20_000);
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
    await waitHealthy('v0.2.0', 20_000);
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
    // 回退后 v0.2.0 恢复健康（API + web 代理两路）
    const healthy = await waitHealthy('v0.2.0', 20_000);
    expect(healthy).toBe(true);
  }, 150_000);
});


describe('事故修复回归：web 代理故障必须触发回退（v0.1.1 线上事故）', () => {
  it('API 正常但 web 的 /api/v1/healthz 返回 500 → 60s 健康窗口失败 → 自动回退', async () => {
    // 版本名用合法 semver 预发布格式（supervisor 的 isValidVersion 校验）。
    // 独立 dataDir/bundleDir：避免前面用例留下的 current（v0.2.0 > v0.1.2-e2e.1 会抢版本选择）
    const e2eData = mkdtempSync(join(tmpdir(), 'hub-e2e-data-'));
    const e2eBundle = mkdtempSync(join(tmpdir(), 'hub-e2e-bundle-'));
    const GOOD = 'v0.1.2-e2e.1';
    const BAD = 'v0.1.2-e2e.2';
    // 好版本：完全健康（API + web 代理正常）
    makeRelease(e2eBundle, GOOD);
    // 坏版本：API 正常，但 web 代理恒 500（复现 [...path]/route.js 缺失）
    makeRelease(join(e2eData, 'releases'), BAD, { webProxyOk: false });
    sup = spawn('node', [SUPERVISOR], {
      env: {
        ...process.env,
        HUB_DATA_DIR: e2eData,
        HUB_BUNDLE_DIR: e2eBundle,
        HUB_API_PORT: String(TEST_API_PORT),
        HUB_WEB_PORT: String(TEST_WEB_PORT),
        HUB_IMAGE_VERSION: GOOD,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    sup.stdout?.on('data', (d) => console.log('[e2e-sup]', String(d).trim()));
    sup.stderr?.on('data', (d) => console.log('[e2e-sup-err]', String(d).trim()));
    const healthy1 = await waitHealthy(GOOD, 20_000);
    expect(healthy1).toBe(true);
    // 切到坏版本
    const { switchCurrent } = await import('../supervisor.mjs');
    switchCurrent(e2eData, BAD);
    sup?.kill('SIGHUP');
    // 等 60s 健康窗口耗尽 → 自动回退
    const deadline = Date.now() + 120_000;
    let task: { status?: string; to?: string } | null = null;
    while (Date.now() < deadline) {
      try {
        task = JSON.parse(readFileSync(join(e2eData, 'update-task.json'), 'utf8'));
        if (task.status === 'rolled_back') break;
      } catch { /* 尚未写出 */ }
      await wait(1000);
    }
    expect(task).not.toBeNull();
    expect(task.status).toBe('rolled_back');
    expect(task.to).toBe(GOOD);
    // 回退后完整链路恢复（API 直连 + web 代理）
    const healthyBack = await waitHealthy(GOOD, 20_000);
    expect(healthyBack).toBe(true);
    // 清理独立目录
    if (sup && sup.exitCode === null && sup.pid) {
      try { process.kill(-sup.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    }
    await wait(500);
    rmSync(e2eData, { recursive: true, force: true });
    rmSync(e2eBundle, { recursive: true, force: true });
  }, 180_000);
});

describe('发布包完整性清单（files.sha256 / files.symlinks）', () => {
  it('verifyFileManifest：文件被删/篡改 → 返回错误；完好 → null', async () => {
    const { verifyFileManifest, verifyRelease } = await import('../supervisor.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'hub-manifest-'));
    try {
      // 完好清单
      const okFile = join(dir, 'api', 'index.mjs');
      mkdirSync(join(dir, 'api'), { recursive: true });
      writeFileSync(okFile, 'console.log("x");\n');
      const h = createHash('sha256').update(readFileSync(okFile)).digest('hex');
      writeFileSync(join(dir, 'files.sha256'), `${h}  api/index.mjs\n`);
      writeFileSync(join(dir, 'files.symlinks'), '');
      expect(verifyFileManifest(dir)).toBeNull();
      // 篡改内容 → 哈希不一致
      writeFileSync(okFile, 'console.log("tampered");\n');
      expect(verifyFileManifest(dir)).toMatch(/哈希不一致/);
      // 删除文件 → 缺失
      rmSync(okFile);
      expect(verifyFileManifest(dir)).toMatch(/文件缺失/);
      // 符号链接清单（先恢复文件内容，使哈希重新一致）
      writeFileSync(okFile, 'console.log("x");\n');
      symlinkSync('api/index.mjs', join(dir, 'link-to-api'));
      writeFileSync(join(dir, 'files.sha256'), `${h}  api/index.mjs\n`);
      writeFileSync(join(dir, 'files.symlinks'), `link-to-api -> api/index.mjs\n`);
      expect(verifyFileManifest(dir)).toBeNull();
      writeFileSync(join(dir, 'files.sha256'), `${h}  ../escape\n`);
      expect(verifyFileManifest(dir)).toMatch(/非法清单路径/);
      writeFileSync(join(dir, 'files.sha256'), '');
      expect(verifyFileManifest(dir)).toMatch(/为空/);
      // 无清单（旧版发布包）→ 跳过
      rmSync(join(dir, 'files.sha256'));
      rmSync(join(dir, 'files.symlinks'));
      expect(verifyFileManifest(dir)).toBeNull();
      // 清单哈希不一致 → 拒绝（内容再改一次；verifyRelease 的 release.json 前置检查在别处覆盖）
      writeFileSync(okFile, 'tampered again');
      writeFileSync(join(dir, 'files.sha256'), 'deadbeef'.repeat(8) + '  api/index.mjs\n');
      expect(verifyFileManifest(dir)).toMatch(/哈希不一致/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
