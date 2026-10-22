# 2API Hub — AI 中转站聚合平台 产品与技术规格（v1）

> 本文档是所有开发者（前端 / 后端 / 检测引擎）的**唯一契约**。实现与本文档冲突时，以本文档为准；
> 确需修改契约，请在交付说明中明确指出，由编排者统一裁决，**不要私自改动其它人负责的目录**。

## 0. 产品定位

一个聚合所有 AI API 中转站（new-api / sub2api / one-api / 自研站）的导航与比价平台：

- **散户（买家）**：按 **模型** 或 **厂商** 浏览，比较各中转站渠道的 实际倍率 / 价格、可用率、延迟、模型真伪可信分，挑选合适渠道后跳转到上游站点购买。
- **站长（商家）**：入驻平台，登记站点与渠道（分组），提交检测用 API Key；平台对其进行 **模型检测**（真伪/一致性/降智）和 **稳定性探测**（定时可用性 + 延迟），审核通过后公开展示在榜单中。
- **管理员**：审核入驻、维护模型/厂商目录、查看探测日志、处理反馈、配置参数。

参考站：ai2api.vip（站点→分组两层结构、实际倍率、可用性时间窗、可信评分、建议分）、hvoyai.com（按模型 Top 榜、¥/百万 Token、API 鉴定工具）。

品牌名：**2API Hub**，中文副标题「AI 中转站聚合导航」。全站简体中文。

## 1. 核心概念与术语

| 术语 | 英文/字段 | 说明 |
| --- | --- | --- |
| 站点 | `site` | 一个中转站（如 xxapi.com），归属一个站长账号 |
| 渠道 / 分组 | `channel` | 站点下的一个分组/计费方案（如 "Claude 官转"、"GPT 逆向特价"），有独立 base_url、API Key、倍率 |
| 厂商 | `vendor` | 模型提供方：OpenAI / Anthropic / Google / DeepSeek / xAI / 智谱 / Moonshot / 阿里通义 / MiniMax / 字节 |
| 模型 | `model` | 平台标准模型目录中的一个模型（如 `claude-opus-5-5`），有官方美元单价 |
| 渠道模型 | `channel_model` | 某渠道声明/实际支持的模型，记录上游模型名、映射到目录中的模型、最近测试状态与可信分 |
| 分组倍率 | `group_ratio` | 站点后台显示的倍率（new-api 语义：官方价 × 倍率 = 扣除额度） |
| 充值倍率 | `recharge_ratio` | 每充值 ¥1 获得多少美元额度（例：¥1 = $1 额度 → 1；¥7 = $1 → 0.142857） |
| 实际倍率 | `actual_ratio` | `group_ratio / recharge_ratio`。**¥ 实际单价 = 官方 $ 单价 × 实际倍率** |
| 可用率 | `uptime` | 时间窗内可用性探测成功次数 / 总次数（无样本 → `null`，不等于 0%） |
| 可信分 | `trust_score` | 模型真伪检测得分 0–100，越高越可能是真模型（见 §5.3） |
| 推荐分 | `recommend_score` | 综合分 0–100（见 §5.5） |

价格展示统一为 **¥/百万 Token（输入 / 输出）**，由 `官方 $ 单价 × actual_ratio` 计算；渠道模型可由站长手填覆盖价（`price_override_*`）。

## 2. 技术栈与仓库结构

pnpm monorepo，Node 22，TypeScript strict，全部 ESM。包作用域 `@hub/*`。

```
2api-hub/
├── apps/
│   ├── web/            # @hub/web   Next.js (App Router) + Tailwind v4 —— 前端（公开站 + 站长后台 + 管理后台）  [Codex]
│   ├── api/            # @hub/api   Fastify 5 + zod + Drizzle —— REST API                                        [Kimi]
│   ├── worker/         # @hub/worker 探测调度器 + 统计聚合                                                       [GLM]
│   └── mock-upstream/  # @hub/mock-upstream 模拟中转站上游（OpenAI/Anthropic/Gemini 协议，可配置真/假/抖动） [GLM]
├── packages/
│   ├── db/             # @hub/db    Drizzle schema + migrations + seed（schema 由编排者定稿；migration/seed 由 Kimi 实现）
│   ├── shared/         # @hub/shared 常量、API 契约类型（编排者定稿，前后端共用）
│   └── probe/          # @hub/probe  检测引擎库（协议适配、可用性探测、真伪检测、SSRF 防护）                   [GLM]
├── docs/SPEC.md
├── docker-compose.yml  # postgres:16 → 127.0.0.1:54329 (user/pass/db = hub)
└── .env / .env.example
```

端口：web **3210**、api **8711**、mock-upstream **8712**、worker 健康检查 **8713**、postgres **54329**。

**跨包依赖规则**：
- `@hub/api` 依赖 `@hub/db`、`@hub/shared`、`@hub/probe`（同步连接测试、公开鉴定工具直接调用 probe 库）。
- `@hub/worker` 依赖 `@hub/db`、`@hub/shared`、`@hub/probe`。
- `@hub/web` 只依赖 `@hub/shared`（类型与常量），**不得**直接访问数据库。
- 包内用 `"main"/"exports"` 直接指向 `src/index.ts`（workspace 源码直连，dev 用 `tsx`，无需预构建）。Next.js 需在 `transpilePackages` 中加入 `@hub/shared`。

**web ↔ api 通讯**：浏览器统一请求同源 `/api/v1/*`，由 Next.js `rewrites` 代理到 `http://127.0.0.1:8711/api/v1/*`（避免 CORS 与跨域 cookie）。Server Component 直接用 `API_INTERNAL_URL` 请求，并透传 cookie。

## 3. 角色与权限

| 角色 | `users.role` | 能力 |
| --- | --- | --- |
| 游客 | — | 浏览所有公开页面、榜单、站点档案、使用 API 鉴定工具（IP 限频） |
| 用户 | `user` | + 收藏渠道、发表站点评价、提交反馈、**发起站长入驻**（创建站点草稿即可） |
| 站长 | `merchant` | + 管理自己的站点和渠道、查看自己渠道的全部探测日志和检测报告。首个站点审核通过时自动 `user → merchant` |
| 管理员 | `admin` | 全部权限 |

认证：邮箱 + 密码（bcryptjs），会话为 `jose` 签发的 JWT，存放于 httpOnly cookie `hub_session`（SameSite=Lax，7 天）。

## 4. 业务流程

### 4.1 站长入驻（Onboarding）

1. 登录用户进入 `/merchant/onboarding`，填写站点基础信息（名称、官网、邀请链接、站点类型、充值倍率、联系方式、简介、Logo）→ 创建 `site`（`status=draft`）。
2. 添加 ≥1 个渠道：名称、厂商、协议、`base_url`、检测用 `API Key`、分组倍率、主测模型、备用模型、声明模型列表。
3. 对每个渠道点击「测试连接」→ API 同步调用 `@hub/probe` 做一次可用性探测（≤30s），结果写入 `probe_runs`（trigger=`merchant`）并返回；可点击「获取模型列表」→ 调用上游 `/v1/models` 回填 `channel_models`。
4. 至少一个渠道连接测试通过后，可「提交审核」→ `site.status=pending`，同时 API 为该站点所有渠道创建 `probe_tasks(kind=authenticity, trigger=onboarding)`，worker 执行完整模型检测。
5. 管理员在 `/admin/reviews` 查看站点信息、渠道连接结果、检测报告 → 通过（`approved`，站点公开，渠道开始定时探测并进入榜单）或驳回（`rejected` + 原因，站长修改后可再次提交）。
6. 已上线站点修改连接相关字段（base_url / API Key / protocol / 主测模型）**不需要**重新审核，但会立即排队一次真伪检测（`kind=authenticity`，同渠道已有排队任务时复用）；修改倍率（分组倍率 / 充值倍率）只影响价格计算，**不触发**任何检测任务。管理员可随时 `suspended`。

### 4.2 稳定性探测（定时）

- worker 每 5 秒扫描 `channels` 中 `probe_enabled = true AND status = 'active' AND next_probe_at <= now()` 且所属站点 `status='approved'` 的渠道（`FOR UPDATE SKIP LOCKED`），执行可用性探测（主测模型，失败时不换模型重试，备用模型单独记录），写 `probe_runs`，更新 `channel_models` 最近状态，`next_probe_at = now() + probe_interval_sec`（默认 600s，±10% 抖动）。
- 全局并发上限 `settings.probe.concurrency`（默认 8），单站点并发上限 2。
- 连续失败 ≥ 3 次：探测间隔临时降为 300s 以快速感知恢复；连续失败 ≥ 20 次：渠道 `status=invalid` 并停止定时探测，通知站长（站内 `notifications`）。

### 4.3 模型检测（真伪/一致性）

- 触发：入驻提交审核、管理员手动、站长手动（每渠道每天 ≤ 3 次）、定时（每渠道每 24h 对主测模型一次）。
- 通过 `probe_tasks` 表排队，worker 拉取执行，结果写 `authenticity_reports` 并回写 `channel_models.trust_score / trust_verdict` 与 `channel_stats.trust_score`。

### 4.4 公开 API 鉴定工具（`/verify`）

任何人输入 `base_url + api_key + model + protocol` → `POST /api/v1/verify` → API 直接调用 `@hub/probe` 执行"快速真伪检测"（≤60s），返回报告。**API Key 不落库、不写日志**；同 IP 每小时 ≤ 10 次；结果只存 `verify_requests`（host、模型、得分，不含 key）。

## 5. 检测引擎规格（@hub/probe）

### 5.0 @hub/probe 对外 API（契约，api 与 worker 都按此调用）

```ts
import type { ChannelProtocol, ProbeResult, AuthenticityReport, ModelTier } from '@hub/shared';

export interface ProbeTarget { baseUrl: string; apiKey: string; protocol: ChannelProtocol; model: string }
export interface ProbeOptions {
  timeoutMs?: number;          // 默认 30000
  allowPrivate?: boolean;      // 默认读取 process.env.ALLOW_PRIVATE_PROBE === 'true'
  signal?: AbortSignal;
}
export interface CatalogHint {   // 目录中对应模型的信息（未识别时传 null）
  slug: string; vendorSlug: string; tier: ModelTier;
  knowledgeCutoff: string | null; expectedTps: number | null;
}

/** 可用性探测（SPEC §5.2），永不抛异常，错误体现在 ProbeResult.errorCode */
export function probeAvailability(target: ProbeTarget, opts?: ProbeOptions): Promise<ProbeResult>;
/** 拉取上游模型列表，永不抛异常 */
export function listUpstreamModels(target: Omit<ProbeTarget, 'model'>, opts?: ProbeOptions):
  Promise<{ ok: boolean; models: string[]; errorCode: string | null; errorMessage: string | null }>;
/** 真伪检测（SPEC §5.3），永不抛异常；返回值由调用方补齐 id/channelId/trigger/createdAt */
export function probeAuthenticity(target: ProbeTarget, hint: CatalogHint | null, opts?: ProbeOptions & { quick?: boolean }):
  Promise<Omit<AuthenticityReport, 'id' | 'channelId' | 'trigger' | 'createdAt'>>;
/** 把上游模型名映射到目录模型（按 slug / aliases，忽略大小写、日期后缀、厂商前缀如 "anthropic/"） */
export function matchCatalogModel(upstreamName: string, catalog: { id: number; slug: string; aliases: string[] }[]): number | null;
/** SSRF 校验，不安全时抛出 ProbeError(code='ssrf_blocked') */
export function assertSafeUrl(url: string, allowPrivate?: boolean): Promise<void>;
```

`quick: true`（公开鉴定工具）时跳过耗时较长的 capability 检查，总时长控制在 60s 内。

### 5.1 协议适配

| `protocol` | 请求 | 说明 |
| --- | --- | --- |
| `openai_chat` | `POST {base}/v1/chat/completions`（stream=true） | 默认；`base_url` 若已以 `/v1` 结尾则不重复拼接 |
| `openai_responses` | `POST {base}/v1/responses`（stream=true） | |
| `anthropic` | `POST {base}/v1/messages`（stream=true，header `x-api-key` + `anthropic-version: 2023-06-01`，同时带 `Authorization: Bearer`） | |
| `gemini` | `POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse`（header `x-goog-api-key`） | |

模型列表：OpenAI 兼容 `GET {base}/v1/models`；anthropic 协议先试 `GET /v1/models`；gemini 用 `GET /v1beta/models`。

### 5.2 可用性探测 `probeAvailability(target, opts)`

- 发送极小请求（`"Reply with exactly: pong"`，max_tokens 16），流式读取；记录 `ttft_ms`（首个内容 token）、`latency_ms`（完整结束）、`output_tokens`、`http_status`、`tokens_per_sec`。
- 成功判定：HTTP 2xx 且收到非空文本内容。
- 错误归类 `error_code`：`timeout` / `network` / `dns` / `tls` / `http_401` / `http_403` / `http_404` / `http_429` / `http_5xx` / `empty_response` / `invalid_response` / `ssrf_blocked`。
- 超时：总超时 30s，TTFT 超时 20s。

### 5.3 真伪检测 `probeAuthenticity(target, opts)` → `AuthenticityReport`

由若干独立检查组成，每项给出 `passed: boolean | null`（null=不适用/未执行）、`weight`、`detail`。得分 = Σ(通过项权重) / Σ(已执行项权重) × 100。判定：`≥80 genuine`、`50–79 suspect`、`<50 fake`；已执行项权重和 < 30 时为 `unknown`。

至少实现以下检查（id 固定，前端按 id 显示中文名）：

| id | 中文名 | 权重 | 方法 |
| --- | --- | --- | --- |
| `connectivity` | 连通性 | 10 | 能正常返回 |
| `model_echo` | 模型名回显 | 10 | 响应中的 `model` 字段与请求模型一致（或为其已知别名/带日期后缀版本） |
| `response_shape` | 协议特征 | 15 | Anthropic：`id` 以 `msg_` 开头、`type=message`、usage 含 `cache_creation_input_tokens` 等；OpenAI：`chatcmpl-`/`resp_` 前缀、`system_fingerprint`、`usage` 结构 |
| `token_count` | Token 计数一致性 | 20 | 发送固定基准文本，比较 `usage.input_tokens/prompt_tokens` 与该厂商分词器的期望区间（在 shared 常量中按厂商配置期望值，±8% 容差）——换皮模型最强信号 |
| `knowledge` | 知识与身份 | 10 | 询问身份与知识截止时间，与目录中 `models.knowledge_cutoff`、厂商比对（弱信号） |
| `reasoning` | 推理能力（降智检测） | 20 | 3 道带标准答案的确定性推理/计算题，按正确率计分；高端模型（`tier=flagship`）要求全对 |
| `capability` | 能力特征 | 10 | 按厂商：Anthropic 测 extended thinking（`thinking` 块 + signature）；OpenAI 测 tool calling 格式；Gemini 测 `functionCall` |
| `speed` | 输出速度 | 5 | tokens/s 落在该模型合理区间（目录 `models.expected_tps`，宽松） |

`AuthenticityReport` 结构见 `@hub/shared` 的 `AuthenticityReport` 类型。

### 5.4 SSRF 防护

- 只允许 `http/https`；解析 DNS 后拒绝私网/回环/链路本地/保留地址（IPv4 + IPv6）。
- 环境变量 `ALLOW_PRIVATE_PROBE=true` 时放行（仅开发环境，mock-upstream 在 127.0.0.1）。
- 不跟随跳转到私网；响应体上限 2MB。

### 5.5 统计聚合（worker 每 60s）

对每个渠道从 `probe_runs(kind='availability')` 计算并 upsert `channel_stats`：

- `uptime_1h / uptime_24h / uptime_7d`：成功率（0–1，无样本为 null）；`samples_24h`
- `latency_p50_24h / latency_p95_24h / ttft_avg_24h`（仅成功样本，ms）
- `sparkline`：最近 60 次探测 `[{t, ok, ms}]`（t 为 ISO 时间）
- `consecutive_failures`、`last_success_at`、`last_failure_at`
- `trust_score`：主测模型最近一次真伪检测得分（无则 null）
- `recommend_score`（0–100，样本 < 6 时为 null）：
  ```
  uptime_part  = uptime_24h ^ 8 * 100                               权重 0.45   （非线性：99%→92、95%→66、90%→43、70%→6）
  latency_part = clamp(100 - (latency_p50_24h - 1500) / 150, 0, 100) 权重 0.20   （≤1.5s 满分，16.5s 为 0）
  trust_part   = trust_score ?? 60                                   权重 0.25
  stable_part  = 100 - min(consecutive_failures * 20, 100)            权重 0.10
  若 trust_score < 50（判为假模型），推荐分封顶 40
  ```
  权重存放于 `settings` 表 `scoring.weights`，可在管理后台调整。价格**不计入**推荐分（价格单独排序）。

`site_stats` 同步聚合：渠道数、模型数、上线渠道平均 24h 可用率、最高推荐分、最低实际倍率。

数据保留：`probe_runs` 保留 30 天（worker 每天清理）。

## 6. 数据模型

见 `packages/db/src/schema.ts`（编排者定稿，Drizzle ORM，PostgreSQL 16）。主要表：

`users`、`vendors`、`models`、`sites`、`channels`、`channel_models`、`probe_runs`、`probe_tasks`、`authenticity_reports`、`channel_stats`、`site_stats`、`reviews`、`favorites`、`feedback`、`notifications`、`announcements`、`settings`、`audit_logs`、`verify_requests`。

API Key 使用 AES-256-GCM 加密存储（`APP_ENCRYPTION_KEY`，格式 `v1:<iv b64>:<tag b64>:<cipher b64>`），`@hub/db` 已提供 `encryptSecret / decryptSecret / maskSecret` 与 `createDb()`（drizzle + postgres.js），api 与 worker 共用；任何接口**不得返回明文 Key**，只返回掩码（`sk-****abcd`）。

## 7. REST API 契约（`/api/v1`）

通用约定：
- 成功：直接返回 JSON 资源；列表统一 `{ items, total, page, pageSize }`。
- 失败：HTTP 4xx/5xx + `{ error: { code: string, message: string, details?: unknown } }`，`message` 为中文。
- 分页参数 `page`（从 1 开始）、`pageSize`（默认 20，最大 100）。
- 时间均为 ISO 8601 字符串；金额/倍率为 number。
- 所有类型定义见 `packages/shared/src/contract.ts`，**前后端必须使用这些类型**。

### 7.1 公开接口（无需登录）

| 方法 | 路径 | 说明 | 返回 |
| --- | --- | --- | --- |
| GET | `/meta` | 全站概览：厂商列表、精选模型、统计数（站点数/渠道数/模型数/24h 探测次数/最近探测时间） | `MetaResponse` |
| GET | `/vendors` | 厂商列表（含模型数、渠道数） | `VendorSummary[]` |
| GET | `/vendors/:slug` | 厂商详情 + 旗下模型 | `VendorDetail` |
| GET | `/models` | 模型目录，query：`vendor`、`q`、`modality`、`featured` | `ModelSummary[]` |
| GET | `/models/:slug` | 模型详情（含提供该模型的渠道数、最低价、最佳可用率） | `ModelDetail` |
| GET | `/channels` | **渠道榜单（核心）**，query 见下 | `Paginated<ChannelListItem>` |
| GET | `/channels/:id` | 渠道详情（统计、模型列表、最近检测报告、sparkline） | `ChannelDetail` |
| GET | `/channels/:id/history` | 探测时间序列，query：`window=1h|24h|7d|30d` | `ChannelHistory` |
| GET | `/channels/:id/reports` | 真伪检测报告列表（最近 20 条） | `AuthenticityReport[]` |
| GET | `/channels/:id/runs` | 探测记录（分页，query `kind`、`success`；errorMessage 按 errorCode 映射为中文分类，不返回原始错误） | `Paginated<ProbeRun>` |
| GET | `/sites` | 站点目录，query：`q`、`type`、`vendor`、`sort=score|uptime|channels|newest`、分页 | `Paginated<SiteListItem>` |
| GET | `/sites/:slug` | 站点档案（基本信息、统计、渠道列表、评价摘要） | `SiteDetail` |
| GET | `/sites/:slug/reviews` | 评价列表（分页） | `Paginated<Review>` |
| GET | `/rankings/overview` | 首页用：每个精选模型 Top 3 渠道 | `RankingOverview` |
| GET | `/announcements` | 启用中的公告 | `Announcement[]` |
| POST | `/verify` | API 鉴定（IP 限频，见 §4.4） | `AuthenticityReport` |
| POST | `/feedback` | 收录推荐/建议/投诉（游客可提交，IP 限频） | `{ id }` |
| GET | `/go/:channelId` | 记录点击并 302 跳转到站点邀请链接（或官网） | 302 |

`GET /channels` query 参数：
- `model`：模型 slug（目录模型）。指定后，价格列为该模型价格，排序 `price` 按该模型输入价。
- `vendor`：厂商 slug（渠道 `vendor` 或其声明模型所属厂商）。
- `q`：搜索站点名/渠道名/描述（空格分隔多关键词 AND）。
- `siteId`、`maxRatio`（实际倍率上限）、`minUptime`（0–1）、`minTrust`（0–100）、`stableOnly=true`（24h 可用率 ≥ 0.95 且样本 ≥ 12）、`protocol`。
- `sort=recommend|price|ratio|uptime|latency|trust|updated`（默认 `recommend`），`order=asc|desc`（各 sort 有合理默认：price/ratio/latency 升序，其余降序）；null 值永远排在最后。
- `ids=1,2,3`：按 id 批量获取（用于对比）。

### 7.2 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/register` | `{ email, password, nickname? }` → `SessionUser`，并设置 cookie |
| POST | `/auth/login` | `{ email, password }` → `SessionUser` |
| POST | `/auth/logout` | 清 cookie |
| GET | `/auth/me` | `SessionUser`；未登录 401 |

### 7.3 用户（需登录）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/me/favorites` | 收藏的渠道（分页）`Paginated<ChannelListItem>` |
| POST | `/me/favorites/:channelId` | 收藏 |
| DELETE | `/me/favorites/:channelId` | 取消收藏 |
| POST | `/sites/:slug/reviews` | `{ rating 1-5, content }` 每用户每站点 1 条（再次提交为更新） |
| GET | `/me/reviews` | 我的评价（分页）`Paginated<MyReview>` |
| DELETE | `/me/reviews/:id` | 删除自己的评价 |
| GET | `/me/notifications` | 站内通知（分页，query `unread=true` 仅未读）`NotificationList` |
| POST | `/me/notifications/read` | `{ ids?: number[] }` 全部或部分已读 |

### 7.4 站长后台（需登录；只能操作自己的站点）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/merchant/overview` | 站长总览：站点数、渠道数、各渠道 24h 可用率、最近告警 | 
| GET | `/merchant/sites` | 我的站点 `MerchantSite[]` |
| POST | `/merchant/sites` | 创建站点（draft） `SiteInput` |
| GET | `/merchant/sites/:id` | 站点详情（含渠道 `MerchantChannel[]`、审核状态/驳回原因） |
| PATCH | `/merchant/sites/:id` | 更新站点 |
| POST | `/merchant/sites/:id/submit` | 提交审核（需 ≥1 渠道最近连接测试成功） |
| DELETE | `/merchant/sites/:id` | 删除草稿/被驳回站点 |
| POST | `/merchant/sites/:id/channels` | 新建渠道 `ChannelInput` |
| PATCH | `/merchant/channels/:id` | 更新渠道（apiKey 留空表示不修改） |
| DELETE | `/merchant/channels/:id` | 删除渠道 |
| POST | `/merchant/channels/:id/test` | 同步连接测试（可选 body `{ model? }`）→ `ProbeResult` |
| POST | `/merchant/channels/:id/discover` | 拉取上游模型列表并回填 → `MerchantChannelModel[]` |
| PUT | `/merchant/channels/:id/models` | 批量设置渠道模型（上游名、映射目录模型、覆盖价） |
| POST | `/merchant/channels/:id/authenticity` | 排队真伪检测 `{ models?: string[] }` → `ProbeTask` |
| GET | `/merchant/tasks/:id` | 任务状态 `ProbeTask` |
| GET | `/merchant/channels/:id/runs` | 探测日志（分页，含失败原因） `Paginated<ProbeRun>` |

### 7.5 管理后台（admin）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/overview` | 待审核数、站点/渠道/用户数、24h 探测量与失败率、队列积压 |
| GET | `/admin/sites` | 全部站点，query `status`、`q`、分页 |
| GET | `/admin/sites/:id` | 站点全量详情（含渠道、最近检测） |
| POST | `/admin/sites/:id/review` | `{ action: 'approve'|'reject'|'suspend'|'restore', reason? }` |
| PATCH | `/admin/sites/:id` | 修改任意字段（含 `isFeatured`、`isVerified`、`sortWeight`） |
| GET | `/admin/channels` | 全部渠道（分页），query `q`（站点名/渠道名/baseUrl host）、`status`、`siteId`、`siteStatus`、`vendor`、`protocol`、`sort=recent|uptime|trust|failures` | `Paginated<AdminChannel>` |
| POST | `/admin/channels/:id/probe` | 立即触发 `{ kind: 'availability'|'authenticity'|'discovery' }` → `ProbeTask` |
| PATCH | `/admin/channels/:id` | 修改渠道（含 `probeEnabled`、`probeIntervalSec`、`status`） |
| GET/POST | `/admin/vendors` | 厂商列表 / 新建 |
| PATCH/DELETE | `/admin/vendors/:id` | |
| GET/POST | `/admin/models` | 模型目录 / 新建 |
| PATCH/DELETE | `/admin/models/:id` | |
| GET | `/admin/users` | 用户列表，query `role`、`q` |
| PATCH | `/admin/users/:id` | `{ role?, status? }` |
| GET | `/admin/probe-runs` | 全局探测日志，query `channelId`、`success`、`kind` |
| GET | `/admin/tasks` | 检测任务队列，query `status` |
| GET | `/admin/feedback` / PATCH `/admin/feedback/:id` | 反馈处理 `{ status }` |
| GET | `/admin/reviews` / PATCH `/admin/reviews/:id` | 评价管理 `{ status: visible|hidden }` |
| GET/POST/PATCH/DELETE | `/admin/announcements[/:id]` | 公告 |
| GET/PUT | `/admin/settings` | 全局设置（`SettingsMap`） |
| GET | `/admin/audit-logs` | 审计日志 |

### 7.6 健康检查

`GET /healthz` → `{ ok: true }`（api），worker 在 8713 端口提供同样的 `/healthz` 与 `/metrics`（JSON：队列积压、最近一轮耗时、并发）。

## 8. 前端信息架构（@hub/web）

### 8.1 公开站

| 路由 | 页面 | 要点 |
| --- | --- | --- |
| `/` | 首页 | 品牌 Hero（一句话价值主张 + 搜索模型/站点 + 两个 CTA：开始比价 / 站长入驻）；厂商跑马灯；**按模型 Top3 榜**（hvoy 风格，tab 切换精选模型）；"如何检测"三步说明（定时探测 → 真伪检测 → 综合评分）；最新探测动态；入驻 CTA |
| `/rankings` | **渠道榜单**（核心页面） | 左/上方筛选：厂商 tab、模型搜索选择、排序预设（综合推荐 / 价格优先 / 稳定优先 / 响应优先 / 可信优先）、实际倍率上限、只看稳定、协议；表格列：排名、站点+渠道名、厂商徽标、实际倍率、所选模型 ¥/M 输入/输出价、24h 可用率 + 60 格状态条、P50 延迟 / TTFT、可信分徽章、推荐分、最近检测时间、操作（详情 / 去站点 / 收藏 / 加入对比）；移动端变为卡片；URL query 同步筛选状态，可分享 |
| `/models` | 模型广场 | 按厂商分组的模型卡片：官方价、提供渠道数、最低 ¥ 价、最佳可用率 |
| `/models/[slug]` | 模型详情 | 模型信息 + 该模型的渠道榜单（复用榜单组件，锁定 model） |
| `/vendors` & `/vendors/[slug]` | 厂商页 | 厂商介绍 + 模型列表 + 该厂商渠道榜单 |
| `/sites` | 站点目录 | 站点卡片/列表：Logo、名称、类型、渠道数、平均可用率、最高推荐分、认证标识 |
| `/sites/[slug]` | 站点档案 | 基本信息、联系方式、渠道列表（含状态条）、评价与评分 |
| `/channels/[id]` | 渠道详情 | 统计卡、可用率时间线（1h/24h/7d/30d 切换）、延迟走势图、模型列表（通过/失败/未测）、真伪检测报告（各检查项明细） |
| `/compare?ids=` | 渠道对比 | 2–4 个渠道并排对比 |
| `/verify` | API 鉴定 | 表单 + 逐项检查结果可视化 |
| `/join` | 站长入驻落地页 | 入驻价值、流程、检测标准说明、CTA |
| `/guide` | 使用指南 | 指标说明（实际倍率、可用率、可信分、推荐分公式）、FAQ |
| `/login` `/register` | 登录注册 | |
| `/me` | 个人中心 | 收藏、我的评价、通知 |

### 8.2 站长后台 `/merchant`（侧边栏布局）

总览（渠道健康卡片、告警）/ 我的站点 / 入驻向导（步骤：站点信息 → 添加渠道 → 连接测试 & 获取模型 → 提交审核）/ 站点编辑 / 渠道详情（探测日志、检测报告、手动发起检测）。

### 8.3 管理后台 `/admin`（侧边栏布局）

总览 / 入驻审核队列 / 站点管理 / 渠道与探测日志 / 任务队列 / 模型目录 / 厂商 / 用户 / 反馈 / 评价 / 公告 / 系统设置（探测间隔、并发、评分权重）/ 审计日志。

## 9. 种子数据（@hub/db seed）

- 管理员账号（`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`）、一个演示站长账号 `merchant@2api.hub / merchant123456`、一个普通用户 `user@2api.hub / user123456`。
- 8 个厂商、19 个当前主流模型（见 `@hub/shared` 的 `SEED_VENDORS` / `SEED_MODELS`）。
- 12 个演示站点（已审核）+ 2 个待审核站点，每站 1–4 个渠道；渠道 `base_url` 指向 mock-upstream（`http://127.0.0.1:8712/<scenario>`，scenario 见 §10），使本地 worker 能真实探测。
- 为演示渠道生成过去 7 天的合成 `probe_runs`（每 10 分钟一条，按 scenario 设定成功率/延迟分布）、`authenticity_reports`（并回写 `channel_models` 的可信分）。统计聚合由 worker 负责：**worker 启动时立即执行一次全量聚合**，因此 seed 后启动 worker 即可让首页和榜单出现数据。

## 10. Mock 上游（@hub/mock-upstream）

单进程 HTTP 服务（端口 8712），路径前缀为 scenario：`http://127.0.0.1:8712/<scenario>/v1/...`。实现 OpenAI chat/responses、Anthropic messages、Gemini 的流式与非流式最小子集 + `/v1/models`。scenario：

| scenario | 行为 |
| --- | --- |
| `genuine` | 正确模型名回显、正确协议特征、按厂商分词器近似计数 usage、推理题答对、thinking 块带 signature |
| `fast` | 同 genuine，延迟极低 |
| `slow` | 同 genuine，TTFT 6–12s |
| `flaky` | 30% 概率返回 502/超时 |
| `ratelimited` | 50% 概率 429 |
| `downgraded` | 回显正确模型名，但 usage 计数按 OpenAI 分词器、推理题答错一半（模拟降智/换皮） |
| `fake` | 回显模型名被改写（如 claude 请求回显 `gpt-4o-mini`），协议特征缺失，推理题答错 |
| `dead` | 永远 503 |

任意 API Key 均接受（`invalid-key` 返回 401）。

## 11. 质量要求

- TypeScript strict 无 any 滥用；`pnpm -r typecheck` 通过。
- api：每个路由 zod 校验入参；权限中间件；关键流程有 vitest 测试（入驻→提交→审核、权限越权、Key 不泄露）。
- probe：单元测试覆盖协议解析、评分计算、SSRF 判定；对 mock-upstream 的集成测试（genuine → genuine 判定、fake → fake 判定）。
- web：Lighthouse 可访问性合理；所有页面支持移动端；暗色为默认主题并支持亮色。
- 不提交 `.env`；不在日志打印 API Key。

## 12. 团队协作规则（所有 agent 必读）

1. **目录所有权**（只改自己负责的目录）：
   - Codex（前端）：`apps/web/**`
   - Kimi（后端）：`apps/api/**`、`packages/db/**`（`schema.ts` / `client.ts` / `crypto.ts` 除外，见第 2 条）
   - GLM-A（检测引擎）：`packages/probe/**`、`apps/mock-upstream/**`
   - GLM-B（Worker）：`apps/worker/**`
2. **契约文件**：`docs/SPEC.md`、`packages/shared/**`、`packages/db/src/schema.ts`、`client.ts`、`crypto.ts` 由编排者维护。确有必要时**只允许做向后兼容的增量修改**（新增可选字段/新类型/新索引），并在 `docs/CONTRACT-CHANGES.md` 追加一条记录（谁、改了什么、为什么）。禁止删除或重命名已有字段。
3. **不要执行 git commit / reset / checkout / stash**，由编排者统一提交。
4. 加依赖用 `pnpm --filter <包名> add <dep>`；遇到 lockfile 冲突稍后重试，不要删除 `pnpm-lock.yaml` 或根 `node_modules`。
5. 只启动/停止**自己**的进程和端口；不要 kill 其它端口上的进程；不要 `docker compose down` 或删除数据卷。数据库可以执行 migrate/seed（seed 必须幂等或先清空业务表）。
6. 完成时在 `docs/handoff/<角色>.md` 写交付说明：完成了什么、如何运行/验证、已知问题、对其他角色的依赖或请求。
