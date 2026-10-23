# 发版打包与运行时交付说明（GLM-A / release）

负责目录：根 `Dockerfile`、`.dockerignore`、`.github/**`、`scripts/release/**`、`deploy/runtime/**`、`CHANGELOG.md`。
契约：`docs/RELEASE.md`（全程按其 §2 结构与协议实现）。

## 一、发布包构建（scripts/release/build.mjs）

```bash
pnpm release:build --tag v0.1.0     # 版本默认读根 package.json（当前 0.1.0）
```

产出（RELEASE.md §2.1 / §3）：
- `dist/release/v0.1.0/`：`release.json`（version/commit/buildDate）、`api/index.mjs`、`worker/index.mjs`、`migrate/index.mjs`（esbuild 单文件 ESM，`platform:node target:node22`，CJS 依赖走 `createRequire` banner）、`drizzle/`、`web/`（Next standalone 全树 + `server.js` 包装入口）
- `dist/2api-hub-v0.1.0.tar.gz`（24.8MB，解压后顶层即发布包内容）
- `dist/checksums.txt`（sha256sum 格式）
- `dist/release-manifest.json`（version/commit/buildDate/asset/image）

**关键实现点（踩过的坑）**：
1. **Next standalone 的 pnpm symlink**：`outputFileTracingRoot` 指向仓库根时，standalone 树是
   `node_modules/.pnpm/...`（实体）+ `apps/web/node_modules/*`（**相对** symlink → `../../../node_modules/.pnpm/...`）。
   必须复制**整个 standalone 树**且**保留 symlink**（`tar -cf -` 不带 `-h`）——只复制 apps/web 子树或用 `-h` 解引用都会导致
   `Cannot find module 'next'`。发布包入口 `web/server.js` 是包装脚本（转发到 `apps/web/server.js`），与 RELEASE.md §2.1 兼容。
2. **原生模块排除**：Next 的可选依赖 sharp 带 `@img/sharp-*/*.node` 平台二进制。项目未使用 `next/image`（全站无 `<Image>`），
   构建时删除全部 `.node` 并清理空 `@img` 目录，发布包纯 JS（契约「禁止原生模块」）。未来启用 next/image 时需改
   `images.unoptimized` 或运行时装 sharp。
3. migrate 入口调用 Kimi 在 `@hub/db` 实现的 `runMigrations` + `initDatabase`（`packages/db/src/init.ts`，已可用；
   `package.json` exports 加了 `./init` `./client` 子路径）。

## 二、运行时（deploy/runtime/supervisor.mjs + entrypoint.sh）

完整实现 RELEASE.md §2.2：镜像包复制到 data、版本选择 `max(current, 镜像版本)`（自实现 semver）、
migrate（5min 超时）、3 子进程（api/worker/web，注入 HUB_DATA_DIR/HUB_RELEASE_DIR/HUB_SUPERVISOR_PID/HUB_VERSION）、
崩溃指数退避（1s→30s）、切换后 5min 内 5 次崩溃自动回退、10s 健康检查写 `supervisor.json`、
SIGHUP 重启协议（重解析 current → 迁移 → SIGTERM 优雅停止 20s 超时 SIGKILL → 新版本 + 60s 健康窗口）、
健康窗口失败回退并写 `update-task.json`（rolled_back）、SIGTERM/SIGINT 优雅退出 25s。
仅用 Node 内置模块；主模块条件执行（可被测试 import）。

测试：`pnpm test:runtime`（4 项：semver 单元、首次启动、SIGHUP 热切换、损坏包回退——假子进程 + 独立进程组）。

## 三、Docker（根 Dockerfile）

- `node:22-alpine` + tini（PID 1）；非 root 用户 `hub`
- `/app/runtime/`（supervisor + entrypoint）、`/app/bundle/<tag>`（构建好的发布包直接 COPY，多架构无需重复构建）
- `/app/data` VOLUME（属主 hub）；`EXPOSE 3210`；HEALTHCHECK 双端口（3210 + 8711 healthz）
- 基础镜像 registry 可用 `--build-arg NODE_IMAGE_REGISTRY=` 覆盖（本地网络受限用 `docker.m.daocloud.io/library`；CI 用默认 docker.io）
- 本地构建：`scripts/release/docker-build.sh v0.1.0`（自动先 release:build；支持 NODE_IMAGE_REGISTRY 环境变量）

## 四、Docker 实测记录（2026-10-23）

用独立临时资源（hub-release-test-pg / hub-release-test-app / hub-release-test-net，已全部清理；未触碰 hub-postgres 与本机服务）：

1. **首次启动**：空库 → 自动迁移（catalogSeeded=true, settingsAdded=12, adminCreated=true，INIT_ADMIN 管理员创建成功）→ 3 子进程启动 → 首页 HTTP 200（337KB）→ API healthz `{"ok":true,"version":"v0.1.0"}` → `supervisor.json` 正常（version/lastHealthyAt）→ 非 root（uid=100 hub）运行。
2. **热更新**：v0.2.0 发布包放入 `/app/data/releases/` → 原子切 `current` → SIGHUP → 优雅停止旧进程 → migrate → 新版本启动 → `supervisor.json.version=v0.2.0`、`previous=v0.1.0`、healthz 返回 v0.2.0、首页 200。
3. **损坏包自动回退**：v0.3.0（缺 `web/server.js`）→ SIGHUP → `verifyRelease` 拒绝 → 自动回退到 v0.2.0 → `update-task.json` 记录 `{"status":"rolled_back","reason":"新版本 v0.3.0 启动失败：缺少 web/server.js","from":"v0.3.0","to":"v0.2.0"}` → healthz v0.2.0。

## 五、GitHub Actions（.github/workflows/）

- **ci.yml**（push/PR + `workflow_call`）：全量 typecheck → postgres:16 service（建 hub_test 库 + 迁移）→ probe/mock-upstream/api/worker 测试（各包 setup 自行切 hub_test）→ `test:runtime` → web build（`HUB_SKIP_API_PRERENDER=1`）。
- **release.yml**（tag `v*.*.*` + `workflow_dispatch`）：复用 CI → tag 与 package.json version 一致校验 → CHANGELOG `## [vX.Y.Z]` 中文说明提取（缺失失败，写 `/tmp/release-notes.md` 避免模板注入）→ `release:build` → buildx `linux/amd64,linux/arm64` 推 `ghcr.io/fluxcode666/2api-hub:<tag>`（含 `org.opencontainers.image.source` 标签，正式版另推 latest）→ GitHub Release + 3 资产。权限 `contents:write packages:write`。
- 所有 action 已 pin 到 commit SHA（防供应链攻击；来源 tag 记在行尾注释）；release 脚本内的 `${{ }}` 内插已全部改为环境变量引用（zizmor template-injection 清零，仅剩 cache-poisoning 保守误报——工作流无 cache 步骤，发布包 CI 现场构建）。
- **actionlint 校验通过**（docker rhysd/actionlint:latest，0 输出）。

## 六、验证汇总

| 项 | 结果 |
| --- | --- |
| `pnpm release:build --tag v0.1.0` | ✓（24.8MB tar.gz + checksums + manifest） |
| 发布包独立运行（临时库 hub_rel_test） | ✓ migrate / api /healthz / worker /healthz / web 首页 200 + 同源代理 |
| 发布包无原生模块 | ✓（@img/sharp-* 已排除，残留检查通过） |
| `pnpm test:runtime` | ✓ 4/4 |
| `pnpm --filter @hub/probe test`（回归） | ✓ 154/154 |
| docker build（本地镜像源） | ✓ |
| docker 首次启动 / 热切换 / 损坏包回退 | ✓（见第四节） |
| actionlint | ✓ |

## 七、已知问题与说明

1. **`apps/web/Dockerfile`**（Codex 的）与本发版体系独立；生产镜像只用根 Dockerfile。
2. **RELEASE.md §2.1 说 `web/server.js`**：发布包的 `web/server.js` 是包装入口（`import('./apps/web/server.js')`），
   supervisor 以 `node web/server.js` 启动，兼容契约。
3. **migrate 的 INIT_ADMIN**：`≥12 位`密码校验在 `initDatabase`（Kimi 侧）——发布环境必须传合规密码才会创建管理员。
4. **CHANGELOG 提取**：只认 `## [vX.Y.Z]` 精确小节；tag 不存在时 release 直接失败（强制写更新说明）。
5. **zoho zizmor 的 cache-poisoning 告警**：保守误报（无 cache 步骤）；artipacked 告警同理（checkout 默认行为）。
6. **本地 docker build 的镜像源**：本机无法直连 docker.io，Dockerfile 加了 `NODE_IMAGE_REGISTRY` build-arg；
   CI（GitHub）网络正常用默认值。`docker-build.sh` 已透传该参数。
7. 编排者需执行：git add/commit（含新 dist 产物不应入库——.gitignore 检查）与打 tag `v0.1.0` 触发首次发版。
