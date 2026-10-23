# 发版、部署与站内热更新（契约）

> 参考 AUXUM（`/Users/duegin/project/aux-system/deploy/UPDATES.md`）的「tag 发版 + 管理员在后台主动原地更新」模式，适配本项目的 Node 多进程形态。
> 本文是运行时（GLM-A）、更新器 API（Kimi）、前端（Codex）三方的接口契约，修改需经编排者同意。

## 1. 版本号

- 版本 tag 使用语义化版本 `vMAJOR.MINOR.PATCH`（可带预发布后缀，如 `v0.2.0-rc.1`，预发布不参与站内更新）。
- 根目录 `package.json` 的 `version` 与 tag 一致（不含 `v`）。
- 版本比较一律按 semver（`v0.10.0 > v0.9.3`），不能按字符串比较。

## 2. 生产镜像与运行时

单一应用镜像 `ghcr.io/fluxcode666/2api-hub:<tag>`（`linux/amd64` + `linux/arm64`），根目录 `Dockerfile` 构建。镜像内：

```
/app/runtime/            # 镜像层，随镜像升级：supervisor.mjs、entrypoint.sh
/app/bundle/<tag>/       # 镜像自带的发布包（与 Release 资产内容相同）
/app/data/               # 持久卷（docker volume），站内更新写这里
  releases/<tag>/        # 已安装的发布包
  current -> releases/<tag>   # 相对符号链接，当前运行版本
  previous               # 文本文件：上一个版本 tag（用于回退）
  update-task.json       # 最近一次更新/回退任务状态（跨重启保留）
  supervisor.json        # supervisor 写入：{ pid, version, startedAt, lastHealthyAt }
```

### 2.1 发布包结构（`releases/<tag>/`，也是 Release 资产解压后的内容）

```
release.json             # { "version": "v0.1.0", "commit": "<sha>", "buildDate": "<ISO>" }
api/index.mjs            # esbuild 打包的 API（单文件，无 node_modules 依赖）
worker/index.mjs         # esbuild 打包的 worker
migrate/index.mjs        # 迁移 + 初始化（见 §2.3）
drizzle/                 # 迁移 SQL 与 meta
web/                     # Next.js standalone：server.js、.next/static、public
```

发布包与 CPU 架构无关（纯 JS + wasm）；**禁止**引入原生模块。

### 2.2 entrypoint 与 supervisor（PID 1 为 tini → `node /app/runtime/supervisor.mjs`）

启动时：
1. 若 `/app/data/releases/<镜像自带 tag>` 不存在，则从 `/app/bundle/<tag>` 复制过去。
2. 确定运行版本：`current` 不存在 → 使用镜像版本；`current` 存在 → 取 **max(current, 镜像版本)**（semver）。这样手动升级镜像会生效，而站内更新出的更高版本在容器重建后依然保留。
3. 运行 `node <release>/migrate/index.mjs`（失败则不启动业务进程，进入回退逻辑，见下）。
4. 启动 3 个子进程（工作目录为发布包目录，注入下列环境变量）：
   - `api`：`node api/index.mjs`，`API_HOST=127.0.0.1`，`API_PORT=8711`
   - `worker`：`node worker/index.mjs`，`WORKER_HOST=127.0.0.1`，`WORKER_HEALTH_PORT=8713`
   - `web`：`node web/server.js`，`HOSTNAME=0.0.0.0`，`PORT=3210`，`API_INTERNAL_URL=http://127.0.0.1:8711`
   - 所有子进程额外注入：`HUB_DATA_DIR=/app/data`、`HUB_RELEASE_DIR=<当前发布包绝对路径>`、`HUB_SUPERVISOR_PID=<supervisor pid>`、`HUB_VERSION=<tag>`
5. 子进程异常退出 → 指数退避重启（1s→30s）；任何子进程连续崩溃 5 次且距上次版本切换 < 5 分钟 → 视为新版本启动失败，触发自动回退。
6. 每 10s 检查 `http://127.0.0.1:8711/healthz`，写 `supervisor.json` 的 `lastHealthyAt`。

**重启协议**：任意子进程向 supervisor 发送 `SIGHUP` → supervisor 重新解析 `current`，执行迁移，优雅停止全部子进程（SIGTERM，最多等 20s，超时 SIGKILL），再以新版本启动。新版本 60s 内 API `/healthz` 未就绪 → 自动回退：把 `current` 指回 `previous` 中记录的版本并重启，同时把 `update-task.json` 置为 `rolled_back` 并写明原因。

**退出**：supervisor 收到 SIGTERM/SIGINT → 转发 SIGTERM 给子进程，等待最多 25s 后退出（容器 `stop_grace_period: 30s`）。

### 2.3 迁移与首次初始化（`migrate/index.mjs`）

幂等执行：
1. drizzle 迁移（`drizzle/`）。
2. `vendors` 表为空 → 写入 `SEED_VENDORS` / `SEED_MODELS`；`settings` 缺失的 key → 写入 `DEFAULT_SETTINGS` 对应值（不覆盖已有值）。
3. 不存在任何 `role='admin'` 的用户，且设置了 `INIT_ADMIN_EMAIL` + `INIT_ADMIN_PASSWORD`（≥ 12 位）→ 创建管理员。已有管理员时忽略这两个变量。
4. **绝不**写入演示站点/渠道（演示数据只在 `pnpm db:seed`）。

## 3. Release 资产（GitHub Actions 产出）

| 资产 | 说明 |
| --- | --- |
| `2api-hub-<tag>.tar.gz` | 发布包（§2.1），解压后顶层即 `release.json` 等文件 |
| `checksums.txt` | `sha256sum` 格式：`<64位hex>  2api-hub-<tag>.tar.gz` |
| `release-manifest.json` | `{ "version", "commit", "buildDate", "asset": { "name", "sha256", "size" }, "image": "ghcr.io/fluxcode666/2api-hub:<tag>" }` |

Release 正文为中文更新说明，取自 `CHANGELOG.md` 中 `## [vX.Y.Z]` 小节（缺失则 CI 失败，强制写更新说明）。

## 4. 站内更新（API，admin 专属）

配置（环境变量）：`HUB_RELEASE_REPOSITORY`（默认 `FluxCode666/2api-hub`）、`HUB_GITHUB_TOKEN`（可选，私有仓库或提高限额用，只在服务端使用）、`HUB_DATA_DIR`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/admin/system/version` | `SystemVersionInfo`；`?refresh=true` 强制重新查询 GitHub（默认缓存 10 分钟） |
| POST | `/api/v1/admin/system/update` | `{ targetVersion }` → 202 `UpdateTask`；单飞（已有进行中任务返回 409） |
| POST | `/api/v1/admin/system/rollback` | 回退到 `previous` → 202 `UpdateTask` |
| GET | `/healthz` | `{ ok: true, version }`（公开，不需要登录） |

更新流程（服务端，独立于请求的后台任务，整体超时 15 分钟）：
1. **检查**：重新查询 `GET https://api.github.com/repos/{repo}/releases/latest`（非预发布最新版），要求 `targetVersion === latest.tag` 且 semver 大于当前版本，资产齐全；否则拒绝（不允许降级、过期目标、无效版本）。
2. **下载**：只允许 `github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com` 主机（跟随重定向时逐跳校验），大小上限 200MB，写入 `HUB_DATA_DIR/tmp/`。
3. **校验**：读取 `checksums.txt`，对下载文件计算 SHA-256 比对。
4. **解压**：解压到 `releases/<tag>.staging/`，校验 `release.json.version === tag` 且关键文件存在（防路径穿越：拒绝绝对路径和 `..`），然后原子 rename 为 `releases/<tag>/`。
5. **切换**：把当前版本写入 `previous`，原子替换 `current` 符号链接（新建临时链接后 rename）。
6. **重启**：向 `HUB_SUPERVISOR_PID` 发送 `SIGHUP`。任务置为 `restarting`；新版本 API 启动后读取 `update-task.json`，若 `targetVersion === 当前版本` 则置为 `succeeded`。
7. 记录审计日志 `system.update` / `system.rollback`；保留最近 3 个版本，清理更旧的发布包。

非生产环境（未设置 `HUB_DATA_DIR`、目录不可写或不存在 supervisor）：`canUpdate=false`，`reason` 为「当前为开发环境，不支持在线更新」。

## 5. 前端

- 管理后台侧边栏顶部的品牌区显示当前版本号徽章（如 `v0.1.0`），有新版本时显示圆点提示。
- 点击打开「系统版本」对话框：当前版本、构建时间、提交；最新版本、发布时间、中文更新说明（Markdown 渲染，需清洗 HTML）；「更新到 vX.Y.Z」主按钮（二次确认：提醒先备份数据库）；更新过程展示步骤进度（检查 → 下载 → 校验 → 解压 → 切换 → 重启），轮询任务状态；进入 `restarting` 后轮询 `/healthz` 直到 `version` 变为目标版本，提示成功并刷新页面；失败/自动回退时展示原因。
- 存在 `previousVersion` 时提供「回退到 vX」（二次确认）。
- 公开站页脚以次要文字显示版本号。

## 6. 生产部署（服务器 64.81.113.70）

- 部署目录 `/root/2api-hub/`：`docker-compose.yml`（即 `deploy/docker-compose.prod.yml`）+ `.env`（权限 600，密钥随机生成，不入库）。
- 服务：`2api-hub-postgres`（postgres:16-alpine，仅内部网络，数据卷 `2api-hub-pg`）、`2api-hub-app`（应用镜像，`0.0.0.0:3210:3210`，数据卷 `2api-hub-data:/app/data`，`restart: unless-stopped`，健康检查）。网络 `2api-hub`。不修改宿主机 nginx 与其他容器。
- 生产环境：`ALLOW_PRIVATE_PROBE=false`、`TRUST_PROXY=false`、`COOKIE_SECURE=false`（直连 HTTP，后续上 HTTPS 时改为 true）、`NODE_ENV=production`。
