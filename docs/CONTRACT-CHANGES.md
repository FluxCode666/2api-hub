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
