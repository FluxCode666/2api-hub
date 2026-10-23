#!/usr/bin/env node
/*
 * supervisor（RELEASE.md §2.2）：PID 1 为 tini → 本脚本。
 * 职责：
 * - 版本选择：current 不存在 → 镜像版本；存在 → max(current, 镜像版本)（semver）
 * - 运行迁移（失败 → 回退逻辑）
 * - 启动 3 个子进程（api / worker / web），注入环境变量
 * - 子进程异常退出 → 指数退避重启（1s→30s）；版本切换后 5 分钟内连续崩溃 5 次 → 自动回退
 * - 每 10s 检查 API /healthz + web 代理，写 supervisor.json
 * - SIGHUP：重新解析 current → 迁移 → 优雅停止（SIGTERM 最多 20s，超时 SIGKILL）→ 新版本启动
 *   新版本 60s 内 /healthz 未就绪 → 回退到 previous 并写 update-task.json（rolled_back）
 * - SIGTERM/SIGINT：转发子进程，最多等 25s
 *
 * 只使用 Node 内置模块。
 */
import { existsSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync, lstatSync, readlinkSync, cpSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// ---------- 配置 ----------
const BUNDLE_DIR = process.env.HUB_BUNDLE_DIR ?? '/app/bundle';
const DATA_DIR = process.env.HUB_DATA_DIR ?? '/app/data';
const RUNTIME_API_PORT = Number(process.env.HUB_API_PORT ?? 8711);
const RUNTIME_WEB_PORT = Number(process.env.HUB_WEB_PORT ?? 3210);
const IMAGE_VERSION = process.env.HUB_IMAGE_VERSION ?? 'v0.0.0';
const HEALTH_INTERVAL_MS = 10_000;
const NEW_VERSION_GRACE_MS = 60_000; // 新版本健康就绪窗口
const CRASH_WINDOW_MS = 5 * 60_000;  // 版本切换后连续崩溃判定窗口
const CRASH_THRESHOLD = 5;
const SHUTDOWN_WAIT_MS = 20_000;
const EXIT_WAIT_MS = 25_000;

const releasesDir = join(DATA_DIR, 'releases');
const currentLink = join(DATA_DIR, 'current');
const previousFile = join(DATA_DIR, 'previous');
const updateTaskFile = join(DATA_DIR, 'update-task.json');
const supervisorFile = join(DATA_DIR, 'supervisor.json');

// ---------- semver（自实现，RELEASE.md §1）----------
/** 解析 vMAJOR.MINOR.PATCH[-pre]；非法返回 null */
function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v ?? '');
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

/** a > b → 正数；相等 → 0；a < b → 负数；无法比较（含 null）→ 0 */
export function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // 预发布 < 正式版；逐标识符按 semver 比较（rc.10 > rc.2）。
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const left = pa.pre.split('.');
  const right = pb.pre.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    if (left[i] === right[i]) continue;
    const an = /^\d+$/.test(left[i]);
    const bn = /^\d+$/.test(right[i]);
    if (an && bn) return Number(left[i]) - Number(right[i]);
    if (an !== bn) return an ? -1 : 1;
    return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export function isValidVersion(v) {
  return parseSemver(v) !== null;
}

/** max(a, b)（任一无法解析时返回另一个） */
export function maxVersion(a, b) {
  if (!isValidVersion(a)) return b;
  if (!isValidVersion(b)) return a;
  return compareVersions(a, b) >= 0 ? a : b;
}

// ---------- 状态 ----------
const children = new Map(); // name → { proc, exitCode, backoffMs }
let runningVersion = null;
let versionSwitchedAt = 0;
let crashCount = 0;
let shuttingDown = false;
let restarting = false;
let lastHealthyAt = null;
let healthTimer = null;
let newVersionDeadline = null; // 新版本健康就绪截止时间戳

function log(msg) {
  console.log(`[supervisor] ${msg}`);
}

// ---------- 文件工具 ----------
function readTextIfExists(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function readJsonIfExists(path) {
  const text = readTextIfExists(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path);
}

function currentVersion() {
  // current 是指向 releases/<tag> 的相对符号链接：用 realpath 取目标目录名
  try {
    const real = realpathSync(currentLink);
    return real.split('/').pop() ?? null;
  } catch {
    return null;
  }
}

/** 原子切换 current 符号链接（新建临时链接后 rename） */
export function switchCurrent(dataDir, targetVersion) {
  const tmp = join(dataDir, `.current.tmp-${process.pid}-${Date.now()}`);
  const link = join(dataDir, 'current');
  const rel = join('releases', targetVersion);
  try {
    unlinkSync(tmp);
  } catch { /* 不存在 */ }
  symlinkSync(rel, tmp);
  renameSync(tmp, link);
}

// ---------- 发布包完整性 ----------
/** 校验发布包关键文件存在且 release.json.version === tag（损坏 → 返回错误信息） */
export function verifyRelease(dir, expectedTag) {
  const required = ['release.json', 'api/index.mjs', 'worker/index.mjs', 'migrate/index.mjs', 'web/server.js', 'drizzle'];
  for (const rel of required) {
    if (!existsSync(join(dir, rel))) {
      return `缺少 ${rel}`;
    }
  }
  const meta = readJsonIfExists(join(dir, 'release.json'));
  if (!meta || typeof meta.version !== 'string') return 'release.json 缺失或无 version';
  if (meta.version !== expectedTag) return `release.json 版本 ${meta.version} 与目录 ${expectedTag} 不符`;
  // 完整性清单校验（事故修复：切换前发现文件缺失/哈希不一致 → 拒绝切换）
  const manifestErr = verifyFileManifest(dir);
  if (manifestErr !== null) return manifestErr;
  return null;
}

/**
 * 发布包完整性清单校验（files.sha256 / files.symlinks）：
 * - files.sha256 每行「<sha256>  <相对路径>」：文件必须存在且哈希一致
 * - files.symlinks 每行「<相对路径> -> <目标>」：符号链接必须存在且目标一致
 * - 清单缺失（v0.1.1 及更早的发布包）→ 跳过校验（返回 null，保持兼容）
 */
export function verifyFileManifest(dir) {
  try {
    const root = realpathSync(dir);
    const meta = readJsonIfExists(join(dir, 'release.json'));
    const manifestPath = join(dir, 'files.sha256');
    if (!existsSync(manifestPath)) {
      return meta && compareVersions(meta.version, 'v0.1.2') >= 0 ? '缺少 files.sha256' : null;
    }
    if (!lstatSync(manifestPath).isFile()) return 'files.sha256 必须为普通文件';
    const safePath = (rel) => {
      if (rel === '' || rel === '.' || rel.startsWith('/') || rel.includes('\\')
        || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..')) throw new Error(`非法清单路径：${rel}`);
      const path = join(root, rel);
      if (!existsSync(path)) throw new Error(`文件缺失：${rel}`);
      const real = realpathSync(path);
      if (!real.startsWith(root + '/')) throw new Error(`链接越界：${rel}`);
      return path;
    };
    const lines = readFileSync(manifestPath, 'utf8').split('\n').filter((l) => l !== '');
    if (lines.length === 0) return 'files.sha256 为空';
    for (const line of lines) {
      const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
      if (!m || m[2] === 'files.sha256') return 'files.sha256 清单行格式非法';
      const [, expectedHash, relPath] = m;
      const p = safePath(relPath);
      if (!lstatSync(p).isFile()) return `应为普通文件：${relPath}`;
      const actual = createHash('sha256').update(readFileSync(p)).digest('hex');
      if (actual !== expectedHash) return `哈希不一致：${relPath}`;
    }
    const linkPath = join(dir, 'files.symlinks');
    if (!existsSync(linkPath) || !lstatSync(linkPath).isFile()) return '缺少 files.symlinks';
    for (const line of readFileSync(linkPath, 'utf8').split('\n')) {
      if (line === '') continue;
      const m = /^(.+) -> (.+)$/.exec(line);
      if (!m) return 'files.symlinks 清单行格式非法';
      const [, relPath, expectedTarget] = m;
      const p = safePath(relPath);
      if (!lstatSync(p).isSymbolicLink()) return `应为符号链接：${relPath}`;
      if (readlinkSync(p) !== expectedTarget) return `符号链接目标不一致：${relPath}`;
    }
    return null;
  } catch (err) {
    return err.message; // 不可读/目录条目等均作为验证失败，交给回退流程处理
  }
}

// ---------- 子进程管理 ----------
function childEnv(releaseDir) {
  const base = { ...process.env };
  // 清理会让业务误判的变量
  delete base.HUB_IMAGE_VERSION;
  return {
    ...base,
    HUB_DATA_DIR: DATA_DIR,
    HUB_RELEASE_DIR: releaseDir,
    HUB_SUPERVISOR_PID: String(process.pid),
    HUB_VERSION: runningVersion,
    NODE_ENV: base.NODE_ENV ?? 'production',
  };
}

function childSpecs(releaseDir) {
  return [
    { name: 'api', cmd: 'node', args: ['api/index.mjs'], cwd: releaseDir, extra: { API_HOST: '127.0.0.1', API_PORT: String(RUNTIME_API_PORT) } },
    { name: 'worker', cmd: 'node', args: ['worker/index.mjs'], cwd: releaseDir, extra: { WORKER_HOST: '127.0.0.1', WORKER_HEALTH_PORT: '8713' } },
    { name: 'web', cmd: 'node', args: ['web/server.js'], cwd: releaseDir, extra: { HOSTNAME: '0.0.0.0', PORT: String(RUNTIME_WEB_PORT), API_INTERNAL_URL: `http://127.0.0.1:${RUNTIME_API_PORT}` } },
  ];
}

function startChild(spec, env) {
  const proc = spawn(spec.cmd, spec.args, {
    cwd: spec.cwd,
    env: { ...env, ...spec.extra },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const entry = { proc, backoffMs: 1000, exited: false };
  children.set(spec.name, entry);
  proc.on('exit', (code, signal) => {
    if (entry.exited) return; // stopChildren 主动停止
    log(`子进程 ${spec.name} 退出（code=${code} signal=${signal}）`);
    onChildCrash(spec, env);
  });
  log(`启动 ${spec.name}（pid ${proc.pid}）`);
  return proc;
}

function onChildCrash(spec, env) {
  if (shuttingDown || restarting) return;
  crashCount += 1;
  const sinceSwitch = Date.now() - versionSwitchedAt;
  if (crashCount >= CRASH_THRESHOLD && sinceSwitch < CRASH_WINDOW_MS) {
    log(`新版本 ${runningVersion} 在切换后 ${Math.round(sinceSwitch / 1000)}s 内第 ${crashCount} 次崩溃 → 自动回退`);
    void rollback('子进程连续崩溃');
    return;
  }
  // 指数退避 1s → 30s
  const prev = children.get(spec.name);
  const backoff = Math.min((prev?.backoffMs ?? 1000) * 2, 30_000);
  children.set(spec.name, { proc: null, backoffMs: backoff, exited: false });
  log(`${spec.name} 将在 ${backoff}ms 后重启（第 ${crashCount} 次异常）`);
  setTimeout(() => {
    if (shuttingDown || restarting) return;
    const releaseDir = join(releasesDir, runningVersion ?? '');
    const s = childSpecs(releaseDir).find((x) => x.name === spec.name);
    if (s) startChild(s, env);
  }, backoff);
}

async function stopChildren(graceMs = SHUTDOWN_WAIT_MS) {
  const procs = [...children.values()].map((c) => c.proc).filter((p) => p && !p.killed && p.exitCode === null);
  for (const c of children.values()) c.exited = true;
  for (const p of procs) {
    try { p.kill('SIGTERM'); } catch { /* ignore */ }
  }
  if (procs.length === 0) return;
  const deadline = Date.now() + graceMs;
  await Promise.all(procs.map((p) => new Promise((r) => {
    const t = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch { /* ignore */ }
      r();
    }, Math.max(1, deadline - Date.now()));
    p.once('exit', () => { clearTimeout(t); r(); });
  })));
}

// ---------- 健康检查 ----------
/**
 * 健康检查（事故修复：只查 API /healthz 会漏掉 web 代理故障——
 * v0.1.1 更新器误删 [...path]/route.js 后 API 正常但 web 代理 500，supervisor 未回退）。
 * 现在两路都查：
 * 1. API 直接：http://127.0.0.1:8711/healthz
 * 2. Web 代理链路：http://127.0.0.1:3210/api/v1/healthz（经过 web → API 代理，
 *    覆盖 Next.js 路由/代理层故障）
 * 且校验返回体 version === 目标版本（API 的 HealthResponse 带 version）。
 */
async function checkHealth(expectedVersion) {
  const results = await Promise.all([
    fetchJson(`http://127.0.0.1:${RUNTIME_API_PORT}/healthz`),
    fetchJson(`http://127.0.0.1:${RUNTIME_WEB_PORT}/api/v1/healthz`),
  ]);
  for (const r of results) {
    if (!r.ok) return { ok: false, reason: r.reason };
    if (r.body?.ok !== true) return { ok: false, reason: 'healthz ok 字段不为 true' };
  }
  if (expectedVersion !== null && expectedVersion !== undefined) {
    for (const r of results) {
      const v = r.body && typeof r.body === 'object' && typeof r.body.version === 'string' ? r.body.version : null;
      if (v === null) return { ok: false, reason: 'healthz 无 version 字段' };
      if (v !== expectedVersion) return { ok: false, reason: `healthz version=${v}，期望 ${expectedVersion}` };
    }
  }
  return { ok: true, reason: null };
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, body: null };
    const body = await res.json().catch(() => null);
    return { ok: true, reason: null, body };
  } catch (err) {
    return { ok: false, reason: err?.code ?? err?.message ?? String(err), body: null };
  }
}

function writeSupervisorJson() {
  writeJsonAtomic(supervisorFile, {
    pid: process.pid,
    version: runningVersion,
    startedAt: new Date(startedAtMs).toISOString(),
    lastHealthyAt: lastHealthyAt ? new Date(lastHealthyAt).toISOString() : null,
  });
}

async function healthLoop() {
  healthTimer = setInterval(async () => {
    if (shuttingDown || restarting) return;
    const checkedVersion = runningVersion;
    const checkedSwitch = versionSwitchedAt;
    const { ok, reason } = await checkHealth(checkedVersion);
    if (shuttingDown || restarting || checkedVersion !== runningVersion || checkedSwitch !== versionSwitchedAt) return;
    if (ok) {
      newVersionDeadline = null; // 已就绪后结束启动窗口，避免运行数天后一次抖动触发回退
      lastHealthyAt = Date.now();
      writeSupervisorJson();
      return;
    }
    // 常规巡检失败只记录（老版本运行中可能是 API 正常但 web 抖动；不无限回退）
    if (newVersionDeadline === null) {
      if (reason !== null) log(`健康检查失败（${reason}）`);
      return;
    }
    // 新版本健康窗口：SIGHUP 切换后 60s 内未就绪 → 回退（覆盖 API 直接 + web 代理两路）
    if (Date.now() > newVersionDeadline) {
      log(`新版本 ${runningVersion} 在 ${NEW_VERSION_GRACE_MS / 1000}s 内未通过健康检查（${reason}） → 自动回退`);
      newVersionDeadline = null;
      void rollback(`新版本健康检查未通过：${reason}`);
    }
  }, HEALTH_INTERVAL_MS);
}

// ---------- 迁移 ----------
async function runMigrate(releaseDir) {
  const env = {
    ...childEnv(releaseDir),
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    INIT_ADMIN_EMAIL: process.env.INIT_ADMIN_EMAIL ?? '',
    INIT_ADMIN_PASSWORD: process.env.INIT_ADMIN_PASSWORD ?? '',
  };
  return new Promise((resolveMigrate) => {
    const proc = spawn('node', ['migrate/index.mjs'], { cwd: releaseDir, env, stdio: 'inherit' });
    const t = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolveMigrate(false);
    }, 5 * 60_000);
    proc.on('exit', (code) => {
      clearTimeout(t);
      resolveMigrate(code === 0);
    });
  });
}

// ---------- 版本选择与启动 ----------
async function startVersion(version, { recordSwitch = true, healthDeadline = false } = {}) {
  const releaseDir = join(releasesDir, version);
  const problem = verifyRelease(releaseDir, version);
  if (problem !== null) {
    return problem;
  }
  log(`切换到版本 ${version}`);
  const prev = runningVersion;
  runningVersion = version;
  if (recordSwitch) {
    versionSwitchedAt = Date.now();
    crashCount = 0;
  }
  // 迁移
  const migrated = await runMigrate(releaseDir);
  if (!migrated) {
    return `迁移失败（${version}）`;
  }
  if (prev !== null && prev !== version) {
    writeFileSync(previousFile, `${prev}\n`);
  }
  // 启动子进程
  const env = childEnv(releaseDir);
  for (const spec of childSpecs(releaseDir)) {
    startChild(spec, env);
  }
  newVersionDeadline = healthDeadline ? Date.now() + NEW_VERSION_GRACE_MS : null;
  lastHealthyAt = null;
  writeSupervisorJson();
  return null;
}

async function stopEverything(graceMs) {
  await stopChildren(graceMs);
  children.clear();
}

// ---------- 回退 ----------
function writeRollbackTask(status, reason, from, to) {
  const task = readJsonIfExists(updateTaskFile) ?? {
    id: `sup-${Date.now()}`, kind: 'update', fromVersion: to ?? from,
    targetVersion: from, startedAt: new Date().toISOString(), requestedBy: null,
  };
  writeJsonAtomic(updateTaskFile, {
    ...task, status, message: reason, progress: null, finishedAt: new Date().toISOString(),
    reason, from, to,
  });
}

async function rollback(reason) {
  if (restarting || shuttingDown) return;
  restarting = true;
  const previous = readTextIfExists(previousFile);
  const target = previous && existsSync(join(releasesDir, previous)) ? previous : null;
  if (target === null || target === runningVersion) {
    log(`无法回退（previous=${previous ?? '无'}），维持当前状态`);
    writeRollbackTask('failed', `${reason}；回退目标不可用：${previous ?? '无 previous'}`, runningVersion, null);
    restarting = false;
    // 无处可退：继续退避重启当前版本
    crashCount = 0;
    versionSwitchedAt = 0;
    return;
  }
  log(`回退到 ${target}（原因：${reason}）`);
  await stopEverything(SHUTDOWN_WAIT_MS);
  switchCurrent(DATA_DIR, target);
  writeRollbackTask('rolled_back', reason, runningVersion, target);
  const err = await startVersion(target);
  if (err !== null) {
    log(`回退版本启动失败：${err}`);
    writeRollbackTask('failed', `回退版本启动失败：${err}`, runningVersion, target);
  }
  restarting = false;
}

// ---------- SIGHUP 重启协议 ----------
async function handleSighup() {
  if (restarting || shuttingDown) return;
  restarting = true;
  log('收到 SIGHUP：重新解析 current 并重启');
  const target = currentVersion();
  if (target === null || !existsSync(join(releasesDir, target))) {
    log(`current 指向的版本不可用（${target ?? '无'}），忽略`);
    restarting = false;
    return;
  }
  const previous = runningVersion;
  await stopEverything(SHUTDOWN_WAIT_MS);
  const err = await startVersion(target, { healthDeadline: target !== previous });
  restarting = false;
  if (err !== null) {
    log(`新版本启动失败：${err} → 回退到 ${previous}`);
    if (previous && previous !== target && existsSync(join(releasesDir, previous))) {
      // 直接回到 SIGHUP 前的运行版本（不再走 rollback 重读 previous 文件——
      // 那样会二次回退到更早版本）
      switchCurrent(DATA_DIR, previous);
      writeRollbackTask('rolled_back', `新版本 ${target} 启动失败：${err}`, target, previous);
      const err2 = await startVersion(previous, { recordSwitch: false });
      if (err2 !== null) {
        log(`回退版本 ${previous} 也失败：${err2} → 尝试 previous 文件`);
        await rollback(`回退 ${previous} 失败：${err2}`);
      }
    } else {
      log('无可用回退版本，退出');
      await gracefulExit(1);
    }
  }
}

// ---------- 优雅退出 ----------
async function gracefulExit(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('退出中：停止子进程…');
  if (healthTimer) clearInterval(healthTimer);
  await stopChildren(EXIT_WAIT_MS);
  log('已退出');
  process.exit(code);
}

process.on('SIGTERM', () => { void gracefulExit(0); });
process.on('SIGINT', () => { void gracefulExit(0); });
process.on('SIGHUP', () => { void handleSighup(); });
process.on('uncaughtException', (err) => {
  log(`未捕获异常：${err?.stack ?? err}`);
  void gracefulExit(1);
});

// ---------- main ----------
const startedAtMs = Date.now();

async function main() {
  mkdirSyncSafe(releasesDir);
  // 1. 镜像自带发布包 → data
  if (isValidVersion(IMAGE_VERSION)) {
    const inData = join(releasesDir, IMAGE_VERSION);
    const inBundle = join(BUNDLE_DIR, IMAGE_VERSION);
    if (!existsSync(inData) && existsSync(inBundle)) {
      log(`复制镜像自带发布包 ${IMAGE_VERSION} → data`);
      // 保留相对 symlink；先完整复制并校验，避免容器中断留下半个发布包。
      const staging = `${inData}.image-staging`;
      rmSync(staging, { recursive: true, force: true });
      cpSync(inBundle, staging, { recursive: true, verbatimSymlinks: true });
      const problem = verifyRelease(staging, IMAGE_VERSION);
      if (problem) throw new Error(`镜像发布包校验失败：${problem}`);
      renameSync(staging, inData);
    }
  }
  // 2. 版本选择：max(current, 镜像版本)
  const cur = currentVersion();
  const selected = maxVersion(cur, isValidVersion(IMAGE_VERSION) && existsSync(join(releasesDir, IMAGE_VERSION)) ? IMAGE_VERSION : null) ?? cur;
  if (!selected || !existsSync(join(releasesDir, selected))) {
    log(`没有可用的发布包（current=${cur ?? '无'}，镜像=${IMAGE_VERSION}）`);
    process.exit(1);
  }
  // 3. current 指向选中版本（站内更新据此判断；镜像升级后被 max() 选中也会更新）
  if (currentVersion() !== selected) {
    switchCurrent(DATA_DIR, selected);
  }
  // 4. 启动
  const err = await startVersion(selected, { healthDeadline: false });
  if (err !== null) {
    log(`首版启动失败：${err}`);
    // 首次启动失败：若有 previous 尝试回退，否则退出
    const prev = readTextIfExists(previousFile);
    if (prev && prev !== selected && existsSync(join(releasesDir, prev))) {
      await stopEverything(5000).catch(() => {});
      switchCurrent(DATA_DIR, prev);
      const err2 = await startVersion(prev);
      if (err2 !== null) {
        log(`回退也失败：${err2}，退出`);
        process.exit(1);
      }
    } else {
      process.exit(1);
    }
  }
  // 4. 健康循环
  await healthLoop();
  log(`运行中：版本 ${runningVersion}（supervisor pid ${process.pid}）`);
}

function mkdirSyncSafe(p) {
  try {
    mkdirSync(p, { recursive: true });
  } catch { /* 已存在 */ }
}

// 仅当作为主模块运行时启动（测试导入时不执行 main）
if (process.argv[1] && (process.argv[1].endsWith('supervisor.mjs') || process.argv[1].endsWith('supervisor.js'))) {
  main();
}
