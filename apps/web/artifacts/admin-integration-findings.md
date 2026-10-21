# 管理后台真实 API 联调记录

## 当前状态

2026-10-22：管理路由已落盘，已完整静态对齐。8711 已就绪，真实 HTTP 检查目前 26 项通过、2 项失败（下面两项编辑字段静默丢失已实际复现）；8712 尚未监听，完整入驻审核/探测链继续等待本地上游。未启动或停止 API、worker 或 Web 服务，未修改后端。

已核对认证实现：登录返回 `SessionUser`，会话由 `hub_session` HttpOnly Cookie 保存；前端服务端透传 Cookie，客户端使用同源 `/api/v1`。管理员守卫从真实 `/auth/me` 读取当前角色，无权限页面不会读取管理资源。

## 管理请求清单

| 前端页面 / 操作 | API 请求 | 共享契约 |
| --- | --- | --- |
| 总览 | `GET /admin/overview` | `AdminOverview` |
| 入驻审核队列 | `GET /admin/sites?status=pending` | `Paginated<AdminSite>` |
| 站点管理 | `GET /admin/sites?q=&status=&page=&pageSize=` | `Paginated<AdminSite>` |
| 站点审阅 | `GET /admin/sites/:id` | `AdminSiteDetail` |
| 审核 / 下架 / 恢复 | `POST /admin/sites/:id/review` | `SiteReviewAction` |
| 站点资料和展示配置 | `PATCH /admin/sites/:id` | `SiteInput` + 管理展示字段 |
| 渠道管理 | 从管理站点详情汇总渠道，`PATCH /admin/channels/:id` | `MerchantChannel` / `ChannelInput` |
| 手动探测 | `POST /admin/channels/:id/probe` | `{ kind }` → `ProbeTask` |
| 探测日志 | `GET /admin/probe-runs?channelId=&success=&kind=` | `Paginated<ProbeRun>` |
| 检测任务 | `GET /admin/tasks?status=` | `Paginated<ProbeTask>` |
| 模型目录 | `GET/POST /admin/models`、`PATCH/DELETE /admin/models/:id` | `AdminModel` / `ModelInput` |
| 厂商目录 | `GET/POST /admin/vendors`、`PATCH/DELETE /admin/vendors/:id` | `VendorSummary` / `VendorInput` |
| 用户管理 | `GET /admin/users?q=&role=`、`PATCH /admin/users/:id` | `Paginated<AdminUser>` / `{ role?, status? }` |
| 用户反馈 | `GET /admin/feedback`、`PATCH /admin/feedback/:id` | `Paginated<FeedbackItem>` / `{ status }` |
| 用户评价 | `GET /admin/reviews`、`PATCH /admin/reviews/:id` | `Paginated<AdminReview>` / `{ status }` |
| 公告管理 | `GET/POST /admin/announcements`、`PATCH/DELETE /admin/announcements/:id` | `Announcement` |
| 系统设置 | `GET/PUT /admin/settings` | `SettingsMap` |
| 审计日志 | `GET /admin/audit-logs` | `Paginated<AuditLog>` |

目录和公告列表兼容数组或统一分页对象；其余分页资源按共享契约读取 `items/total/page/pageSize`。管理页面 `/admin/reviews` 是入驻审核，`/admin/ratings` 是用户评价；两者分别请求 `/admin/sites?status=pending` 与 `/admin/reviews`。

## 独立测试数据计划

1. 使用种子管理员登录，先验证所有管理 GET、普通用户 403、游客 401；不修改种子站点、模型、厂商、用户和公告。
2. 为本轮创建唯一前缀 `admin-integration-<时间戳>` 的普通测试账号、站点、渠道、厂商、模型和停用公告；检测渠道仅指向本地 mock-upstream，不使用付费上游密钥。
3. 验证目录 CRUD；测试账号角色切换、封禁和恢复；测试反馈处理、测试评价隐藏与恢复；审核仅使用本轮测试站点，覆盖无理由驳回校验、驳回、重新提交、通过、下架和恢复。
4. 在本轮测试渠道触发管理探测，检查任务与日志；查询目标为本轮测试资源的审计记录，检查响应不含明文密钥。
5. 保存评分权重后再读取确认，并在 `finally` 中恢复原权重；恢复时读取最新设置，只覆盖本轮修改的权重，避免覆盖其它并发变动。
6. 删除可删除的测试目录、公告、评价和渠道，草稿/驳回站点按契约删除。若已审核站点无法通过现有契约删除，将其下架并在报告明确记录保留 ID。没有删除接口的账号、反馈和审计记录标注为本轮测试数据，反馈标为已处理。

## 实际验证

静态对齐后的前端修改已通过 `pnpm --filter @hub/web typecheck`。未重复 mock 测试、未运行全站 build。

真实结果见同目录 `admin-integration-results.json`：种子管理员登录与会话、游客 401/普通用户 403、全部管理 GET、站点完整结构与密钥掩码均通过。独立厂商 #9、模型 #20、停用公告 #3 的创建/编辑/删除通过；独立用户角色、封禁、恢复和实时会话通过；测试反馈 #3 标记已读与已处理通过；评分权重保存/回读、恢复原值以及对应审计记录均通过。

测试目录和公告已清理。仅保留无删除接口的独立普通账号 `707c99b7-7881-42ad-9015-4b21b86a810c`（`admin-integration-1792602966@integration.example`）、已处理反馈 #3 和审计记录。评分权重恢复为可用率 0.45、延迟 0.20、可信度 0.25、稳定性 0.10；未修改其它设置。

另建独立审核测试草稿站点 #20、渠道 #40，实际复现两项管理 PATCH 丢字段问题后，通过该测试资源所有者的站长接口恢复原配置。站点仍为草稿、渠道关闭定时探测，不公开；保留用于上游就绪后的审核链检查，结束后清理或明确记录。

管理手动探测返回 HTTP 202，已为渠道 #40 创建 availability 任务 #1，任务队列可回读 queued 状态；执行终态与探测日志尚待 worker 和本地上游就绪后验证。

### 已确认并上报的后端差异

1. **渠道编辑静默丢字段，已运行复现。** `apps/api/src/routes/admin.ts:294` 的 PATCH schema 不包含 `baseUrl/apiKey/protocol/primaryModel/backupModel/billingType`。对本轮渠道 #40 提交这些合法字段后返回 `{ ok: true }`，随后 GET 站点详情确认所有上述字段均保持旧值；倍率变更亦未创建检测任务，与 SPEC §4.1.6 不符。前端尚保留这些编辑能力，等待后端补齐。
2. **站点编辑静默丢字段，已运行复现。** `admin.ts:240` 的 PATCH schema 不包含 `slug/contact`。对本轮站点 #20 提交后返回 `{ ok: true }`，随后 GET 确认两类字段均未保存；`rechargeRatio` 修改亦未为已上线渠道排队重新检测。
3. **评分允许无效全零权重。** `admin.ts:750` 的权重 schema 仅限制单值 0–1，允许总和为 0；共享评分函数按权重总和作除数。前端已校验总和大于 0，后端仍需同样约束。
4. **厂商管理元数据读取不足。** `GET /admin/vendors` 返回 `VendorSummary[]`，不包含 `website/description/sortOrder`，不能回填完整厂商编辑资料。前端已做保留处理：未读到的字段留空时不随 PATCH 清空。完整回显仍依赖后端提供管理详情或增量字段。

### 前端已修正

- 模型目录保留真实 API 分页元数据，显示上一页/下一页，增加厂商筛选。
- 仅站点、入驻队列、用户和模型展示后端支持的全量关键词搜索；其它资源使用明确标注的当前页搜索及支持的服务端状态筛选。
- 模型/厂商标识、已有模型所属厂商在编辑时固定，与后端 PATCH 可写字段一致。
- 厂商元数据缺失时，空表单字段保留原值，避免修改名称顺带清空官网、描述或排序。
- 修改站点、渠道和审核时不再把 `{ ok: true }` 声明为完整资源返回。
- 探测间隔输入下限与真实 API 的 30 秒一致。
