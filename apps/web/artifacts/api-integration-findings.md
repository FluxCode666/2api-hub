# 真实 API 联调记录

## 静态审查

2026-10-22：静态审查时 8711 尚未启动。只读检查后端源码，未修改后端或共享契约。

1. **源码已修复，待真实验证：去站点参数名。** `apps/api/src/routes/public.ts` 原注册 `/api/v1/go/:channelId` 却按 `{ id }` 校验，导致查询前返回 400；后端现已直接校验 `channelId`。前端 `/go/:id` 代理路径符合 SPEC，脚本将检查真实 302 与 Location。
2. **URL 布尔值边界，部分修复。** `routes/channels.ts` 的 `stableOnly` 原用 `z.coerce.boolean()`，字符串 `false` 被视为 true；本次只读复核时仍待修复。`routes/public.ts` 的 `featured` 已改为专用 `boolQuery`。前端常规交互省略 false；脚本包含两个显式 false 的回归检查。
3. **已修复：登录/注册密码长度边界。** 前端 `auth-form.tsx` 原允许 128 位，后端 auth schema 最长 100 位；主代理已将 UI 上限改为 100，mock 也同步校验 8–100 位。
4. **个人评价增量已对齐。** `MyReview` 从 `@hub/shared` 导入，包含 `status` 与所属站点；真实 `GET /me/reviews`、`DELETE /me/reviews/:id` 已在 `routes/me.ts` 实现，限定当前用户，删除他人的评价返回 404。前端页面/组件与 mock 使用相同路径和字段。
5. **已修复：注册空昵称边界。** 前端原始表单会发送 `nickname: ''`，与真实 API optional nickname 的 `.min(1)` 校验冲突；主代理已改为空昵称时省略该字段。
6. **真实验证已修复：站点列表日期序列化。** 首次运行 `/sites` 返回 500。只读 SELECT 确认 postgres-js 原始查询的 `created_at` 是字符串，原 `r.created_at.toISOString()` 会抛错；后端已改为 `new Date(r.created_at).toISOString()`。当前站点列表、详情、公开评价均通过，写入流程也已完成。脚本将列表和详情独立检查，列表失败时可使用渠道关联站点继续验证，保留列表失败记录。

<!-- runtime-results -->

## 最近运行

- 时间：2026-10-22T10:54:51.125Z
- API：http://127.0.0.1:8711
- Web：http://127.0.0.1:3210
- 结果：30 通过 / 0 失败 / 0 跳过
- 写入测试：已启用；测试收藏和评价会清理，测试注册账号保留

| 状态 | 检查 | 说明 |
| --- | --- | --- |
| PASS | 真实 API /healthz |  |
| PASS | 公开 /meta /vendors /models 与共享契约 |  |
| PASS | 公开站点列表分页与契约 |  |
| PASS | 渠道契约、倍率公式与连续排名 |  |
| PASS | 公开站点详情与评价分页 |  |
| PASS | stableOnly=true 稳定性筛选 |  |
| PASS | stableOnly=false 不应开启稳定筛选 |  |
| PASS | featured=false 不应只返回精选模型 |  |
| PASS | 模型厂商/关键词筛选 |  |
| PASS | 渠道详情与检测报告契约 |  |
| PASS | 渠道站点/厂商/关键词/协议/倍率/阈值组合筛选 |  |
| PASS | 渠道 history 1h |  |
| PASS | 渠道 history 24h |  |
| PASS | 渠道 history 7d |  |
| PASS | 渠道 history 30d |  |
| PASS | 公开探测日志服务端分页、失败筛选与标准错误 |  |
| PASS | 按 ids 批量对比 |  |
| PASS | /go/:channelId 返回 302 与站点地址 |  |
| PASS | 指定模型报价、价格升序与 null 最后 |  |
| PASS | 按模型可信分、主测参考与详情摘要一致 | 检查 12 个渠道；所选模型 claude-opus-5-5 |
| PASS | 未检测模型保留 null/unknown 且不参与可信阈值 | 3 个尚未检测的模型记录；无未检测记录时仅验证阈值筛选 |
| PASS | 首页 Top3 与启用公告 |  |
| PASS | 公开校验失败与标准错误结构 |  |
| PASS | 游客认证/收藏/个人评价/通知均 401 |  |
| PASS | 真实登录 Cookie、会话、用户接口与 admin 403 |  |
| PASS | 个人收藏服务端分页与跨页连续排名 |  |
| PASS | 站内通知服务端分页、全局未读数与输入校验 |  |
| PASS | 注册→收藏→我的评价分页/更新/越权/删除→清理 | 测试收藏与评价已清理；无删除用户接口，保留一个无业务数据测试账号 |
| PASS | Next 同源 API 代理与真实 Cookie |  |
| PASS | 实际快速鉴定报告契约与 Key 不回传 |  |

本次已执行项目全部通过，SKIP 项仍需按运行条件补齐。
