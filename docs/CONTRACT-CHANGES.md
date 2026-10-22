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

## 2026-10-22 推荐分可用率改为非线性 —— 编排者

> `computeRecommendScore` 中 `uptime_part` 由 `uptime24h × 100` 改为 `uptime24h ^ 8 × 100`（常量 `UPTIME_SCORE_EXPONENT`）。原因：线性计分下 69% 可用率渠道推荐分仍有 81.9，与 99% 渠道差距过小。前端 `/guide` 公式说明需同步。另：可信分 < 50（判为假模型）时推荐分封顶 40（常量 `FAKE_SCORE_CAP`）。

## 2026-10-22 probe_tasks 任务 lease 字段 —— Worker（审查修复 P1 #3）

- 变更：`packages/db/src/schema.ts` 的 `probeTasks` 新增 3 个可空列并生成迁移 `packages/db/drizzle/0002_probe_tasks_lease.sql`：`locked_by`（text，持有者 worker 实例 id）、`lease_token`（uuid，每次领取新生成）、`heartbeat_at`（timestamptz，每 30s 心跳续租）。
- 原因：审查 P1 #3 发现任务回收与退出缺少实例所有权——超时回收无心跳、退出 SQL 归还所有近期 running 任务、完成/失败写入不校验领取代次，旧执行者可覆盖新执行者的状态并重复写报告/通知。
- 语义：任务完成、失败以及写报告、发通知等副作用写入均带 `WHERE id=$1 AND lease_token=$2` 校验，校验失败放弃写入；回收只处理 `heartbeat_at` 超过恢复阈值的任务；退出时只归还 `locked_by=本实例` 的任务。attempts 上限检查放进原子领取语句。
- 兼容性：向后兼容（只新增可空列，不改已有字段）；hub 与 hub_test 均已执行迁移。
- 顺带修复：drizzle/meta/0001_snapshot.json 之前是 0000 的直接拷贝（id 相同、prevId 未维护），导致 drizzle-kit generate 报 snapshot collision；已补全 prevId 链（0001.prevId → 0000.id，0001.id 换新 uuid），0002 迁移由 drizzle-kit 正常生成。

## 2026-10-22 通知与收藏改为服务端分页 —— 编排者

> 配合前端「所有列表改为分页」。`GET /me/favorites` 由 `ChannelListItem[]` 改为 `Paginated<ChannelListItem>`；`GET /me/notifications` 由数组改为 `NotificationList`（`Paginated<Notification> & { unreadCount }`，支持 `unread=true`）。均支持 `page`/`pageSize`。这是破坏性变更，由 Kimi（后端）与 Codex（前端）同步实施。

## 2026-10-22 新增公开探测记录分页接口 —— 编排者

> 前端请求为 `history` 增加分页字段；编排者改为新增独立接口 `GET /channels/:id/runs` → `Paginated<ProbeRun>`（公开、可见性规则与 `/channels/:id/history` 相同；errorMessage 与公开 history 一样只给中文分类）。`history.recentRuns` 保持不变（兼容）。由 Kimi 实现。

## 2026-10-22 新增管理端渠道分页接口 —— 编排者

> 新增 `AdminChannel extends MerchantChannel { site }` 与 `GET /admin/channels` → `Paginated<AdminChannel>`，替代前端「汇总全部站点详情后客户端分页」的做法。由 Kimi 实现，Codex 接入。
