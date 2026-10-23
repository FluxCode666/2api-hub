/* 更新器事故回归：测试包自建，CI 不依赖开发机 /tmp 资产。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { extractSafe, verifyIntegrity } from '../src/lib/updater';

const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'hub-update-regression-'));
  dirs.push(dir);
  return dir;
}
async function fixture() {
  const dir = await temp();
  for (const sub of ['api', 'worker', 'migrate']) {
    await mkdir(join(dir, sub));
    await writeFile(join(dir, sub, 'index.mjs'), `// ${sub}`);
  }
  await writeFile(join(dir, 'release.json'), '{"version":"v0.1.2"}');
  await writeFile(join(dir, 'files.symlinks'), '');
  return dir;
}
async function manifest(dir: string) {
  const paths = ['release.json', 'api/index.mjs', 'worker/index.mjs', 'migrate/index.mjs', 'files.symlinks'];
  await writeFile(join(dir, 'files.sha256'), (await Promise.all(paths.map(async (p) =>
    `${createHash('sha256').update(await readFile(join(dir, p))).digest('hex')}  ${p}`))).join('\n') + '\n');
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe('解压安全校验', () => {
  it('保留 Next.js [...path] 路由、a..b 和隐藏文件，归档文件逐个一致', async () => {
    const root = await temp();
    const src = join(root, 'src'), dest = join(root, 'dest');
    const files = {'web/apps/web/.next/server/app/api/v1/[...path]/route.js': '// route', 'a..b.txt': 'dots', '.hidden': 'hidden'};
    for (const [name, content] of Object.entries(files)) {
      await mkdir(join(src, name, '..'), { recursive: true });
      await writeFile(join(src, name), content);
    }
    await symlink('a..b.txt', join(src, 'link'));
    const pack = join(root, 'pack.tar.gz');
    await tar.create({ file: pack, cwd: src, gzip: true }, ['.']);
    await extractSafe(pack, dest);
    for (const [name, content] of Object.entries(files)) expect(await readFile(join(dest, name), 'utf8')).toBe(content);
    expect(await readFile(join(dest, 'link'), 'utf8')).toBe('dots');
  });

  it.each([
    { path: '../evil', type: 'File' as const },
    { path: '/abs/path', type: 'File' as const },
    { path: 'C:\\win', type: 'File' as const },
    { path: 'a/../../evil', type: 'File' as const },
    { path: 'link', type: 'SymbolicLink' as const, linkpath: '../dest-sibling/evil' },
    { path: 'link', type: 'SymbolicLink' as const, linkpath: '/tmp/evil' },
    { path: 'hard', type: 'Link' as const, linkpath: '../evil' },
  ])('非法条目导致整个解压失败：$path $linkpath', async (entry) => {
    const root = await temp();
    const pack = join(root, 'evil.tar'), dest = join(root, 'dest');
    const header = new tar.Header({ ...entry, size: 0, mode: 0o644 });
    header.encode();
    await writeFile(pack, Buffer.concat([header.block!, Buffer.alloc(1024)]));
    await expect(extractSafe(pack, dest)).rejects.toThrow(/非法路径|路径穿越/);
    await expect(readFile(join(root, 'evil'))).rejects.toThrow();
  });
});

describe('完整性清单', () => {
  it('完整包通过，文件被删/篡改均失败', async () => {
    const dir = await fixture();
    await manifest(dir);
    await expect(verifyIntegrity(dir)).resolves.toBeUndefined();
    await writeFile(join(dir, 'api/index.mjs'), 'tampered');
    await expect(verifyIntegrity(dir)).rejects.toThrow('哈希不一致');
    await rm(join(dir, 'worker/index.mjs'));
    await expect(verifyIntegrity(dir)).rejects.toThrow('缺少关键文件');
  });
  it('清单不接受空内容、非法格式、越界路径或缺少链接清单', async () => {
    const dir = await fixture();
    for (const content of ['', 'invalid\n', `${'0'.repeat(64)}  ../evil\n`]) {
      await writeFile(join(dir, 'files.sha256'), content);
      await expect(verifyIntegrity(dir)).rejects.toThrow('完整性校验失败');
    }
    await manifest(dir);
    await rm(join(dir, 'files.symlinks'));
    await expect(verifyIntegrity(dir)).rejects.toThrow();
  });
  it('符号链接目标必须与清单一致', async () => {
    const dir = await fixture();
    await symlink('api/index.mjs', join(dir, 'link'));
    await writeFile(join(dir, 'files.symlinks'), 'link -> worker/index.mjs\n');
    await manifest(dir);
    await expect(verifyIntegrity(dir)).rejects.toThrow('符号链接目标不一致');
  });
  it('旧版本可无清单，新版本不可；旧版本仍检查关键文件', async () => {
    const dir = await fixture();
    await expect(verifyIntegrity(dir)).rejects.toThrow('缺少 files.sha256');
    await writeFile(join(dir, 'release.json'), '{"version":"v0.1.1"}');
    await expect(verifyIntegrity(dir)).resolves.toBeUndefined();
    await rm(join(dir, 'worker/index.mjs'));
    await expect(verifyIntegrity(dir)).rejects.toThrow('缺少关键文件');
  });
});

describe('重启后任务状态收敛', () => {
  it.each([
    ['restarting', 'v0.1.2', 'succeeded'],
    ['restarting', 'v0.1.1', 'rolled_back'],
    ['downloading', 'v0.1.1', 'failed'],
    ['rolled_back', 'v0.1.1', 'rolled_back'],
  ])('%s + 当前 %s → %s', async (status, version, expected) => {
    const dir = await temp();
    vi.stubEnv('HUB_DATA_DIR', dir);
    await writeFile(join(dir, 'update-task.json'), JSON.stringify({ id: 'test', kind: 'update', targetVersion: 'v0.1.2', status }));
    const { completeTaskOnBoot, systemVersionInfo } = await import('../src/lib/updater');
    await completeTaskOnBoot(version);
    expect(JSON.parse(await readFile(join(dir, 'update-task.json'), 'utf8')).status).toBe(expected);
    // 外部 supervisor 更新后必须再次读磁盘，不能返回 API 启动时的缓存。
    await writeFile(join(dir, 'update-task.json'), JSON.stringify({ id: 'test', status: 'rolled_back' }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));
    try { expect((await systemVersionInfo(true)).task?.status).toBe('rolled_back'); }
    finally { vi.unstubAllGlobals(); }
  });
});
