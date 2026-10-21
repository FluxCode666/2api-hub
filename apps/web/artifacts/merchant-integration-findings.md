# 站长后台真实 API 联调记录

更新日期：2026-10-22。

## 当前状态

已完整只读核对 `apps/api/src/routes/merchant.ts`，并在 API 8711、Web 3210 的真实模式下执行 HTTP 联调。前端请求路径与注册路径一致，主要 DTO 与 `@hub/shared` 一致。当前 8712 mock-upstream 与 8713 worker 尚未监听，成功连接、模型发现和任务终态仍待验证。

首次检查时 merchant.ts 正在写入，文件暂缺；随后已落盘。该时间差已消除，不再视为阻断。

未自行启动、停止或修改后端、worker 服务，未重复 Mock 全链路测试，未运行全站 build。

## 真实复测结果与剩余阻断

### 真实通过：报告字段序列化

`GET /merchant/sites/:id` 使用 `db.execute(SELECT DISTINCT ON (channel_id) * FROM authenticity_reports ...)`。结果为 `channel_id`、`duration_ms`、`created_at` 等原始下划线字段，却通过 `reportView(reportMap.get(c.id) as never)` 交给读取 `channelId`、`durationMs`、`createdAt` 的函数。

`reportView` 调用 `r.createdAt.toISOString()`，因此所属渠道已有报告时会抛错，影响站点详情、入驻恢复和渠道详情。应改为 Drizzle 类型化查询，或将原始 SQL 行明确映射到驼峰字段后再序列化。已通知主代理转交后端负责人；随后只读复核确认，后端已改为 Drizzle 类型化查询并按 channelId 选择最新报告，移除了原始行强制转换。已真实 GET 种子站长所有 12 个站点详情，共返回 32 份报告；每份报告的 channelId、checks 和 createdAt 均符合预期。关联站点详情和渠道详情的 Web 渲染通过。

### 部分真实通过：连接配置变化使旧测试状态失效

`PATCH /merchant/channels/:id` 更新 baseUrl、API Key、protocol、primaryModel 时，没有重置 `lastTestOk`；提交审核仅检查是否存在 `lastTestOk === true` 的渠道。因此草稿渠道在旧配置测试成功后，修改为无效密钥或地址，仍可能沿用旧的通过状态提交。

已只读确认后端添加 `connectionChanged` 判断，在 API Key、baseUrl、protocol、primaryModel 变化后将 `lastTestOk`、`lastTestAt` 置为 null。已真实验证：上游不可达的测试返回结构化 `success:false / errorCode:network`，随后修改 API Key 将 `lastTestOk`、`lastTestAt` 清空为 null。成功测试 → 修改密钥 → 提交被拒绝 → 重新测试通过，仍待 8712 就绪。

### 真实通过：模型覆盖价保存保留模型历史

`PUT /merchant/channels/:id/models` 先删除该渠道全部 channel_models，再插入请求列表。新行没有继承 lastStatus、lastLatencyMs、lastTestedAt、lastError、trustScore、trustVerdict 等已有字段。仅修改覆盖价也会清空模型检测状态，并更换模型记录 ID。

已只读确认后端改为按 `(channelId, upstreamName)` upsert，仅删除请求中移除的模型，更新字段只包含映射与覆盖价。已真实验证：临时渠道两次修改覆盖价后模型 ID 保持不变；种子渠道 10 的 3 个已有模型原样保存后，ID、映射、覆盖价、lastStatus、lastLatencyMs、lastTestedAt、lastError、trustScore、trustVerdict 全部保持不变，覆盖非空历史字段。种子模型保存未改变任何值。

## 已完成的 Web 适配

| 差异 | 已完成处理 |
| --- | --- |
| 后端仅允许 draft/rejected 站点新增渠道 | 站点详情仅在这两种状态显示添加入口，其他状态显示说明 |
| 后端禁止删除已上线站点的渠道 | 已上线站点的渠道详情隐藏移除区块 |
| PATCH channel 虽接受 declaredModels，但更新逻辑忽略该字段 | 编辑渠道时移除声明模型 textarea，不再向 PATCH 发送该字段；模型统一使用下方 PUT 模型编辑器维护。新建渠道仍可声明模型 |
| authenticity body.models 最多 20 项 | 选择到 20 项后禁用未选项，发起前再次校验；检测中禁止修改选择 |
| PUT models 对空映射尝试自动匹配 | 空选项改为「自动识别 / 未映射」，明确说明自动识别行为；保存后重新载入模型编辑器 |

上述调整后已运行 `pnpm --filter @hub/web typecheck`，通过。

## 已确认一致的接口约定

- `POST /auth/login` 返回 `SessionUser` 并设置 `hub_session` httpOnly cookie；前端不读取或保存 JWT。
- merchant 路由只要求登录，普通用户可创建入驻草稿，与前端一致。
- 错误格式 `{ error: { code, message, details? } }` 与 `ApiRequestError` 一致。
- 创建站点返回 `MerchantSite`，包含 id；前端随后 GET 详情，因此不要求创建响应自带 channels。
- 创建渠道返回 `MerchantChannel`，但前端随后 GET 所属站点，不依赖新建响应内 models 列表。
- submit 返回 `{ ok: true }`，前端只判断成功，随后重新 GET 站点，兼容该返回。
- 手动检测返回 HTTP 202 + `ProbeTask`，请求封装接受所有 2xx，兼容该返回。
- discover 返回 `MerchantChannelModel[]`；任务轮询返回 `ProbeTask`；日志返回 `Paginated<ProbeRun>`，与前端一致。
- 浏览器同源代理保留 cookie；Server Component 直接请求 API 并透传 cookie。

## 已核对的请求覆盖

| 路径与方法 | 前端使用位置 |
| --- | --- |
| GET `/merchant/overview` | 总览、渠道所属站点定位 |
| GET/POST `/merchant/sites` | 我的站点、入驻第一步 |
| GET/PATCH/DELETE `/merchant/sites/:id` | 站点详情、编辑、删除 |
| POST `/merchant/sites/:id/channels` | 添加渠道 |
| PATCH/DELETE `/merchant/channels/:id` | 渠道配置、移除 |
| POST `/merchant/channels/:id/test` | 向导与渠道测试连接 |
| POST `/merchant/channels/:id/discover` | 获取模型 |
| PUT `/merchant/channels/:id/models` | 模型映射及覆盖价 |
| POST `/merchant/sites/:id/submit` | 入驻提交审核 |
| POST `/merchant/channels/:id/authenticity` | 手动模型检测 |
| GET `/merchant/tasks/:id` | 自动轮询至终态 |
| GET `/merchant/channels/:id/runs?page=&pageSize=` | 分页探测日志 |

## 已执行的真实 HTTP 验证

使用独立 HTTP cookie 登录种子站长，不与浏览器测试共用会话。未输出 session cookie 或明文 API Key。

| 项目 | 结果 |
| --- | --- |
| 登录、overview、sites、模型目录 | 通过 |
| 站点创建、读取、编辑、删除草稿 | 通过 |
| 渠道创建、编辑、删除；actualRatio 计算 | 通过 |
| 种子站点已有报告序列化 | 12 个站点、32 份报告通过 |
| 模型覆盖价编辑保留行 ID | 通过 |
| 种子模型原样保存保留非空探测与可信分历史 | 渠道 10 的 3 个模型通过 |
| 上游不可达错误处理；密钥修改清除失败测试状态 | 通过 |
| 无渠道、无成功测试时提交审核 | 均返回 400，符合前置校验 |
| 真实 Web 站长总览、列表、入驻向导、站点详情、站点编辑、渠道详情 | 6 个路由均 200，无 RSC 错误摘要 |
| 真实连接成功、模型发现、提交审核成功路径 | 外部依赖阻塞：8712 未监听 |
| 真实性检测任务到终态、报告刷新 | 外部依赖阻塞：8712 / 8713 未监听 |

结果文件：`merchant-real-crud-results.json`、`merchant-real-regression-results.json`。

所有临时草稿均已按正常接口删除。首次临时脚本给空 DELETE 错加 Content-Type 导致 Fastify 400，已修正脚本并重跑通过；前端 api 封装没有该问题。创建渠道响应不要求携带 models，回归脚本现与前端一致，随后 GET 站点详情获取模型列表。

## 待依赖就绪后继续

临时脚本 `/tmp/hub-merchant-real.mjs` 已拆分 `--crud-only` 与 `--success-only`，并通过语法检查。等待 8712 / 8713 健康后，仅执行成功分支：成功连接、连接配置修改使旧成功状态失效、重新连接、模型发现、提交前置条件、提交审核、任务轮询至终态及报告 DTO。

依赖未启动时记录为「外部依赖阻塞」，不误记为 API 缺陷。待审核记录不绕过状态规则删除，将保留 ID 供负责人处理。不自行启动或停止后端服务。
