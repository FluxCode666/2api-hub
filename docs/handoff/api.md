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

## 已知问题 / 依赖

- mock-upstream（8712）未启动时，连接测试返回 `network` 错误（符合预期）；worker 启动后 channel_stats/site_stats 会有数据。
- seed 的 slug 若含中文会以中文为 slug（如「冒烟测试站」），建议后续 slugify 过滤非 ASCII（不阻塞）。
