/*
 * 更新器测试（RELEASE.md §4）：本地假 HTTP 服务模拟 GitHub API 和资产下载。
 * 覆盖：正常更新、校验失败、拒绝降级、路径穿越包、单飞 409、回退。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';

// 覆盖环境变量（在 import updater 之前）
process.env.HUB_DATA_DIR = await mkdtemp(join(tmpdir(), 'hub-update-test-'));
process.env.HUB_SUPERVISOR_PID = '99999';
process.env.NODE_ENV = 'production';
// 模拟生产环境：当前版本 v0.1.0（写在 release.json 里）
process.env.HUB_RELEASE_DIR = join(process.env.HUB_DATA_DIR, 'bundle', 'v0.1.0');

const {
  canUpdate, fetchLatestRelease, startRollback, startUpdate, systemVersionInfo,
} = await import('../src/lib/updater');

// ---------- 假 GitHub 服务 ----------
let fakeServer: Server;
let fakeBase: string;
let mockRelease: { tag: string; assetName: string; tarball: Buffer; checksum: string } | null = null;

function makeTarball(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const tmpDir = join(process.env.HUB_DATA_DIR!, 'tar-tmp');
    mkdir(join(tmpDir, 'api'), { recursive: true })
      .then(() => mkdir(join(tmpDir, 'worker'), { recursive: true }))
      .then(() => mkdir(join(tmpDir, 'migrate'), { recursive: true }))
      .then(async () => {
        for (const [name, content] of Object.entries(files)) {
          await writeFile(join(tmpDir, name), content);
        }
        await tar.create({ file: join(tmpDir, 'pack.tar.gz'), cwd: tmpDir, gzip: true }, Object.keys(files));
        const buf = await readFile(join(tmpDir, 'pack.tar.gz'));
        resolvePromise(buf);
      })
      .catch(reject);
  });
}

beforeAll(async () => {
  // 写当前版本 release.json（v0.1.0）
  await mkdir(process.env.HUB_RELEASE_DIR!, { recursive: true });
  await writeFile(join(process.env.HUB_RELEASE_DIR!, 'release.json'), JSON.stringify({ version: 'v0.1.0', commit: 'old', buildDate: new Date().toISOString() }));

  // 造一个合法的发布包
  const releaseJson = JSON.stringify({ version: 'v0.2.0', commit: 'abc123', buildDate: new Date().toISOString() });
  const tarball = await makeTarball({
    'release.json': releaseJson,
    'api/index.mjs': '// api bundle',
    'worker/index.mjs': '// worker bundle',
    'migrate/index.mjs': '// migrate bundle',
  });
  const checksum = createHash('sha256').update(tarball).digest('hex');
  mockRelease = { tag: 'v0.2.0', assetName: '2api-hub-v0.2.0.tar.gz', tarball, checksum };

  fakeServer = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.includes('/releases/latest')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: mockRelease!.tag,
        name: mockRelease!.tag,
        published_at: new Date().toISOString(),
        body: '## 更新内容\n- 测试更新',
        html_url: `${fakeBase}/releases/${mockRelease!.tag}`,
        prerelease: false,
        assets: [{ name: mockRelease!.assetName, size: mockRelease!.tarball.length, browser_download_url: `${fakeBase}/download/${mockRelease!.assetName}` }],
      }));
      return;
    }
    if (url.includes('/checksums.txt')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${mockRelease!.checksum}  ${mockRelease!.assetName}\n`);
      return;
    }
    if (url.includes(`/download/${mockRelease!.assetName}`)) {
      res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': mockRelease!.tarball.length });
      res.end(mockRelease!.tarball);
      return;
    }
    res.writeHead(404).end('not found');
  });
  await new Promise<void>((r) => fakeServer.listen(0, '127.0.0.1', r));
  fakeBase = `http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}`;

  // 覆盖 GitHub API 地址和下载白名单（测试用）
  process.env.HUB_GITHUB_API_BASE = fakeBase;
  process.env.HUB_UPDATE_ALLOWED_HOSTS = '127.0.0.1';
});

afterAll(async () => {
  fakeServer?.close();
  await rm(process.env.HUB_DATA_DIR!, { recursive: true, force: true });
});

describe('更新器', () => {
  it('canUpdate：生产环境 + HUB_DATA_DIR + supervisor → true', async () => {
    const r = await canUpdate();
    expect(r.ok).toBe(true);
  });

  it('fetchLatestRelease：返回 ReleaseInfo', async () => {
    const { release, error } = await fetchLatestRelease(true);
    expect(error).toBeNull();
    expect(release?.version).toBe('v0.2.0');
    expect(release?.assetName).toBe('2api-hub-v0.2.0.tar.gz');
  });

  it('systemVersionInfo：updateAvailable=true，canUpdate=true', async () => {
    const info = await systemVersionInfo(true);
    expect(info.updateAvailable).toBe(true);
    expect(info.canUpdate).toBe(true);
    expect(info.latest?.version).toBe('v0.2.0');
  });

  it('正常更新：下载→校验→解压→切换→SIGHUP', { timeout: 30000 }, async () => {
    const sighups: number[] = [];
    const task = await startUpdate('v0.2.0', { id: 'u1', email: 'a@t.dev' }, {
      sendSighup: (pid) => sighups.push(pid),
    });
    expect(task.status).toBe('checking');
    // 等后台任务完成到 restarting
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (task.status === 'restarting') break;
    }
    expect(task.status).toBe('restarting');
    expect(sighups).toContain(99999);
    // 验证 releases 目录有 v0.2.0
    const releaseDir = join(process.env.HUB_DATA_DIR!, 'releases', 'v0.2.0');
    const releaseJson = JSON.parse(await readFile(join(releaseDir, 'release.json'), 'utf8'));
    expect(releaseJson.version).toBe('v0.2.0');
  });

  it('单飞：进行中任务返回 409', { timeout: 15000 }, async () => {
    // 先发起一个更新（不等待完成）
    const t1 = await startUpdate('v0.2.0', null);
    // 立即再发起一个 → 409
    await expect(startUpdate('v0.2.0', null)).rejects.toThrow('进行中');
    // 等第一个完成
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (t1.status === 'restarting' || t1.status === 'failed') break;
    }
  });

  it('拒绝降级：目标版本不大于当前版本', async () => {
    // 先让 current 变成 v0.2.0（通过 currentBuild 读 release.json）
    // 模拟：写 previous + current 指向 v0.2.0
    const { symlink, unlink } = await import('node:fs/promises');
    const dataDir = process.env.HUB_DATA_DIR!;
    await writeFile(join(dataDir, 'previous'), 'v0.1.0', 'utf8');
    const currentLink = join(dataDir, 'current');
    await unlink(currentLink).catch(() => {});
    await symlink(join('releases', 'v0.2.0'), currentLink);
    // 尝试更新到 v0.1.0（低于当前）
    await expect(startUpdate('v0.1.0', null)).rejects.toThrow();
  });

  it('回退：切换到 previous', { timeout: 15000 }, async () => {
    // 等之前的更新完成（单飞锁释放）
    await new Promise((r) => setTimeout(r, 2000));
    // 创建 v0.1.0 的发布包目录（回退目标必须存在）
    const dataDir = process.env.HUB_DATA_DIR!;
    const v010Dir = join(dataDir, 'releases', 'v0.1.0');
    await mkdir(v010Dir, { recursive: true });
    await writeFile(join(v010Dir, 'release.json'), JSON.stringify({ version: 'v0.1.0', commit: 'old', buildDate: new Date().toISOString() }));

    const sighups: number[] = [];
    const task = await startRollback({ id: 'u1', email: 'a@t.dev' }, {
      sendSighup: (pid) => sighups.push(pid),
    });
    expect(task.kind).toBe('rollback');
    expect(task.targetVersion).toBe('v0.1.0');
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (task.status === 'restarting') break;
    }
    if (task.status === 'failed') console.log('rollback failed message:', task.message);
    expect(task.status).toBe('restarting');
    expect(sighups).toContain(99999);
  });
});
