# 契约变更记录

## 2026-10-22 前端请求 —— 编排者已批准并落地

> 决策：新增 `MyReview` 类型（`packages/shared/src/contract.ts`），SPEC §7.3 新增 `GET /me/reviews`（`Paginated<MyReview>`）与 `DELETE /me/reviews/:id`。由 Kimi 实现。渠道独立接口维持现状（前端已用站点详情汇总）。


- 请求新增 `GET /api/v1/me/reviews`，返回 `Paginated<MyReview>`；建议新增 `MyReview extends Review { site: { id: number; slug: string; name: string }; status: ReviewStatus }`。
- 原因：SPEC §8 的个人中心需展示「我的评价」。原有公开评价不含 userId 和所属站点，无法安全、正确地汇总当前用户自己的评价。前端现已接入个人评价列表、分页与删除，并通过真实 API 创建/更新/删除联调。
- `GET /merchant/channels/:id` 与 `GET /admin/channels` 暂缺独立契约，前端已通过受权限控制的站点全量详情汇总渠道解决，非阻塞。

## 2026-10-22 前端请求 —— 厂商管理资料回显（待裁决，非阻塞）

- 请求让 `GET /api/v1/admin/vendors` 返回现有 `VendorInput` 中的 `website`、`description`、`sortOrder`；可新增共享 `AdminVendor` 类型，或增加带这些字段的管理详情接口。
- 原因：当前共享返回类型 `VendorSummary` 只覆盖公开摘要，无法回填管理表单中的官网、简介和排序。管理编辑现有厂商时应能看见已有内容。
- 当前适配：前端对没有读到的元数据省略空值 PATCH，避免修改名称时误清空已有资料。前端未自行添加重复 DTO 或修改共享包；待契约批准后接入完整回显。

## 2026-10-22 AdminVendor —— 编排者已批准并落地

> 新增 `AdminVendor extends VendorSummary { website; description; sortOrder }`，`GET /admin/vendors` 返回 `AdminVendor[]`。由 Kimi 实现。

## 2026-10-22 probe_tasks 活动任务部分唯一索引 —— Kimi（审查修复 #5）

- 变更：新增增量迁移 `packages/db/drizzle/0001_probe_tasks_active_uq.sql`，创建部分唯一索引 `probe_tasks_active_uq ON probe_tasks (channel_id, kind) WHERE status IN ('queued','running')`。
- 原因：审查 #5 发现并发/多入口可重复入队同一渠道同类型任务。原子入队 `enqueueProbeTask()`（`SELECT ... FOR UPDATE` + 复用活动任务）已上线，此索引作为数据库层兜底。
- 兼容性：向后兼容（新增索引，不改已有字段）；需先清理存量重复活动任务（当前库经原子入队修复后不会产生）。
- 不改 schema.ts（索引由迁移 SQL 直接创建，schema 的 index 声明是查询优化的提示，部分唯一索引的 WHERE 子句在 drizzle schema 中不支持，故放迁移文件）。
