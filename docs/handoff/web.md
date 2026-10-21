# Web 前端交接

## 状态

公开站、站长工作台和管理后台已实现。Mock 验收已完成，Web 已切换默认真实 API 模式；真实模式 39 个页面和 3 项游客跳转均通过。连接成功、实际鉴定与任务完成路径仍等待 mock-upstream/worker，不能将 Mock 结果视为真实检测验收。

## 运行

在仓库根目录执行：

```bash
pnpm --filter @hub/web dev
# http://127.0.0.1:3210，默认连接 http://127.0.0.1:8711

HUB_MOCK=1 pnpm --filter @hub/web dev
# 独立演示模式，不需要 API、数据库和 worker

pnpm --filter @hub/web typecheck
pnpm --filter @hub/web build
pnpm --filter @hub/web start
```

Next 配置读取根目录 `.env`；`API_INTERNAL_URL` 决定 SSR 和同源代理的目标。切换 Mock 与真实模式需要重启 Web。不要在 `NODE_OPTIONS` 或启动脚本中加入相对路径 `--env-file=../../.env`，Next 子进程会继承该选项而启动失败。

Mock 账号：管理员 `admin@2api.hub / admin123456`、站长 `merchant@2api.hub / merchant123456`、用户 `user@2api.hub / user123456`。Mock 变更保存在当前 Node 进程，重启后恢复 fixture。API Key 只返回掩码；公开鉴定在演示模式明确标记模拟报告。

## 已完成页面与功能

- 公开站：`/`、`/rankings`、`/models`、`/models/[slug]`、`/vendors`、`/vendors/[slug]`、`/sites`、`/sites/[slug]`、`/channels/[id]`、`/compare`、`/verify`、`/join`、`/guide`、`/login`、`/register`、`/me`。
- 站长：`/merchant`、`/merchant/sites`、`/merchant/onboarding`、`/merchant/sites/[id]`、`/merchant/sites/[id]/edit`、`/merchant/channels/[id]`。支持四步入驻、渠道 CRUD、连接测试、模型发现与映射、覆盖价格、提交审核、检测任务轮询与日志。按审核状态限制新增/删除渠道，模型编辑统一通过专用模型接口。
- 管理：`/admin`、`/admin/sites/[id]`，以及入驻审核、站点、渠道、探测日志、任务、模型、厂商、用户、反馈、评价、公告、设置和审计列表。
- 公开数据：榜单即时筛选、URL 同步、分页、收藏、2–4 渠道对比、模型价格、60 格状态条、可信徽章、SVG 延迟趋势与历史窗、逐项检测报告。
- 用户：Cookie 登录注册、通知已读、站点评价、个人评价分页与删除、反馈。
- 权限：游客访问 `/merchant`、`/admin`、`/me` 跳转登录并保留目标地址；普通用户访问管理页显示 403，且不请求管理数据。

所有接口 DTO 直接引用 `@hub/shared`。客户端使用同源 `/api/v1`，服务端直接访问内部 API 并透传 Cookie；前端不保存登录 Token。`/api/v1/[...path]` 在 Mock 模式处理 fixture，真实模式透明代理状态、内容与 Set-Cookie；`/go/:id` 使用 Next rewrite。

## 设计摘要

完整规范见 `apps/web/DESIGN.md`。Geist 配合中文系统字体回退、墨绿底色和薄荷绿强调；亮色主题采用深绿强调色确保文字对比度。品牌页面使用宽幅两至三行 Hero、AIDA、密铺 Bento、GSAP ScrollTrigger、滚动文本与悬停反馈；尊重减少动态效果偏好。

数据页优先扫读，数字等宽、状态语义统一。榜单筛选压缩为两行，次级条件折叠；输入防抖 300ms，其余条件即时生效。1440×900 实测表格从约 335px 开始，首屏完整显示 7 行；表头滚动后保持在导航下方 81px。390px 改为渠道卡片。

## 已做验证

- TypeScript strict 类型检查与 `HUB_MOCK=0` 生产构建通过。
- Mock 下 39 个公开、站长与管理路由返回 200，另 3 项游客重定向检查通过，无页面运行错误，结果保存在 `apps/web/artifacts/mock-route-checks.json`；游客重定向及用户 403、API 的 401/403 正常。
- Mock 全链路：草稿 → 添加渠道 → 连接失败/成功 → 发现模型 → 0 元覆盖价 → 排队检测/任务完成 → 提交审核 → 管理通过 → 公开展示 → 暂停/恢复；评价隐藏、用户禁用、脱敏与越权拒绝也已验证。
- 浏览器验证个人评价提交 → 个人中心列表 → 确认删除 → 空态；鉴定表单与逐项模拟报告正常。
- 榜单高级筛选、搜索、排序、URL 同步、浏览器后退回填与 sticky 表头已验证；输入防抖等待期间后退会取消旧计时器，避免搜索条件重新覆盖历史导航。模型和厂商详情复用即时筛选及分页，在当前详情内锁定模型或厂商；对比移除渠道后保留模型条件。
- 无效渠道地址先读取主资源并进入 404，再决定是否加载历史和报告，避免并行请求的附属资源错误抢先触发运行错误页；真实缺失渠道已复测。
- 390px 检查首页、榜单、模型/厂商/站点目录与详情、渠道详情、对比、入驻落地页、指南、登录注册、个人中心、入驻向导和管理审核页，无文档级横向溢出。首页、入驻、指南与鉴定页的移动 Hero 均为两行。
- 截图存于 `apps/web/artifacts/`：`home-*`、`rankings-*`（含亮色）、`channel-*`、`onboarding-*`、`admin-reviews-*`、`me-reviews-mobile.png`、`verify-mobile.png`。已打开截图目视自查。

## 联调问题

API 健康检查已通过，Web 已以 `HUB_MOCK=0` 重启。真实模式全量页面检查共 42 项通过，结果在 `apps/web/artifacts/real-route-checks.json`。首次真实联调发现站点目录 500，后端修复后已复测通过；后端其他问题及状态如下。前端未修改后端实现。

静态核对及真实联调发现以下问题，已发给后端处理：

| 问题 | 影响 | 状态 |
| --- | --- | --- |
| `/go/:channelId` 的参数校验要求 `id` | 所有去站点跳转可能返回 400 | 真实 302 已通过 |
| `stableOnly`、`featured` 使用 `z.coerce.boolean` | 字符串 `false` 被解析为 true | 两者已修复并真实复测；stableOnly=false 与未筛选均为 33 条，true 为 0 条 |
| 密码上限前后端不同 | 101–128 位密码在浏览器通过、API 拒绝 | 前端与 Mock 已对齐 100 位 |
| 注册空昵称发送空字符串 | optional 昵称被 API 的 min(1) 拒绝 | 前端改为空值时省略字段 |
| 站长详情将原生 SQL 的 snake_case 报告传入 camelCase 序列化函数 | 有检测报告的站点详情可能返回 500 | 12 个种子站点详情/32 份报告真实复测通过 |
| 渠道关键连接配置修改后沿用 lastTestOk | 无效新配置仍可使用旧成功记录提交 | 后端已修；失败测试后变更配置清空状态已通过，成功测试后失效待上游 |
| PUT 模型全删重建 | 仅修改覆盖价也丢失已有检测元数据 | 后端改为 upsert；真实 ID、映射、覆盖价及非空检测历史/可信分保留均通过 |
| 管理渠道/站点 PATCH 剥除若干可编辑字段 | UI 返回成功但连接配置、contact/slug 等未保存 | 后端已修，全部字段真实定向复测通过 |
| 管理修改倍率未排检测任务 | 与规格要求的倍率修改触发重新检测不符 | 已通知后端 |
| 允许四项评分权重全 0 | 推荐分计算可能出现 0 分母 | 后端已修，拒绝全零且保留原值的真实复测通过 |
| 管理厂商仅返回公开摘要，缺官网/简介/排序 | 编辑时无法完整回显已有资料 | 编排者批准 AdminVendor；前端/Mock 已接入，真实完整回读、部分更新保留和显式 null 清空均通过 |
| 原始 SQL 的 created_at 实际为字符串 | `/sites` 500 | 后端已修复并真实复测 200 |

`GET /me/reviews` 与 `DELETE /me/reviews/:id` 已获批准，`MyReview` 已进入共享契约，前端与 Mock 均已接入；真实创建、同站更新、分页、越权拒绝、本人删除及重复删除 404 均已通过。测试收藏与评价已清理，因无删除用户接口保留一个无业务数据的测试账号。

真实公开/用户接口最近完整检查为 23 通过、1 失败、1 跳过；其中失败的 stableOnly=false 随后定向复测已通过，实际鉴定仍待上游。管理接口最近完整检查为 26 通过、2 失败；两项字段保存失败随后均已修复并真实复测通过，另补测全零权重拒绝及 AdminVendor 完整资料通过。管理检查包含独立目录/公告 CRUD、用户角色/封禁恢复、反馈、评分保存恢复、审计与检测任务排队 202。测试权重已恢复；原独立草稿站点 #20 随后已不可读取，倍率排队和完整审核链将以新独立资源补测。

真实桌面截图已覆盖首页、榜单、渠道详情、入驻向导和管理审核；390px 截图已覆盖首页、榜单、渠道详情、向导和审核，无文档横向溢出，页面捕获的运行错误为空。真实历史图表已在浏览器切换近 7 天和近 1 小时，数据加载与选中态正常。真实榜单暂无统计数据的状态已确认正常显示；首页未收到探测样本时显示「等待探测」。截图为 `apps/web/artifacts/*-real-*.png`。

页面检查：`HUB_ROUTE_MODE=mock node apps/web/scripts/check-web-routes.mjs`；真实模式省略 `HUB_ROUTE_MODE`。通过实际 curl 遍历路由并检查流式错误页与登录重定向。

可复用检查：`node apps/web/scripts/check-api-integration.mjs` 仅测试 API；加 `HUB_WEB_URL=http://127.0.0.1:3210` 检查同源代理；加 `HUB_INTEGRATION_WRITES=1` 验证用户 CRUD 并清理临时数据。详细清单和结果位于 `apps/web/artifacts/api-integration-*`。

## 尚未真实联调的接口

公开目录、榜单、报告、历史、认证、完整用户评价/收藏 CRUD、站长 CRUD/模型价格与管理读取/目录 CRUD/用户/反馈/评分/审计已联调。连接成功、模型发现、提交审核、检测任务完成和实际公开鉴定仍依赖 8712 上游与 worker。Proxy 与 Cookie 透传的真实会话验证已通过。

## 已知限制

- 真实检测、统计聚合和任务处理依赖 API、worker 与 mock-upstream 就绪。
- Mock 仅供开发演示，不提供持久化；其中评分、历史和报告为 fixture。
- 移动端对比表和后台密集表格在自身容器内横向滚动。
- Next 流式响应的部分 403/404 页面可能以 HTTP 200 返回，但内容显示对应状态；API 保持实际 401/403/404。
