#!/usr/bin/env node
/*
 * 发布包构建脚本（RELEASE.md §2.1）：
 * - esbuild 打包 api / worker / migrate 为单文件 ESM（platform: node, target: node22）
 * - Next.js standalone 构建（HUB_SKIP_API_PRERENDER=1），组装 web/
 * - 产出 dist/release/<tag>/、dist/2api-hub-<tag>.tar.gz、dist/checksums.txt、dist/release-manifest.json
 *
 * 用法：node scripts/release/build.mjs [--tag v0.1.0]
 * 版本：--tag 参数 > package.json version（加 v 前缀）
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = join(root, 'dist');

// ---------- 版本 ----------
const argTag = process.argv.find((a) => a.startsWith('--tag='))?.slice('--tag='.length)
  ?? (() => { const i = process.argv.indexOf('--tag'); return i > 0 ? process.argv[i + 1] : undefined; })();
let pkgVersion;
try {
  pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.0.0';
} catch {
  console.error('[release] 根 package.json 解析失败');
  process.exit(1);
}
const withVPrefix = (v) => (v.startsWith('v') ? v : `v${v}`);
const tag = argTag ? withVPrefix(argTag) : withVPrefix(pkgVersion);
const commit = execFileSync('git', ['log', '-1', '--format=%H'], { cwd: root }).toString().trim();
const buildDate = new Date().toISOString();
console.log(`[release] 构建 ${tag}（commit ${commit.slice(0, 8)}，${buildDate}）`);

// ---------- 清理 ----------
const releaseDir = join(dist, 'release', tag);
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });
rmSync(join(dist, `2api-hub-${tag}.tar.gz`), { force: true });

// ---------- 1. esbuild 打包 api / worker / migrate ----------
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: false, // 保留可读性，便于线上排查
  legalComments: 'none',
  banner: {
    // CJS 依赖（postgres、bcryptjs 等）在 ESM 输出里需要 createRequire
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  // gpt-tokenizer 的 .txt 词表数据：esbuild 会把它作为 text 内联（loader 默认）。
  // wasm：项目依赖里无 wasm（发布包禁止原生模块），若未来引入需在此处理。
};

const entries = [
  { in: join(root, 'apps/api/src/index.ts'), out: join(releaseDir, 'api/index.mjs') },
  { in: join(root, 'apps/worker/src/index.ts'), out: join(releaseDir, 'worker/index.mjs') },
  { in: join(root, 'scripts/release/migrate-entry.ts'), out: join(releaseDir, 'migrate/index.mjs') },
];

for (const e of entries) {
  mkdirSync(dirname(e.out), { recursive: true });
  console.log(`[release] esbuild: ${e.in.replace(root + '/', '')} → ${e.out.replace(root + '/', '')}`);
  await build({ ...common, entryPoints: [e.in], outfile: e.out });
}

// ---------- 2. 迁移 SQL ----------
console.log('[release] 复制 drizzle 迁移');
cpSync(join(root, 'packages/db/drizzle'), join(releaseDir, 'drizzle'), { recursive: true });

// ---------- 3. Next.js standalone ----------
console.log('[release] 构建 Next.js（HUB_SKIP_API_PRERENDER=1）');
execFileSync('pnpm', ['--filter', '@hub/web', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, HUB_SKIP_API_PRERENDER: '1', NEXT_TELEMETRY_DISABLED: '1' },
});

const webStandalone = join(root, 'apps/web/.next/standalone');
if (!existsSync(webStandalone)) {
  console.error('[release] 未找到 .next/standalone（next.config.ts 需 output:"standalone"）');
  process.exit(1);
}
// outputFileTracingRoot 指向仓库根：standalone 结构为
//   standalone/node_modules/.pnpm/...（pnpm 实体树）
//   standalone/apps/web/server.js + apps/web/node_modules/*（相对 symlink → ../../../node_modules/.pnpm/...）
// 因此必须复制**整个 standalone 树**并保留 symlink（相对路径在发布包内依然有效）。
// 之前只复制 apps/web 子树会导致 symlink 断链（Cannot find module 'next'）。
console.log('[release] 复制 standalone 树（保留 pnpm 相对 symlink）');
const webOut = join(releaseDir, 'web');
mkdirSync(webOut, { recursive: true });
// tar 不带 -h：保留符号链接（相对 symlink 在新位置依然解析正确）
execFileSync('sh', ['-c', `tar -cf - -C '${webStandalone}' . | tar -xpf - -C '${webOut}'`], { cwd: root });
// 静态资源与 public（standalone 不含）
mkdirSync(join(webOut, 'apps/web/.next/static'), { recursive: true });
execFileSync('sh', ['-c', `tar -cf - -C '${join(root, 'apps/web/.next/static')}' . | tar -xpf - -C '${join(webOut, 'apps/web/.next/static')}'`], { cwd: root });
if (existsSync(join(root, 'apps/web/public'))) {
  mkdirSync(join(webOut, 'apps/web/public'), { recursive: true });
  execFileSync('sh', ['-c', `tar -cf - -C '${join(root, 'apps/web/public')}' . | tar -xpf - -C '${join(webOut, 'apps/web/public')}'`], { cwd: root });
}
// 包装入口 web/server.js：转发到 apps/web/server.js（supervisor 以 node web/server.js 启动）
writeFileSync(join(webOut, 'server.js'), [
  '// 2API Hub web 包装入口：转发到 Next.js standalone（apps/web/server.js）',
  "import('./apps/web/server.js');",
  '',
].join('\n'));

// ---------- 4. 原生模块处理（发布包必须与 CPU 架构无关）----------
// Next 的可选依赖 sharp 带平台二进制（@img/sharp-*/*.node）。项目未使用 next/image
// （全站无 <Image> 组件），sharp 不会被调用——排除全部平台二进制，保证纯 JS。
// 若未来启用 next/image，需改为 images.unoptimized 或在运行时按平台安装 sharp。
console.log('[release] 排除原生二进制（@img/sharp-* 平台包）…');
const removedNative = [];
const walkRemove = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walkRemove(p);
    } else if (name.endsWith('.node')) {
      rmSync(p);
      removedNative.push(p.replace(releaseDir + '/', ''));
    }
  }
};
walkRemove(releaseDir);
// 清掉空掉的 @img 目录
const walkClean = (dir) => {
  let empty = true;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!walkClean(p)) rmSync(p, { recursive: true, force: true });
      else empty = false;
    } else empty = false;
  }
  return !empty;
};
walkClean(releaseDir);
if (removedNative.length > 0) {
  console.log(`[release] 已排除 ${removedNative.length} 个原生二进制`);
}
// 残留检查（防御）
const nativeLeft = [];
const walkCheck = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkCheck(p);
    else if (name.endsWith('.node')) nativeLeft.push(p);
  }
};
walkCheck(releaseDir);
if (nativeLeft.length > 0) {
  console.error(`[release] 发布包仍含原生模块：\n  ${nativeLeft.join('\n  ')}`);
  process.exit(1);
}

// ---------- 5. release.json ----------
writeFileSync(join(releaseDir, 'release.json'), JSON.stringify({ version: tag, commit, buildDate }, null, 2) + '\n');

// ---------- 5.1 完整性清单（files.sha256 + files.symlinks）----------
// 每行「<sha256>  <相对路径>」（/ 分隔）；覆盖所有普通文件，不含清单自身。
// 符号链接单独记录在 files.symlinks：「<相对路径> -> <目标>」。
// supervisor 的 verifyRelease 与更新器解压后共用这份清单校验（事故修复）。
console.log('[release] 生成完整性清单（files.sha256 / files.symlinks）…');
{
  const hashLines = [];
  const linkLines = [];
  const walkList = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const relPath = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        linkLines.push(`${relPath} -> ${readlinkSync(p)}`);
      } else if (st.isDirectory()) {
        walkList(p, relPath);
      } else if (st.isFile()) {
        if (relPath === 'files.sha256' || relPath === 'files.symlinks') continue; // 清单自身不进哈希清单
        const h = createHash('sha256').update(readFileSync(p)).digest('hex');
        hashLines.push(`${h}  ${relPath}`);
      }
    }
  };
  walkList(releaseDir, '');
  writeFileSync(join(releaseDir, 'files.symlinks'), linkLines.sort().join('\n') + (linkLines.length > 0 ? '\n' : ''));
  hashLines.push(`${createHash('sha256').update(readFileSync(join(releaseDir, 'files.symlinks'))).digest('hex')}  files.symlinks`);
  writeFileSync(join(releaseDir, 'files.sha256'), hashLines.sort().join('\n') + '\n');
  console.log(`[release] files.sha256：${hashLines.length} 个文件；files.symlinks：${linkLines.length} 个符号链接`);
}

// ---------- 6. tar.gz + checksums + manifest ----------
console.log('[release] 打包 tar.gz');
const tarName = `2api-hub-${tag}.tar.gz`;
// tar 内容以 release.json 等文件为顶层（解压即发布包内容）
execFileSync('tar', ['-czf', join(dist, tarName), '-C', releaseDir, '.'], { cwd: root });

const sha256 = createHash('sha256').update(readFileSync(join(dist, tarName))).digest('hex');
const size = statSync(join(dist, tarName)).size;
writeFileSync(join(dist, 'checksums.txt'), `${sha256}  ${tarName}\n`);

const manifest = {
  version: tag,
  commit,
  buildDate,
  asset: { name: tarName, sha256, size },
  image: `ghcr.io/fluxcode666/2api-hub:${tag}`,
};
writeFileSync(join(dist, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('[release] 完成：');
console.log(`  ${releaseDir.replace(root + '/', '')}/`);
console.log(`  dist/${tarName}（${(size / 1024 / 1024).toFixed(1)} MB，sha256 ${sha256.slice(0, 16)}…）`);
console.log('  dist/checksums.txt');
console.log('  dist/release-manifest.json');
