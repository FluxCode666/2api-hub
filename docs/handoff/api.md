# API 交付说明（Kimi / 后端）

DB READY: 2026-10-22T00:35+08:00

运行命令：

```bash
pnpm db:migrate && pnpm db:seed   # 空库初始化 + 种子（幂等，可重复执行）
pnpm --filter @hub/api dev        # 启动 API，127.0.0.1:8711（tsx watch）
pnpm --filter @hub/api typecheck  # TS strict 通过
pnpm --filter @hub/api test       # vitest 16 个集成测试通过（结束后自动恢复种子数据）
```

## 种子账号

| 角色 | 邮箱 | 密码 |
| --- | --- | --- |
| 管理员 | admin@2api.hub | admin123456 |
| 站长 | merchant@2api.hub | merchant123456 |
| 用户 | user@2api.hub | user123456 |

## 数据规模

14 站点（12 已上线 + 2 待审核）/ 34 渠道 / 84+ 渠道模型 / 34272 条 probe_runs（7 天 × 每 10 分钟）/ 64–74 份真伪报告 / reviews、favorites、feedback、announcements 若干。
渠道 base_url 指向 mock-upstream（`http://127.0.0.1:8712/<scenario>`），genuine/fast 约 65%。
**channel_stats / site_stats 由 worker 启动时全量聚合**，seed 不写；API 对缺失 stats 按「无数据」处理（返回 null 和默认值）。

## 接口可用状态（全部已实现并通过冒烟）

- 公开：`/meta` `/vendors[/:slug]` `/models[/:slug]` `/channels` `/channels/:id` `/channels/:id/history` `/channels/:id/reports` `/sites` `/sites/:slug` `/sites/:slug/reviews` `/rankings/overview` `/announcements` `/verify` `/feedback` `/go/:channelId`（302）
- 认证：`/auth/register|login|logout|me`（jose JWT，httpOnly cookie `hub_session`，7 天）
- 用户：`/me/favorites`（GET/POST/DELETE）、`/sites/:slug/reviews`（POST，再提交为更新）、`/me/reviews`（GET 分页 / DELETE /:id，契约增量 #1）、`/me/notifications`（GET + read）
- 站长：`/merchant/overview`、`/merchant/sites` 全部 CRUD + submit、`/merchant/sites/:id/channels`、PATCH/DELETE `/merchant/channels/:id`、test、discover、PUT models（upsert 保留检测元数据）、authenticity（每日限次）、tasks/:id、runs
- 管理：`/admin/overview`、sites（列表/详情/review/PATCH）、channels（probe/PATCH 全字段）、vendors（CRUD，返回 `AdminVendor[]` 契约增量 #2）、models（CRUD）、users、probe-runs、tasks、feedback、reviews、announcements、settings（GET/PUT）、audit-logs
- `/healthz`

## 关键行为说明

- **榜单 SQL 筛选/排序/分页**：null 值永远排最后；rank 跨页连续；带 `model` 时按该模型价格（站长覆盖价优先）。
- **越权**：站长操作他人资源一律 404；非 admin 访问管理接口 403。
- **Key 安全**：任何接口只返回 `apiKeyMask`（`sk-****1234`）；`verify_requests` 只存 ipHash/host/模型/得分，不落 Key；审计 meta 不含 apiKey 字段。
- **probe 降级**：`@hub/probe` 抛 `not implemented` 时返回 503 `{code:"probe_unavailable"}`（GLM 实现后自动可用）。
- **boolean query**：`stableOnly`/`featured` 用 `z.enum(['true','false','1','0']).transform(...)`，`stableOnly=false` 不会误开启过滤。
- **渠道编辑**：apiKey/baseUrl/protocol/primaryModel 变化自动清 `lastTestOk/lastTestAt`；已上线站点修改关键字段自动排队检测任务。
- **审核**：approve 时 owner 从 user 升级 merchant + 创建通知 + 写审计日志；reject 必须填原因。
- **设置**：`scoring.weights` 全 0 会被 zod refine 拒绝（权重和必须 > 0）。
- **raw SQL 时间字段**：`db.execute` 返回的 timestamp 是 string，统一在序列化层转 ISO。

## 部署与工程化（第二个任务）

- `pnpm dev`：concurrently 一键启动 mock/api/worker/web（彩色前缀）
- `pnpm setup:local`：db:up → 等待健康 → migrate → seed
- `apps/api/Dockerfile`、`apps/worker/Dockerfile`、`apps/mock-upstream/Dockerfile`、`apps/web/Dockerfile`：多阶段，pnpm workspace 裁剪，tsx 运行 TS 源码
- `deploy/docker-compose.prod.yml`：postgres + migrate（一次性 job）+ api + worker + web，mock-upstream 在 demo profile
- `deploy/prod.env.example`：环境变量模板（`ALLOW_PRIVATE_PROBE=false`，密钥 `openssl rand -hex 32`）
- `README.md`：中文，含 mermaid 架构图、快速开始、账号、端口、部署步骤
- `docker build` api 和 worker 镜像均成功
- **需要前端配合**：`apps/web/next.config.ts` 需加 `output: 'standalone'`（web Dockerfile 按此设计）
- Docker Hub 在本机被墙，通过 `docker.m.daocloud.io` 镜像加速器拉取 `node:22-alpine` 后 `docker tag` 为本地镜像

## 审查修复（2026-10-22，对应 docs/review/api-review.md）

| # | 问题 | 修复 |
| --- | --- | --- |
| 2 | 上游回显 Key 落入 probe_runs | 写入前 `sanitizeKeyFromText` 用真实 Key 精确替换（含 URL 编码变体）；公开接口 errorMessage 改为 errorCode 映射固定中文分类；一次性清理脚本 `apps/api/src/clean-error-messages.ts` 已跑（更新 1 行） |
| 3 | trustProxy 无条件 true | 从 `TRUST_PROXY` 环境变量读取（默认 false）；`.env.example`、`deploy/prod.env.example`、compose 已更新说明 |
| 4 | /verify 并发突破限频 | 事务内先插入 pending 记录再计数（原子预留）；单 IP 并发上限 1、全局并发上限 4；失败退还预留额度 |
| 5 | 入队不去重/非原子 | 抽出 `enqueueProbeTask()`（`SELECT ... FOR UPDATE` 锁渠道 + 复用 queued/running + 站长额度同事务检查）；PATCH 仅真实变化才入队（解密旧 Key 比较）；部分唯一索引 `probe_tasks_active_uq`（增量迁移 0001，CONTRACT-CHANGES 已记录） |
| 6 | 生产监听 127.0.0.1 | `API_HOST` 环境变量（默认 127.0.0.1），compose 设 `0.0.0.0`；worker 8713 与 mock-upstream 8712 有同样问题 → 已在下方注明由 GLM 修 |
| 7 | 按模型查榜单重复行 | lateral 子查询每渠道取一行（主测模型优先 → 有覆盖价 → 价格最低）；count/sort/page 前去重；测试覆盖 |
| 8 | Cookie 缺 Secure | 生产（`NODE_ENV=production` 或 `COOKIE_SECURE=true`）自动加 Secure |
| 9 | URL 无协议白名单 | `httpUrl()` 校验器（只许 http/https）应用到所有站点/渠道 URL 写入与 `/go` 跳转 |
| 10 | 关闭注册不生效 | 注册前读 `site.allowRegistration`，关闭返回 403 `registration_closed` |
| 11 | apiKey '' 违反契约 | zod transform 把 `''` 归一为 `undefined`（留空不修改）；创建仍要求非空 |
| 12 | 最新报告读全量到内存 | `DISTINCT ON (channel_id) ORDER BY channel_id, created_at DESC, id DESC` 在数据库中取每渠道最新一条 |
| 13 | 渠道详情依赖站点前 100 名 | 改为 `queryChannels({ids:[id], page:1, pageSize:1})` 按 id 直查 |

**测试改用独立测试库 `hub_test`**（不再 TRUNCATE 开发库）。运行前：`DATABASE_URL=postgres://hub:hub@127.0.0.1:54329/hub_test pnpm --filter @hub/db migrate`。

typecheck 通过；19 个测试全通过（新增 #7 去重、#5 入队复用、PATCH 同 Key 不入队）。

**待 GLM 修复（不属本范围）**：
- probe 库 #1 TLS 明文问题（GLM-A）
- probe 库 #2 边界的 sample/detail/evidence 脱敏（GLM-A）
- worker 8713 健康检查监听地址（GLM-B）
- mock-upstream 8712 监听地址（GLM-A）

## 第二轮审查修复（2026-10-22，对应 docs/review/engine-review.md）

| # | 修复 |
| --- | --- |
| 1 | 所有 Key 入口校验 ≥ 8 位（中文报错）；sanitize 门槛 ≥ 4；先替换再截断 |
| 7 | enqueue 事务内全部查询用 tx；SET LOCAL lock_timeout/statement_timeout；15 并发回归测试通过 |
| 8 | /verify 信号量同步占用（第一个 await 前）；进程级上限语义已在 README 说明 |
| 9 | 额度规则收进 enqueueProbeTask（trigger=merchant+kind=authenticity 自动计入）；超限时 PATCH 照常保存但不入队，响应头 `X-Hub-Notice` 提示 |
| Dockerfile/compose | api 加 `ENV API_HOST=0.0.0.0`；worker 加 `WORKER_HOST=0.0.0.0`；mock 加 `MOCK_HOST=0.0.0.0` |

## 已知问题 / 依赖

- mock-upstream（8712）未启动时，连接测试返回 `network` 错误（符合预期）；worker 启动后 channel_stats/site_stats 会有数据。
- seed 的 slug 若含中文会以中文为 slug（如「冒烟测试站」），建议后续 slugify 过滤非 ASCII（不阻塞）。
