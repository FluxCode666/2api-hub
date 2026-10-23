/*
 * 站内热更新器（RELEASE.md §4）。
 * 纯 JS 实现（semver + tar），无原生模块，可被 esbuild 打成单文件。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { gt as semverGt, valid as semverValid } from 'semver';
import * as tar from 'tar';
import type { ReleaseInfo, SystemVersionInfo, UpdateTask, UpdateTaskStatus, BuildInfo } from '@hub/shared';

// ---------- 配置（环境变量，测试可覆盖；运行时读取） ----------
function config() {
  return {
    GITHUB_REPO: process.env.HUB_RELEASE_REPOSITORY ?? 'FluxCode666/2api-hub',
    GITHUB_TOKEN: process.env.HUB_GITHUB_TOKEN,
    DATA_DIR: process.env.HUB_DATA_DIR,
    SUPERVISOR_PID: process.env.HUB_SUPERVISOR_PID ? Number(process.env.HUB_SUPERVISOR_PID) : null,
    GITHUB_API_BASE: process.env.HUB_GITHUB_API_BASE ?? 'https://api.github.com',
    ALLOWED_HOSTS: (process.env.HUB_UPDATE_ALLOWED_HOSTS ?? 'github.com,objects.githubusercontent.com,release-assets.githubusercontent.com').split(','),
  };
}

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200MB
const RELEASE_CACHE_MS = 10 * 60 * 1000; // 10 分钟
const KEEP_VERSIONS = 3;

// ---------- 当前版本 ----------
const startedAt = new Date().toISOString();

export async function currentBuild(): Promise<BuildInfo> {
  const releaseDir = process.env.HUB_RELEASE_DIR;
  if (releaseDir) {
    try {
      const raw = await readFile(join(releaseDir, 'release.json'), 'utf8');
      const r = JSON.parse(raw) as { version?: string; commit?: string; buildDate?: string };
      return { version: r.version ?? 'v0.0.0-dev', commit: r.commit ?? null, buildDate: r.buildDate ?? null, startedAt };
    } catch { /* 落回开发模式 */ }
  }
  // 开发环境：根 package.json 版本 + -dev
  try {
    const pkg = JSON.parse(await readFile(resolve(process.cwd(), '../../package.json'), 'utf8')) as { version?: string };
    return { version: `${pkg.version ?? '0.0.0'}-dev`, commit: null, buildDate: null, startedAt };
  } catch {
    return { version: '0.0.0-dev', commit: null, buildDate: null, startedAt };
  }
}

/** 运行环境是否支持在线更新 */
export async function canUpdate(): Promise<{ ok: boolean; reason: string | null }> {
  const cfg = config();
  if (process.env.NODE_ENV !== 'production') {
    return { ok: false, reason: '当前为开发环境，不支持在线更新' };
  }
  if (!cfg.DATA_DIR) return { ok: false, reason: '未配置 HUB_DATA_DIR，不支持在线更新' };
  if (!cfg.SUPERVISOR_PID) return { ok: false, reason: '未检测到 supervisor 进程，不支持在线更新' };
  try {
    await stat(cfg.DATA_DIR);
    // 试写
    const probe = join(cfg.DATA_DIR, '.write-probe');
    await writeFile(probe, '');
    await unlink(probe);
  } catch {
    return { ok: false, reason: '数据目录不可写，不支持在线更新' };
  }
  return { ok: true, reason: null };
}

// ---------- GitHub Release 查询（缓存 10 分钟） ----------
let releaseCache: { at: number; data: ReleaseInfo | null; error: string | null } | null = null;
let assetDownloadUrl: string | null = null; // 内部缓存，不暴露到契约

interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  body: string;
  html_url: string;
  prerelease: boolean;
  assets: { name: string; size: number; browser_download_url: string }[];
}

export async function fetchLatestRelease(forceRefresh = false): Promise<{ release: ReleaseInfo | null; error: string | null }> {
  const cfg = config();
  if (!forceRefresh && releaseCache && Date.now() - releaseCache.at < RELEASE_CACHE_MS) {
    return { release: releaseCache.data, error: releaseCache.error };
  }
  try {
    const res = await fetch(`${cfg.GITHUB_API_BASE}/repos/${cfg.GITHUB_REPO}/releases/latest`, {
      headers: {
        'accept': 'application/vnd.github+json',
        'user-agent': '2api-hub-updater',
        ...(cfg.GITHUB_TOKEN ? { authorization: `Bearer ${cfg.GITHUB_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) {
      // 仓库尚无正式 Release → latest=null，不算错误
      releaseCache = { at: Date.now(), data: null, error: null };
      return { release: null, error: null };
    }
    if (!res.ok) {
      const err = `GitHub API 返回 ${res.status}`;
      releaseCache = { at: Date.now(), data: null, error: err };
      return { release: null, error: err };
    }
    const data = (await res.json()) as GitHubRelease;
    const asset = data.assets.find((a) => a.name.endsWith('.tar.gz'));
    const info: ReleaseInfo = {
      version: data.tag_name,
      name: data.name || data.tag_name,
      publishedAt: data.published_at,
      notesMd: data.body ?? '',
      url: data.html_url,
      assetName: asset?.name ?? null,
      assetSize: asset?.size ?? null,
    };
    // 内部缓存资产下载地址（不暴露到契约）
    assetDownloadUrl = asset?.browser_download_url ?? null;
    releaseCache = { at: Date.now(), data: info, error: null };
    return { release: info, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '网络错误';
    releaseCache = { at: Date.now(), data: null, error: msg };
    return { release: null, error: msg };
  }
}

// ---------- 任务状态（持久化到 HUB_DATA_DIR/update-task.json） ----------
let currentTask: UpdateTask | null = null;

async function taskFile(): Promise<string | null> {
  const cfg = config();
  return cfg.DATA_DIR ? join(cfg.DATA_DIR, 'update-task.json') : null;
}

async function loadTask(): Promise<UpdateTask | null> {
  // supervisor 也会写此文件，不能缓存启动时读到的状态。
  const f = await taskFile();
  if (!f) return null;
  try {
    currentTask = JSON.parse(await readFile(f, 'utf8')) as UpdateTask;
  } catch {
    currentTask = null;
  }
  return currentTask;
}

async function saveTask(t: UpdateTask | null): Promise<void> {
  currentTask = t;
  const f = await taskFile();
  if (!f) return;
  const tmp = `${f}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(t, null, 2), 'utf8');
  await rename(tmp, f);
}

/** 新版本启动时调用：任务状态收敛
 *  restarting + targetVersion === 当前版本 → succeeded
 *  restarting + 不匹配 → rolled_back（kind=update）或 failed，message 写明当前运行版本 */
export async function completeTaskOnBoot(currentVersion: string): Promise<void> {
  const t = await loadTask();
  if (!t || ['succeeded', 'failed', 'rolled_back'].includes(t.status)) return;
  if (t.status !== 'restarting') {
    await saveTask({ ...t, status: 'failed', message: `服务重启中断了更新，当前运行 ${currentVersion}`, finishedAt: new Date().toISOString() });
    return;
  }
  if (t.targetVersion === currentVersion) {
    await saveTask({ ...t, status: 'succeeded', message: '更新完成', finishedAt: new Date().toISOString() });
  } else {
    // 版本不匹配：新版本未能启动（被回退或失败）
    const msg = `新版本未能启动，当前运行 ${currentVersion}`;
    await saveTask({
      ...t,
      status: t.kind === 'update' ? 'rolled_back' : 'failed',
      message: msg,
      finishedAt: new Date().toISOString(),
    });
  }
}

// ---------- 单飞锁 ----------
let updating = false;

// ---------- 系统版本信息 ----------
export async function systemVersionInfo(forceRefresh = false): Promise<SystemVersionInfo> {
  const cfg = config();
  const current = await currentBuild();
  const { release: latest, error: latestError } = await fetchLatestRelease(forceRefresh);
  const update = await canUpdate();
  const updateAvailable = latest !== null && semverValid(latest.version) !== null && semverValid(current.version) !== null
    ? semverGt(latest.version, current.version)
    : false;
  const previousVersion = cfg.DATA_DIR ? await readPrevious() : null;
  const task = await loadTask();
  return {
    current,
    latest,
    latestError,
    checkedAt: releaseCache ? new Date(releaseCache.at).toISOString() : null,
    updateAvailable,
    canUpdate: update.ok && updateAvailable,
    reason: update.ok ? (updateAvailable ? null : '当前已是最新版本') : update.reason,
    previousVersion,
    task,
  };
}

async function readPrevious(): Promise<string | null> {
  const cfg = config();
  if (!cfg.DATA_DIR) return null;
  try {
    return (await readFile(join(cfg.DATA_DIR, 'previous'), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

// ---------- 下载（白名单 + 重定向逐跳校验 + 200MB 上限） ----------
async function downloadAsset(url: string, dest: string): Promise<number> {
  const cfg = config();
  let currentUrl = url;
  for (let hops = 0; hops < 10; hops++) {
    let u: URL;
    try {
      u = new URL(currentUrl);
    } catch {
      throw new Error(`无效的下载地址：${currentUrl}`);
    }
    if (!cfg.ALLOWED_HOSTS.includes(u.hostname)) {
      throw new Error(`下载地址主机不在白名单：${u.hostname}`);
    }
    const res = await fetch(currentUrl, {
      redirect: 'manual',
      headers: cfg.GITHUB_TOKEN ? { authorization: `Bearer ${cfg.GITHUB_TOKEN}` } : {},
      signal: AbortSignal.timeout(120000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('重定向缺少 Location');
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_DOWNLOAD_BYTES) throw new Error('文件超过 200MB 上限');
    if (!res.body) throw new Error('响应无内容');
    const out = createWriteStream(dest);
    let written = 0;
    // SAFETY: ReadableStream 与 Node stream 的互操作由 Node 22 原生支持
    const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (written > MAX_DOWNLOAD_BYTES) throw new Error('文件超过 200MB 上限');
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      }
    } finally {
      out.end();
      reader.releaseLock();
    }
    await new Promise<void>((resolveP, rejectP) => {
      out.on('finish', () => resolveP());
      out.on('error', rejectP);
    });
    return written;
  }
  throw new Error('重定向次数过多');
}

// ---------- SHA-256 校验 ----------
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) hash.update(chunk as Buffer);
    yield;
  });
  return hash.digest('hex');
}

/** 按路径段校验：拒绝绝对路径、Windows 盘符、恰好等于 .. 的段、解析后越界。
 *  保留合法名称：[...path]（Next.js catch-all）、a..b.txt 等。 */
function isPathSafe(relPath: string, destResolved: string): boolean {
  // 规范化：统一用 /
  const normalized = relPath.replace(/\\/g, '/');
  // 拒绝绝对路径
  if (normalized.startsWith('/')) return false;
  // 拒绝 Windows 盘符
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  // 按段判断：任何一段恰好等于 .. 则拒绝（a..b、[...path] 不受影响）
  for (const seg of normalized.split('/')) {
    if (seg === '..') return false;
  }
  // 解析后必须在目标目录内
  const target = resolve(destResolved, normalized);
  return target === destResolved || target.startsWith(destResolved + '/');
}

// ---------- 安全解压（按路径段校验；非法条目导致整个更新失败） ----------
export async function extractSafe(tarball: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const destResolved = await realpath(destDir);
  const rejected: string[] = [];
  // 先检查原始条目和链接目标，避免 tar 规范化绝对路径或解压时才发现越界。
  await tar.list({ file: tarball, strict: true, onReadEntry: (entry) => {
    const path = entry.path;
    if (!isPathSafe(path, destResolved)) rejected.push(path);
    if (entry.type === 'SymbolicLink') {
      const target = (entry.linkpath ?? '').replace(/\\/g, '/');
      const resolved = resolve(destResolved, dirname(path), target);
      if (target.startsWith('/') || /^[a-zA-Z]:/.test(target)
        || !(resolved === destResolved || resolved.startsWith(destResolved + '/'))) rejected.push(`${path} -> ${target}`);
    } else if (entry.type === 'Link') {
      if (!entry.linkpath || !isPathSafe(entry.linkpath, destResolved)) rejected.push(`${path} -> ${entry.linkpath}`);
    } else if (!['File', 'Directory'].includes(entry.type)) {
      rejected.push(`${path}（不支持的条目类型 ${entry.type}）`);
    }
  } });
  if (rejected.length > 0) {
    await rm(destDir, { recursive: true, force: true });
    throw new Error(`发布包包含非法路径（疑似路径穿越）：${rejected.slice(0, 5).join(', ')}`);
  }
  try {
    await tar.extract({
      file: tarball,
      cwd: destDir,
      strict: true,
      filter: (path: string) => {
        if (!isPathSafe(path, destResolved)) {
          rejected.push(path);
          return false;
        }
        return true;
      },
    } as never);
    // 任何非法条目 → 整个更新失败（不静默丢文件）
    if (rejected.length > 0) {
      await rm(destDir, { recursive: true, force: true });
      throw new Error(`发布包包含非法路径（疑似路径穿越）：${rejected.slice(0, 5).join(', ')}${rejected.length > 5 ? ` 等 ${rejected.length} 项` : ''}`);
    }
    // 二次校验：遍历解压结果，拒绝符号链接越界
    const { readdir, readlink, lstat } = await import('node:fs/promises');
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir)) {
        const full = join(dir, entry);
        const st = await lstat(full);
        if (st.isSymbolicLink()) {
          const target = await readlink(full);
          const resolved = await realpath(full);
          if (resolved !== destResolved && !resolved.startsWith(destResolved + '/')) {
            throw new Error(`符号链接越界：${entry} → ${target}`);
          }
        } else if (st.isDirectory()) {
          await walk(full);
        }
      }
    }
    await walk(destDir);
  } catch (err) {
    await rm(destDir, { recursive: true, force: true });
    throw err;
  }
}

// ---------- 解压后完整性校验（files.sha256 逐文件校验；缺失时校验关键文件） ----------
export async function verifyIntegrity(stagingDir: string, _tarball = ''): Promise<void> {
  const root = await realpath(stagingDir);
  const required = ['release.json', 'api/index.mjs', 'worker/index.mjs', 'migrate/index.mjs'];
  for (const f of required) {
    if (!(await lstat(join(root, f)).catch(() => null))?.isFile()) throw new Error(`发布包缺少关键文件：${f}`);
  }
  const manifestPath = join(root, 'files.sha256');
  if (!(await lstat(manifestPath).catch(() => null))) {
    const meta = JSON.parse(await readFile(join(root, 'release.json'), 'utf8')) as { version?: string };
    if (meta.version && semverValid(meta.version) && !semverGt('v0.1.2', meta.version)) throw new Error('发布包完整性校验失败：缺少 files.sha256');
    return; // v0.1.1 及更早的发布包兼容
  }
  const fail = (message: string): never => { throw new Error(`发布包完整性校验失败：${message}`); };
  const safeFile = async (rel: string) => {
    if (!isPathSafe(rel, root) || rel.includes('\\') || rel === '.' || rel === '') fail(`非法清单路径：${rel}`);
    const full = join(root, rel);
    const actual = await realpath(full).catch(() => '');
    if (!actual.startsWith(root + '/')) fail(`文件缺失或链接越界：${rel}`);
    return full;
  };
  if (!(await lstat(manifestPath)).isFile()) fail('files.sha256 必须为普通文件');
  const lines = (await readFile(manifestPath, 'utf8')).split('\n').filter((l) => l !== '');
  if (lines.length === 0) fail('files.sha256 为空');
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match || match[2] === 'files.sha256') fail('files.sha256 清单行格式非法');
    const [, expected, rel] = match!;
    const full = await safeFile(rel!);
    if (!(await lstat(full)).isFile()) fail(`应为普通文件：${rel}`);
    if (await sha256File(full) !== expected) fail(`哈希不一致：${rel}`);
  }
  const linkManifest = join(root, 'files.symlinks');
  if (!(await lstat(linkManifest).catch(() => null))?.isFile()) fail('缺少 files.symlinks');
  for (const line of (await readFile(linkManifest, 'utf8')).split('\n').filter((l) => l !== '')) {
    const match = /^(.+) -> (.+)$/.exec(line);
    if (!match) fail('files.symlinks 清单行格式非法');
    const [, rel, target] = match!;
    const full = await safeFile(rel!);
    if (!(await lstat(full)).isSymbolicLink() || await readlink(full) !== target) fail(`符号链接目标不一致：${rel}`);
  }
}

// ---------- 原子切换 ----------
async function atomicSwitch(dataDir: string, tag: string): Promise<void> {
  const releasesDir = join(dataDir, 'releases');
  const stagingDir = join(releasesDir, `${tag}.staging`);
  const finalDir = join(releasesDir, tag);
  // staging → final（原子 rename）；回退时 staging 可能不存在（直接从 final 切换）
  if (await stat(stagingDir).catch(() => null)) {
    await rename(stagingDir, finalDir); // rename 失败必须中止，不能复用旧目录
  } else {
    await stat(finalDir); // 回退场景
  }
  // 写 previous
  const currentLink = join(dataDir, 'current');
  let currentVersion: string | null = null;
  try {
    const { readlink } = await import('node:fs/promises');
    currentVersion = basename(await readlink(currentLink));
  } catch {
    /* 首次更新，无 current 链接 */
  }
  if (currentVersion && currentVersion !== tag) {
    await writeFile(join(dataDir, 'previous'), currentVersion, 'utf8');
  }
  // 原子替换 current 符号链接（先删旧链接再 rename，避免已存在时失败）
  const tmpLink = join(dataDir, `current.tmp.${Date.now()}`);
  await symlink(join('releases', tag), tmpLink);
  await rename(tmpLink, currentLink);
}

// ---------- 清理旧版本 ----------
async function cleanupOldVersions(dataDir: string): Promise<void> {
  const releasesDir = join(dataDir, 'releases');
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(releasesDir);
  const versions = entries.filter((e) => !e.endsWith('.staging')).sort((a, b) => semverValid(b) && semverValid(a) ? (semverGt(b, a) ? 1 : -1) : 0);
  // 保留 current + previous + 最新 3 个
  const keep = new Set<string>();
  const current = await import('node:fs/promises').then((fs) => fs.readlink(join(dataDir, 'current')).catch(() => null));
  const previous = await readPrevious();
  if (current) keep.add(basename(current));
  if (previous) keep.add(previous);
  for (const v of versions.slice(0, KEEP_VERSIONS)) keep.add(v);
  for (const v of versions) {
    if (!keep.has(v)) {
      await rm(join(releasesDir, v), { recursive: true, force: true });
    }
  }
}

// ---------- 更新任务（后台执行） ----------
export interface UpdateHooks {
  audit?: (action: string, meta: Record<string, unknown>) => Promise<void>;
  /** 注入 supervisor kill（测试用） */
  sendSighup?: (pid: number) => void;
}

export async function startUpdate(
  targetVersion: string,
  requestedBy: { id: string; email: string } | null,
  hooks: UpdateHooks = {},
): Promise<UpdateTask> {
  const cfg = config();
  if (updating) throw new Error('已有进行中的更新任务');
  if (!cfg.DATA_DIR) throw new Error('未配置 HUB_DATA_DIR');

  // 同步检查：目标版本必须是最新且大于当前（不允许降级）
  const current = await currentBuild();
  if (!semverValid(targetVersion) || !semverValid(current.version)) throw new Error('版本号无效');
  if (!semverGt(targetVersion, current.version)) throw new Error('目标版本必须大于当前版本（不允许降级）');

  updating = true;

  const task: UpdateTask = {
    id: `upd-${Date.now()}`,
    kind: 'update',
    fromVersion: current.version,
    targetVersion,
    status: 'checking',
    message: '正在检查更新',
    progress: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    requestedBy,
  };
  await saveTask(task);

  // 后台执行（不阻塞请求）
  void runUpdate(task, hooks).finally(() => { updating = false; });
  return task;
}

async function setTaskStatus(task: UpdateTask, status: UpdateTaskStatus, message: string, progress?: number | null): Promise<void> {
  Object.assign(task, { status, message, progress: progress ?? task.progress });
  await saveTask(task);
}

async function runUpdate(task: UpdateTask, hooks: UpdateHooks): Promise<void> {
  const cfg = config();
  try {
    // 1. 检查
    const { release } = await fetchLatestRelease(true);
    if (!release) throw new Error('无法获取最新版本信息');
    if (release.version !== task.targetVersion) throw new Error(`目标版本 ${task.targetVersion} 不是最新版本 ${release.version}`);
    const current = await currentBuild();
    if (!semverValid(task.targetVersion) || !semverValid(current.version)) throw new Error('版本号无效');
    if (!semverGt(task.targetVersion, current.version)) throw new Error('目标版本必须大于当前版本（不允许降级）');
    if (!release.assetName) throw new Error('发布包资产缺失');

    // 2. 下载
    await setTaskStatus(task, 'downloading', '正在下载发布包', 0);
    const tmpDir = join(cfg.DATA_DIR!, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const tarball = join(tmpDir, release.assetName);
    // 下载：用缓存的资产下载地址（fake server 或真实 GitHub），跟随重定向到白名单主机
    const downloadUrl = assetDownloadUrl ?? `https://github.com/${cfg.GITHUB_REPO}/releases/download/${release.version}/${release.assetName}`;
    await downloadAsset(downloadUrl, tarball);

    // 3. 校验 SHA-256
    await setTaskStatus(task, 'verifying', '正在校验完整性');
    // checksums.txt 也从同一来源下载（fake server 或真实 GitHub）
    // 从资产下载地址推导：去掉文件名，加 checksums.txt
    const checksumsUrl = assetDownloadUrl
      ? assetDownloadUrl.substring(0, assetDownloadUrl.lastIndexOf('/')) + '/checksums.txt'
      : `https://github.com/${cfg.GITHUB_REPO}/releases/download/${release.version}/checksums.txt`;
    const checksumsPath = join(tmpDir, 'checksums.txt');
    await downloadAsset(checksumsUrl, checksumsPath);
    const checksums = await readFile(checksumsPath, 'utf8');
    const expected = checksums.split('\n').find((l) => l.includes(release.assetName!))?.split(/\s+/)[0];
    if (!expected) throw new Error('checksums.txt 中未找到发布包');
    const actual = await sha256File(tarball);
    if (actual !== expected) throw new Error('SHA-256 校验失败，文件可能损坏或被篡改');

    // 4. 解压
    await setTaskStatus(task, 'extracting', '正在解压');
    const stagingDir = join(cfg.DATA_DIR!, 'releases', `${task.targetVersion}.staging`);
    await rm(stagingDir, { recursive: true, force: true });
    await extractSafe(tarball, stagingDir);
    // 校验 release.json
    const releaseJson = JSON.parse(await readFile(join(stagingDir, 'release.json'), 'utf8')) as { version?: string };
    if (releaseJson.version !== task.targetVersion) throw new Error('发布包版本与目标版本不符');
    // 完整性校验：files.sha256 逐文件校验（缺失时校验关键文件）
    await verifyIntegrity(stagingDir, tarball);

    // 5. 切换
    await setTaskStatus(task, 'switching', '正在切换版本');
    // 重复更新到同一版本：releases/<tag> 已存在且非 current → 先删除旧目录再解压（不复用残缺目录）
    const finalDir = join(cfg.DATA_DIR!, 'releases', task.targetVersion);
    const currentLink = join(cfg.DATA_DIR!, 'current');
    let currentTarget: string | null = null;
    try {
      const { readlink } = await import('node:fs/promises');
      currentTarget = basename(await readlink(currentLink));
    } catch { /* 无 current */ }
    if (currentTarget === task.targetVersion) throw new Error('目标版本已成为当前版本，请刷新后重试');
    // 上次失败残留的同 tag 包必须由本次验证通过的 staging 替换。
    await rm(finalDir, { recursive: true, force: true });
    await atomicSwitch(cfg.DATA_DIR!, task.targetVersion);
    await cleanupOldVersions(cfg.DATA_DIR!);

    // 6. 重启
    await setTaskStatus(task, 'restarting', '正在重启服务');
    await hooks.audit?.('system.update', { from: task.fromVersion, to: task.targetVersion });
    const pid = cfg.SUPERVISOR_PID;
    if (pid) {
      if (hooks.sendSighup) hooks.sendSighup(pid);
      else process.kill(pid, 'SIGHUP');
    }
    // 任务保持 restarting，新版本启动时 completeTaskOnBoot 置为 succeeded
  } catch (err) {
    const msg = err instanceof Error ? err.message : '未知错误';
    await setTaskStatus(task, 'failed', msg);
    await hooks.audit?.('system.update_failed', { error: msg, target: task.targetVersion });
  }
}

// ---------- 回退 ----------
export async function startRollback(
  requestedBy: { id: string; email: string } | null,
  hooks: UpdateHooks = {},
): Promise<UpdateTask> {
  const cfg = config();
  if (updating) throw new Error('已有进行中的更新任务');
  if (!cfg.DATA_DIR) throw new Error('未配置 HUB_DATA_DIR');
  const previous = await readPrevious();
  if (!previous) throw new Error('没有可回退的版本');
  const current = await currentBuild();
  updating = true;

  const task: UpdateTask = {
    id: `rb-${Date.now()}`,
    kind: 'rollback',
    fromVersion: current.version,
    targetVersion: previous,
    status: 'switching',
    message: '正在回退',
    progress: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    requestedBy,
  };
  await saveTask(task);

  void (async () => {
    try {
      await atomicSwitch(cfg.DATA_DIR!, previous);
      await setTaskStatus(task, 'restarting', '正在重启服务');
      await hooks.audit?.('system.rollback', { from: task.fromVersion, to: previous });
      const pid = cfg.SUPERVISOR_PID;
      if (pid) {
        if (hooks.sendSighup) hooks.sendSighup(pid);
        else process.kill(pid, 'SIGHUP');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知错误';
      await setTaskStatus(task, 'failed', msg);
    } finally {
      updating = false;
    }
  })();
  return task;
}
