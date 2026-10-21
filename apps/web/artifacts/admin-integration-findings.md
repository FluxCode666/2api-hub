# 管理后台真实 API 联调记录

## 当前状态

2026-10-22：管理路由已交付，真实 HTTP 检查目前 **30 项通过、0 项失败、2 项待验证**；原两项编辑字段静默丢失均已针对性复测解决。全零评分权重校验与厂商完整元数据回读也已通过。8712 尚未监听，完整入驻审核、倍率变化排队及探测执行终态继续等待本地上游/worker。未启动或停止 API、worker 或 Web 服务，未修改后端。

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
| 厂商目录 | `GET/POST /admin/vendors`、`PATCH/DELETE /admin/vendors/:id` | `AdminVendor` / `VendorInput` |
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

静态对齐和共享 `AdminVendor` 接入后的前端修改已通过 `pnpm --filter @hub/web typecheck`。只对新增厂商元数据行为运行定向 mock 检查：完整资料回读、部分更新保留原资料、显式 `null` 清空可选字段、排序保留和删除均通过。未运行全站 build。

真实结果见同目录 `admin-integration-results.json`：种子管理员登录与会话、游客 401/普通用户 403、全部管理 GET、站点完整结构与密钥掩码均通过。独立厂商 #9、模型 #20、停用公告 #3 的创建/编辑/删除通过；独立用户角色、封禁、恢复和实时会话通过；测试反馈 #3 标记已读与已处理通过；评分权重保存/回读、恢复原值以及对应审计记录均通过。

本轮测试目录和公告已主动清理。早先留下的独立普通账号 `707c99b7-7881-42ad-9015-4b21b86a810c`、已处理反馈 #3、草稿站点 #20、渠道 #40 和任务 #1，随后由后端集成测试结束时恢复种子数据统一清理；编排者已确认此原因。评分权重写入测试均恢复原值；全零请求复测确认无效写入没有修改现值。

原独立草稿站点 #20、渠道 #40 曾用于实际复现并复测两项管理 PATCH 丢字段问题，字段保存复测通过后均通过资源所有者的站长接口恢复原配置。原站点不公开、渠道关闭定时探测；这些资源现已被后端恢复种子清理。随后尝试倍率排队检查时发现原资源 404，未执行倍率修改，因此记为待验证；上游就绪后将与审核链一起新建独立资源检查。

管理手动探测曾返回 HTTP 202，为渠道 #40 创建 availability 任务 #1，任务队列可回读 queued 状态；任务在执行终态验证前随独立资源统一清理。新的执行终态与探测日志检查仍待 worker 和本地上游就绪。

### 已解决并针对性复测的后端差异

1. **渠道编辑字段已保存。** 后端补齐 `baseUrl/apiKey/protocol/primaryModel/backupModel/billingType` 后，对独立渠道 #40 修改并 GET 回读均一致，密钥通过掩码后缀确认；已恢复原配置。倍率变化排任务实现已落盘，运行验证待新独立资源。
2. **站点编辑字段已保存。** 后端补齐 `slug/contact` 后，对独立站点 #20 修改并 GET 回读一致，已恢复原配置。充值倍率变化排任务实现已落盘，运行验证待新独立资源。
3. **全零评分权重已拒绝。** 真实 API 返回 400，GET 回读确认原权重未变。
4. **厂商管理元数据已完整返回。** 共享契约新增 `AdminVendor`，真实 `GET /admin/vendors` 返回 `website/description/sortOrder`。独立厂商 #9 的官网、简介、排序和图标回读、仅改名保留资料、显式清空均通过，随后删除测试厂商。前端请求、编辑状态和 mock fixture 均直接使用共享 `AdminVendor`。

### 前端已修正

- 模型目录保留真实 API 分页元数据，显示上一页/下一页，增加厂商筛选。
- 仅站点、入驻队列、用户和模型展示后端支持的全量关键词搜索；其它资源使用明确标注的当前页搜索及支持的服务端状态筛选。
- 模型/厂商标识、已有模型所属厂商在编辑时固定，与后端 PATCH 可写字段一致。
- 厂商编辑完整回填官网、简介、排序与品牌图标网址；保留旧 API 缺字段时的空值保护。mock 使用共享 `AdminVendor`，部分更新保留未提交值，显式 `null` 可清空资料。
- 修改站点、渠道和审核时不再把 `{ ok: true }` 声明为完整资源返回。
- 探测间隔输入下限与真实 API 的 30 秒一致。
