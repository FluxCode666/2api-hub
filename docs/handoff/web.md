# Web 前端交接

## 状态

公开站、站长工作台和管理后台已实现。Mock 验收已完成，Web 默认连接真实 API；真实模式 39 个页面和 3 项游客跳转均通过。真实连接测试、模型发现、提交审核、任务终态、管理审核上线、定时探测与公开鉴定均已通过。最终真实截图与结构化证据在 `apps/web/artifacts/final/`。

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

## Standalone 与 Docker

`next.config.ts` 已启用 `output: 'standalone'`，`outputFileTracingRoot` 指向仓库根目录。普通真实 API 构建通过，保留首页 60 秒、目录 300 秒 ISR。手动启动时先复制静态资源，再从 standalone 根运行：

```bash
cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/
cp -R apps/web/public apps/web/.next/standalone/apps/web/
cd apps/web/.next/standalone
PORT=3210 HOSTNAME=0.0.0.0 API_INTERNAL_URL=http://127.0.0.1:8711 node apps/web/server.js
```

`apps/web/Dockerfile` 已实际构建并运行验证。三条 COPY 分别放置 standalone 根、`apps/web/.next/static`、`apps/web/public`；OG 字体随 public 复制到 `apps/web/public/fonts/og`，页面字体随 static 复制。`Dockerfile.dockerignore` 排除 `.env*`、依赖、构建缓存和验收截图。镜像设置 `PORT=3210`、`HOSTNAME=0.0.0.0`。

镜像构建 RUN 仅临时设置 `HUB_SKIP_API_PRERENDER=1`，让请求 API 的页面跳过构建期预渲染；未使用 Mock。已用不可达的 `API_INTERNAL_URL=http://127.0.0.1:9` 完成构建。该开关不会写入 runner 环境，运行时仍使用 60/300 秒公共 Data Cache；普通 `pnpm build` 不设置该开关。`HUB_SITE_URL` 由 compose 同时传给 build arg 和运行环境，用于静态 canonical/robots 和动态 metadata。

镜像实际使用运行时 `API_INTERNAL_URL=http://host.docker.internal:8711` 验收，确认没有依赖构建时的 localhost：42 项页面/权限检查、25 项 SEO 检查均通过，三类 OG 图为 1200×630 PNG。原生 standalone 与 Docker 合计 38 项 JS/CSS/字体、Cookie 登录和 `/go` 302 检查通过。内部 rewrite 的 Route Handler 从匹配参数构造 API 路径，兼容 Next 保留原始请求 URL 的行为。结果为 `artifacts/standalone-checks.json`、`docker-route-checks.json`、`docker-seo-checks.json`；浏览器截图 `home-standalone-desktop.png`，无运行错误。

## 已完成页面与功能

- 公开站：`/`、`/rankings`、`/models`、`/models/[slug]`、`/vendors`、`/vendors/[slug]`、`/sites`、`/sites/[slug]`、`/channels/[id]`、`/compare`、`/verify`、`/join`、`/guide`、`/login`、`/register`、`/me`。
- 站长：`/merchant`、`/merchant/sites`、`/merchant/onboarding`、`/merchant/sites/[id]`、`/merchant/sites/[id]/edit`、`/merchant/channels/[id]`。支持四步入驻、渠道 CRUD、连接测试、模型发现与映射、覆盖价格、提交审核、检测任务轮询与日志。按审核状态限制新增/删除渠道，模型编辑统一通过专用模型接口。
- 管理：`/admin`、`/admin/sites/[id]`，以及入驻审核、站点、渠道、探测日志、任务、模型、厂商、用户、反馈、评价、公告、设置和审计列表。
- 公开数据：榜单即时筛选、URL 同步、分页、收藏、2–4 渠道对比、模型价格、60 格状态条、可信徽章、SVG 延迟趋势与历史窗、逐项检测报告。
- 用户：Cookie 登录注册、通知已读、站点评价、个人评价分页与删除、反馈。
- 权限：游客访问 `/merchant`、`/admin`、`/me` 跳转登录并保留目标地址；普通用户访问管理页显示 403，且不请求管理数据。

所有接口 DTO 直接引用 `@hub/shared`。客户端使用同源 `/api/v1`，服务端直接访问内部 API 并透传 Cookie；前端不保存登录 Token。`/api/v1/[...path]` 在 Mock 模式处理 fixture，真实模式透明代理状态、内容与 Set-Cookie；`/go/:id` 内部 rewrite 到 `/api/v1/go/:id`，再通过运行时 API 地址转发，避免镜像固化构建机地址。

## 设计摘要

完整规范见 `apps/web/DESIGN.md`。Geist 配合中文系统字体回退，采用默认亮色的纸白、墨黑、朱红主题，暗色可选。主题已映射为 shadcn token；品牌朱红与酒红失败状态严格区分。品牌页面使用宽幅两至三行 Hero、AIDA、密铺 Bento、GSAP ScrollTrigger、滚动文本与悬停反馈。Hero 在 SSR 时即完整可见，五组元素仅做 8px 位移、总时长 0.61 秒；减少动态效果时关闭 GSAP、CSS 动画与平滑滚动。

数据页优先扫读，数字等宽、状态语义统一。榜单筛选压缩为两行，次级条件折叠；输入防抖 300ms，其余条件即时生效。1440×900 实测表格从约 335px 开始，首屏完整显示 7 行；表头滚动后保持在导航下方 81px。390px 改为渠道卡片。

## SEO、分享与缓存

- 所有公开页面提供独立 `generateMetadata`、description、canonical、简体中文 Open Graph 与 Twitter 大图信息。模型摘要包含最低输入价、渠道数和最佳可用率；站点与渠道摘要包含真实价格/倍率、渠道与模型数量、可用率和用户评价。无样本明确显示待采样，不将空数据当作 0%。
- 部署时设置 `HUB_SITE_URL`（或 `NEXT_PUBLIC_SITE_URL`）为真实公开域名；默认 `https://2api.hub`。canonical 和 sitemap 使用统一 origin，并移除筛选查询，避免重复收录。
- `/sitemap.xml` 通过公开 API 分页收集所有模型、厂商、已上线站点与渠道。仅收录 active 渠道；不包含私有页面、登录注册、临时对比和失效/暂停渠道。`/robots.txt` 禁止 `/merchant`、`/admin`、`/me`、`/api`、登录注册与跳转路径；认证页和个人中心额外带 noindex。
- JSON-LD：首页 `WebSite + SearchAction`；模型页对应当前榜单的 `ItemList`；站点页 `Organization`，有有效评价时才附加 `AggregateRating`；指南页 `FAQPage` 与可见问答使用同一份内容。JSON 序列化转义 `<`，防止内容中断 script。
- 分享图固定路径：`/opengraph-image`、`/models/[slug]/opengraph-image`、`/sites/[slug]/opengraph-image`。三个路由均使用 `ImageResponse` 生成 1200×630 PNG，采用纸白底、墨黑字和朱红强调。本地 Geist 与 Noto Sans SC 字体和许可证位于 `apps/web/public/fonts/og/`，生成过程不依赖外网字体；未知详情回退品牌图。
- 公共数据使用不读取 Cookie 的 `publicApi`，榜单与探测数据 60 秒、目录 300 秒；首页 ISR 60 秒，厂商目录和鉴定页 300 秒，站点/渠道详情因支持独立 URL 分页使用动态渲染，公共资源仍按 60 秒缓存。带 URL 筛选的页面保留动态渲染，同时复用 Data Cache。私有 `serverApi` 强制 no-store。
- 收藏通过客户端共享请求读取，公共缓存不含当前用户收藏；`/me` 保留私有初值。通过同源 API 修改公开资料或评价会立即失效公共标签、公开布局和 sitemap。Next 的 API rewrite 位于 fallback，确保写入先经过 Route Handler 的失效逻辑。
- 验证脚本：`node apps/web/scripts/check-seo.mjs`，25 项检查在开发和生产模式均通过，覆盖独立摘要、结构化数据、sitemap/robots 和三类 PNG。生产模式已确认首页/目录缓存 HIT，站点与渠道首次 MISS、再次 HIT；结果为 `artifacts/seo-checks.json`、`isr-production-checks.json`，分享图预览为 `og-home.png`、`og-model.png`、`og-site.png`。
- 生产模式及最终 standalone 下已验证评价保存与删除都会让站点页首次请求 MISS，并立即反映变化，下一次请求恢复 HIT；测试评价已清理。最终证据为 `artifacts/standalone-cache-invalidation.json` 与 `.md`。

## 已做验证

- 最终源码的 `pnpm --filter @hub/web typecheck` 与 `HUB_MOCK=0 pnpm --filter @hub/web build` 均通过，保留 standalone 与 ISR；构建输出见 `artifacts/final/build.log`。构建后已恢复 3210 的真实模式开发服务。
- Standalone/Docker 调整后，Mock 与真实开发服务的 42 项路由检查再次全部通过；Mock 和真实 `/go/1` 均返回 302。验收容器已停止，3210 已恢复 `HUB_MOCK=0` 的开发服务。
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
| 渠道关键连接配置修改后沿用 lastTestOk | 无效新配置仍可使用旧成功记录提交 | 后端已修；真实成功连接后改 Key 清空状态、未重测提交 400、重测恢复提交均通过 |
| PUT 模型全删重建 | 仅修改覆盖价也丢失已有检测元数据 | 后端改为 upsert；真实 ID、映射、覆盖价及非空检测历史/可信分保留均通过 |
| 管理渠道/站点 PATCH 剥除若干可编辑字段 | UI 返回成功但连接配置、contact/slug 等未保存 | 后端已修，全部字段真实定向复测通过 |
| 倍率变化曾触发检测任务 | 倍率只影响价格，无需检测上游 | 最终规则已统一；分组/充值倍率的修改和恢复四次 PATCH 均无新任务，连接记录保留，见 final/ratio-tasks.json |
| 允许四项评分权重全 0 | 推荐分计算可能出现 0 分母 | 后端已修，拒绝全零且保留原值的真实复测通过 |
| 管理厂商仅返回公开摘要，缺官网/简介/排序 | 编辑时无法完整回显已有资料 | 编排者批准 AdminVendor；前端/Mock 已接入，真实完整回读、部分更新保留和显式 null 清空均通过 |
| 原始 SQL 的 created_at 实际为字符串 | `/sites` 500 | 后端已修复并真实复测 200 |
| probe 的外部 undici Agent 与 Node 内置 fetch 不兼容 | 上游直连正常，API 的连接测试/鉴定仍报 network | 检测负责人已统一 undici fetch/Agent；真实连接成功、公开鉴定 100/genuine 已通过 |
| 新增公开 `/channels/:id/runs` 初期查询失败 | 渠道详情日志无法服务端分页 | 后端已修；分页、只看失败、中文错误分类、越界空页与 total 上限均已真实复测通过 |
| 收藏跨页 rank 沿用榜单排名 | 收藏列表序号不连续 | 后端改为按收藏最终返回顺序编号，跨页连续性已复测通过 |
| 收藏越界空页生成 SQL `IN ()` | `/me/favorites?page=2&pageSize=100` 返回 500 | Kimi 已修；page=2、page=9999 均返回空 items，pageSize=101 截断为 100，真实回归通过 |

`GET /me/reviews` 与 `DELETE /me/reviews/:id` 已获批准，`MyReview` 已进入共享契约，前端与 Mock 均已接入；真实创建、同站更新、分页、越权拒绝、本人删除及重复删除 404 均已通过。测试收藏与评价已清理，因无删除用户接口保留一个无业务数据的测试账号。

分页改造后的真实公开/用户接口只读检查为 26 通过、0 失败、2 跳过；跳过本轮未开启的用户写入 CRUD 与脚本未配置鉴定凭据，浏览器另已完成 genuine/fake 两次真实鉴定。包含 `stableOnly=false`、收藏/通知/公开探测记录的服务端分页与边界。原管理定向复测 30 项通过、0 项失败；后续两项倍率规则也已通过，修改及恢复共四次 PATCH 均未新建任务。管理检查包含独立目录/公告 CRUD、用户角色/封禁恢复、反馈、评分保存恢复、审计与检测任务排队 202。测试权重已恢复；原独立草稿站点 #20 / 渠道 #40 等随后端集成测试的种子恢复清理。

真实成功链使用独立站点 #15 / 渠道 #35：连接 200 → 修改 Key 清空连接记录 → 未重测提交 400 且仍为草稿 → 重测 200 → 发现并映射 18 个模型 → 正常保留单一主测模型 → 提交后状态 pending。入驻任务 #1 已真实完成，报告 #81 为 100/genuine、八项检查。浏览器审核通过后站点进入公开目录/榜单，启用每 60 秒探测；首条 schedule 日志 #34600 在审核后 54.6 秒出现，后续状态条样本持续增长。浏览器再次手动发起任务 #60，自动轮询至 done 并刷新八项报告。资源 #15/#35 当前保留上线以供复查；前期链路证据在 `artifacts/admin-success-chain-results.json`，终态证据在 `artifacts/final/success-chain.json`、`api-regressions.json`、`browser-task.json`。

真实桌面截图已覆盖首页、榜单、渠道详情、入驻向导和管理审核；390px 截图已覆盖首页、榜单、渠道详情、向导和审核，无文档横向溢出，页面捕获的运行错误为空。真实历史图表已在浏览器切换近 7 天和近 1 小时，数据加载与选中态正常。早期无样本状态曾确认正常显示；当前 worker 已持续聚合真实统计，首页显示真实 Top3 和按最近探测时间排序的动态。截图为 `apps/web/artifacts/*-real-*.png`。

真实浏览器公开鉴定显示 100/100、genuine 与八项检查，完成后 Key 输入清空，未捕获运行错误；截图 `artifacts/verify-real-report.png`。普通用户收藏在公共页面 hydration 后正确回填，第一页中四条已收藏渠道状态正确。最终 390px 榜单截图为 `artifacts/rankings-final-mobile.png`，文档宽度 390px，无运行错误；本轮 Ego TaskSpace 29 已按规范结束。

页面检查：`HUB_ROUTE_MODE=mock node apps/web/scripts/check-web-routes.mjs`；真实模式省略 `HUB_ROUTE_MODE`。通过实际 curl 遍历路由并检查流式错误页与登录重定向。

可复用检查：`node apps/web/scripts/check-api-integration.mjs` 仅测试 API；加 `HUB_WEB_URL=http://127.0.0.1:3210` 检查同源代理；加 `HUB_INTEGRATION_WRITES=1` 验证用户 CRUD 并清理临时数据。详细清单和结果位于 `apps/web/artifacts/api-integration-*`。

## 最终端到端验收（2026-10-22）

本轮使用 ego-browser TaskSpace 31，1440×900 和 390×844 双宽度检查，截图与 JSON 证据统一放在 `apps/web/artifacts/final/`。TaskSpace 已按规范关闭；Ego Lite 有可用更新，未执行升级。

- 入驻成功链：站点 #15 / 渠道 #35，入驻任务 #1 完成，报告 #81 为 100/genuine、八项检查；浏览器管理员审核通过后进入公开目录/榜单，首条定时探测在审核后 54.6 秒出现。站长浏览器再次发起任务 #60，自动轮询至 done 并刷新报告。保留站点上线、渠道 active、每 60 秒探测，供复查。
- 公开鉴定：通过真实 API 分别鉴定 mock-upstream 的 genuine 和 fake，UI 得分为 100 / 31，分别显示真模型 / 疑似假模型和八项检查；快速模式未执行项明确标示，完成后 Key 输入清空。
- 抖动渠道 #24：状态条包含成功和失败，约 69% 可用率与历史对应；错误按固定中文分类展示。前端将 sparkline 按时间排序，最新探测位于右侧。
- 失效渠道 #31：已上线站点下的详情、历史和报告均可只读查看；0% 可用率、延迟无成功样本显示 —，醒目显示「该渠道已失效：连续探测失败，已停止定时检测」。隐藏去站点主按钮，metadata noindex/nofollow，sitemap 排除。暂停渠道使用相同只读逻辑和对应横幅。
- 首页 Top3 和最近探测动态均由真实 API 提供。动态从所有 active 渠道分页获取，按 lastProbeAt 排序。Top3 最终截图真正覆盖模型切换与三条榜单。
- 指南从 `@hub/shared` 引用 `UPTIME_SCORE_EXPONENT`、`FAKE_SCORE_CAP`，公式为可用率八次方乘 100，示例 99%→92、95%→66、90%→43、70%→6；可信分低于 50 时推荐分封顶 40。可见 FAQ 和 FAQPage JSON-LD 同步更新。
- 检测规则：仅 baseUrl、API Key、protocol、primaryModel 变化触发自动真伪检测；倍率与资料修改不触发。入驻页和站长/管理编辑提示已同步。分组倍率、充值倍率修改与恢复均已定向复测，四次 PATCH 新增任务为零；最终倍率恢复 0.5 / 1。
- Hero 首屏不设置 opacity:0。桌面与手机在导航后约 373ms / 360ms 完成截图，所有 Hero 元素 opacity=1；入场仅轻微位移，总时长 0.61 秒。另检查禁用 JavaScript 时首屏可见、减少动态效果时无动画。证据 `hero-visibility.json`、`motion-and-guide.json`。

最终截图包括 `home-desktop/mobile.png`、`home-top3-*`、`home-activity-*`、`rankings-*`、`verify-genuine/fake-*`、`flaky-*`、`dead-*`、`merchant-report-*`、`admin-approved-*`、`guide-scoring-*`；均已目视检查。鉴定结果、审核成功链、检测任务与失效只读规则分别见 `verify-results.json`、`success-chain.json`、`browser-task.json`、`dead-browser.json`。没有未解决的前端联调阻塞。

## API 第二轮修复配合（2026-10-22）

- 所有 API Key 输入（站长新建/编辑、管理员编辑、公开鉴定）统一最小长度 8、最大 500。RHF/Zod 表单错误与提交前校验均使用「API Key 长度至少 8 位」；编辑留空仍表示保留原 Key。
- 客户端新增 `apiWithHeaders`，保留响应资源与 Headers；原 `api` 调用方式兼容。站长和管理渠道保存识别 `X-Hub-Notice: rate_limited:*`，Sonner 警告提示「配置已保存，但今日自动检测额度已用完，本次未重新检测。」；不将保存成功误报为失败。
- Next 同源 Route Handler 原已保留业务响应头，真实浏览器确认 `X-Hub-Notice` 经过代理后可读。验收中发现后端 raw 中文头值会导致 Node `ERR_INVALID_CHAR`，已交 Kimi 改为 ASCII `rate_limited:merchant_daily_limit`；前端按前缀映射固定中文。
- 独立测试站点 #66 / 渠道 #130，手动任务 #86/#87/#88 完成并耗尽当日额度。修改 Key 仍返回 200，浏览器真实显示额度提示、无运行错误，任务仍仅为三条手动任务和一条入驻任务，活动任务为零。四类表单的短 Key 在浏览器均被拦截，不发送写请求；8 位边界与编辑留空允许，管理员普通保存 200 且不误显示额度提示。验收后删除空草稿 #67，下架测试站点 #66 并保持定时探测关闭；原 #15/#35 未改动。本轮 `typecheck` 和真实 API 生产 `build` 均通过，构建后恢复 3210 的真实模式开发服务。证据和截图在 `apps/web/artifacts/key-notice/`，Ego TaskSpace 32 已关闭。

## 模型筛选名称修复（2026-10-22）

共用榜单模型框使用目录 displayName 展示，附厂商色点，候选项带厂商名称；URL/API 保留 slug。真实浏览器确认直接打开、刷新、从模型详情跳转均显示「Opus 5.5」，模型详情只读锁定和厂商详情复用正常；名称/slug 选择、清空、后退与 300ms 防抖保持正常。`pnpm --filter @hub/web typecheck` 通过，1440×900 和 390×844 截图已目视检查，无横向溢出。证据位于 `apps/web/artifacts/model-selector/`；Ego TaskSpace 34 已关闭。

## 尚未真实联调的接口

本次范围内无待联调接口。公开目录、榜单、报告、历史、认证、用户评价/收藏 CRUD、站长 CRUD/模型价格、连接测试、模型发现、提交审核、公开鉴定与管理读取/目录 CRUD/用户/反馈/评分/审计均已联调。真实检测终态、审核后公开展示/统计和定时探测也已联调。Proxy 与 Cookie 透传的真实会话验证已通过。

## 已知限制

- 四个服务已就绪；本地真实验收使用 mock-upstream 的可控场景，不代表第三方真实中转站质量。
- Mock 仅供开发演示，不提供持久化；其中评分、历史和报告为 fixture。
- 移动端对比表和后台密集表格在自身容器内横向滚动。
- Next 流式响应的部分 403/404 页面可能以 HTTP 200 返回，但内容显示对应状态；API 保持实际 401/403/404。

## 纸白主题、shadcn 与统一分页（2026-10-22）

- `shadcn@latest` 初始化为 radix-nova / Tailwind v4，组件目录 `src/components/ui/`，图标统一 Phosphor。旧 `ui.tsx` 改为领域组合 `page-kit.tsx`。Button、Input、Textarea、Label、Checkbox、Switch、Select、Command/Popover、Tabs/ToggleGroup、Table、Badge、Card、Alert、Dialog/AlertDialog、Sheet、Collapsible、DropdownMenu、Tooltip/HoverCard、Sonner、Sidebar、Breadcrumb、Accordion、Skeleton、Separator、Avatar、ScrollArea、Pagination、Form 已统一；表单用 react-hook-form + zod。图表/探测状态条保留轻量领域实现。
- 唯一色板 `src/lib/theme-tokens.json`，CSS、OG、favicon 同源。亮色：纸白 `#F6F4EF`、白面板 `#FFFFFF`、墨黑 `#16130F`、朱红 `#C4313B`；暗色：`#121110` / `#1A1917` / `#F2EFE9` / `#FF6B6F`。状态成功 `#246B45` / `#83CFA0`，警告 `#875500` / `#E4B663`，失败 `#7C2948` / `#E4A0C0`，未知 `#6D675F` / `#AAA398`。朱红仅品牌和交互；失败徽章有图标/文字及虚线边框，失败状态格有斜纹。
- 默认 SSR 亮色；next-themes `defaultTheme=light`、`enableSystem=false`、`attribute=class`。head 内联脚本在内容绘制前恢复本域 `hub-theme`，同时更新 theme-color；浏览器首帧记录验证默认亮色和保存暗色均直接显示正确背景。
- `DataPagination` 用真实 a 链接显示总数、20/50/100、页码与省略号；390px 为上一页 / 第 x/y 页 / 下一页。服务端分页覆盖榜单、模型/厂商详情榜单、站点目录、站点评价、公开探测记录、个人收藏/评价/通知、站长探测日志、管理员站点/审核/用户/日志/任务/反馈/评价/审计/模型。数组分页覆盖模型/厂商目录、站点渠道、渠道模型与历史报告、站长我的站点/渠道/告警与入驻列表、管理厂商/公告；固定 Top3 与对比免分页。
- 渠道走势图继续请求 history；日志改为 `/channels/:id/runs`，使用 runsPage/runsPageSize 与只看失败筛选。站点评价使用 reviewsPage，站点渠道使用 channelsPage；切页不会覆盖另一个列表。筛选改变重置当前页，评价在后续页保存时回到评价第一页。
- 管理渠道已改为 `GET /admin/channels` 真实服务端分页，删除完整遍历站点详情的实现；支持渠道/站点/域名搜索、状态、厂商、协议、站点状态/编号与排序，以及失效/连续失败问题渠道快捷视图。所有已有 Paginated 接口均使用真实服务端分页。
- 已删除 globals.css 中旧通用组件类，源码硬编码颜色扫描为零（中央 token JSON 除外）。保留品牌布局与 GSAP；手机筛选区溢出、Tabs 滚动条和生产详情页静态声明冲突已修正。
- 对比度脚本 `node apps/web/scripts/check-contrast.mjs --save`：74/74 通过，最低文字 4.62:1、控件边界 3.26:1。完整主题和组件约定见 DESIGN.md。
- 最终 `typecheck`、真实 API `build` 均通过；生产模式路由 42/42、SEO 25/25；Mock 路由 42/42。源码硬编码颜色（中央色板除外）及旧通用类扫描均为零。结果、构建日志与截图统一位于 `apps/web/artifacts/theme-paper/`。
- ego-browser TaskSpace 37 完成双主题桌面检查：首页 Hero/Top3、榜单第 2 页与失败状态、抖动渠道、genuine/fake 鉴定、入驻向导、站长渠道、管理审核及日志分页。另检查 390px 首页、榜单和分页，以及三张 1200×630 OG 图；均已目视检查。移动文档宽度为 390px，分页每页条数切换与筛选均回到第 1 页，公开探测日志支持 runsPage=2。亮暗首帧及 theme-color 正确，证据 `theme-first-frame.json`、`pagination-interactions.json`。
- 本轮公开鉴定通过真实 API 获得 genuine=100、fake=31，八项检查完整显示；短 Key 被前端拦截，完成后 Key 清空。失效渠道 #31 保留状态横幅、只读历史与 noindex。朱红品牌操作与酒红失败徽章、斜纹状态格可清楚区分，延迟曲线使用中性色。


## 管理渠道分页与后台面包屑收尾（2026-10-22）

- 管理渠道列表直接导入 `AdminChannel`，调用 `/admin/channels?page=&pageSize=`；同一套 DataPagination 同步全部筛选到 URL，筛选及问题渠道快捷视图重置页码。表格显示所属站点与状态、渠道和连续失败数。可用率/可信分按从低到高排查，连续失败按从高到低，空统计排最后。
- Mock 同步新增接口及 AdminChannel 的 site 字段、搜索、筛选、四种排序和分页；保留 API Key 掩码。真实接口初次返回 500，已反馈 Kimi 并由后端修复，读取及边界已复测通过，前端未修改后端代码。
- 后台侧栏顶部改为「2API Hub · 站长 / 管理」。面包屑支持站点和渠道名称、编辑层级、继续入驻；站长渠道页显示「站长工作台 › 我的站点 › 星河API › Claude 官转」。名称复用详情页已取得的数据，不额外请求。渠道页侧栏选中「我的站点」，所有后台静态页面沿路由显示实际位置。

- 本轮验收：`typecheck`、真实 API `build` 与生产模式 42 项路由全部通过；Mock 接口 12 项检查及四种最终排序通过，真实接口 15 项定向检查通过。浏览器逐页核对站长 7 个路径、管理 15 个路径，并验证从详情页经侧栏切换后面包屑更新。指定截图 `light-admin-channels.png`、`light-merchant-breadcrumb.png` 已目视检查，另有管理第二页和 390px 面包屑补充截图。证据在 `artifacts/theme-paper/admin-*-checks.json`、`merchant-breadcrumb-checks.json` 与对应日志；Ego TaskSpace 41 已关闭，3210 恢复真实 API 开发模式。
## 可信分检测项悬浮卡片（2026-10-22）

- 共用 TrustBadge 接入 `ChannelListItem.trustReport`，覆盖榜单桌面/移动、首页 Top3、模型/厂商/站点渠道榜单、对比、个人收藏和渠道详情。站长站点/渠道/总览、管理渠道列表与站点模型使用完整报告映射，组件不重新定义接口 DTO。
- 桌面 HoverCard 延迟 150ms；触屏 Popover 点按，320px 卡片带视口碰撞处理和内部滚动。八项检测按共享常量显示中文名、通过/未通过/未计分、权重及部分得分。检测状态使用 success/danger/unknown，判定沿用 success/warning/danger/unknown，品牌红只用于报告链接。
- 支持键盘聚焦、逐项读屏描述、Escape 关闭、向下键聚焦报告链接。公共渠道详情增加 `#report` 和顶部滚动偏移，桌面键盘及移动点按链接均已验证。报告正文与折叠标题使用静态徽章，整卡链接拆为独立标题/详情链接，避免嵌套交互。
- Mock fixture 和公开 mock 映射补齐摘要；mock 存疑报告含部分得分与未计分样例。真实种子数据当前没有公开的未检测渠道，因此四状态截图中的未检测两张明确标注 `unknown-mock`，其余三类来自真实 API。
- 接口联调中发现摘要 id 为字符串，已交 Kimi 修正。更新契约回归脚本，检查摘要必填、ID 数值、检查状态/部分得分范围，以及与 stats 的分数/判定同源；真实 API 26 项通过。没有修改后端代码。
- 证据与亮暗桌面、390px 移动及后台截图统一位于 `apps/web/artifacts/trust-hover/`。本次复用既有纸白主题 token，对比度仍为 74/74 通过。
- 最终验收：typecheck、真实 API build、生产模式路由 42/42、真实 API 契约 26/26、主题对比度 74/74 均通过。浏览器抽查首页、模型、厂商、站点、对比、个人收藏和两个后台的摘要；390px 卡片完整可见，无页面横向溢出，键盘与 #report 跳转通过。
- Ego TaskSpace 49 已关闭；验收后 3210 恢复真实 API 开发模式。当前范围无待解决的联调阻塞。

## 按模型展示可信分（2026-10-22）

- 所有公共渠道徽章使用 `trustBasis`、`trustReport`、`fallbackTrustReport`；选中模型时，卡片注明「基于所选模型」，未筛选时注明「基于主测模型」。模型名优先使用目录 displayName，同时保留上游名称和检测时间。徽章与展开摘要取同一份报告分数和判定，避免统计刷新时间差造成展示不一致。
- 所选模型没有报告时，主徽章显示「未检测」，说明具体模型尚未完成检测；主测参考结果置于独立弱化区域，包含八项检测，并注明「仅供参考，不作为所选模型的可信分」。榜单、模型和厂商详情的说明行同步说明可信分与推荐分的口径。
- 渠道详情的每个模型均接入同一徽章。报告链接携带 `reportModel` 和 `#report`，定位并展示对应模型的完整报告或摘要；默认正文始终选主测模型，历史报告按模型名称区分，不会因其他模型的新报告而漏掉主测报告。
- 管理设置接入「定时检测范围」三选项和「非主测模型检测间隔（小时）」；小时数校验为 1–720 整数，附请求量与 Token 成本说明。主测间隔文案、指南正文、可见 FAQ 与 FAQPage JSON-LD 同步更新。
- Mock 保留主测高分/所选低分的混线渠道及所选未检测的 fallback 示例，各模型摘要、完整报告、筛选、排序和推荐分按同一模型计算。非主测任务仅更新对应模型；倍率修改不触发检测，连接参数变化仍触发。
- 最终 typecheck、真实 API 生产 build、生产路由 42/42、SEO 25/25、真实 API 契约 30/30、主题对比度 74/74 全部通过。API 本轮开启用户写入与快速鉴定检查，无跳过项；测试收藏/评价均已清理，因无删除用户接口，保留两个无业务数据的测试账号。Mock 路由 42/42 与六项模型口径定向检查通过。
- 真实种子渠道 #35：不筛选时为主测 Fable 100/genuine，选择 Opus 时为 41/fake、推荐分封顶 40；Haiku 渠道 #38 未检测，卡片显示主测 Fable 100 分参考。已覆盖亮暗 1440×900 的混线双口径、fallback、详情模型列表、首页 Top3 和设置页，以及 390×844 的三个点按卡片；卡片八项可访问，移动文档宽度均为 390px。Opus 报告链接正确展示对应的 41 分完整报告。截图已目视检查，证据位于 `apps/web/artifacts/trust-per-model/`。
- 验收后通过管理设置 UI 将 `authenticity.modelScope` 从 featured 恢复为 all，保存并刷新后回显「全部声明模型」；API 确认 all、非主测间隔仍为 48 小时，其他设置未变，见 `settings-restored.json`。Ego TaskSpace 51 已关闭，3210 恢复真实 API 开发模式。

### 联调问题

- 已发现并反馈后端：所选模型的 stats 与报告摘要口径不一致、模型摘要 ID 为字符串、未检测模型继承主测分数、部分 seed 仅写可信分而无报告、完整 latestReport 未限定主测模型。上述问题由对应负责人修复，前端没有修改后端代码。
- 最终回归新增发现：带 model 的 minTrust 仍按主测分数筛选；Top3 的模型缓存与最新报告不同源；混线 seed 报告的总分与检查项不一致；可信优先将未检测模型排在 41 分之前。均已交 Kimi 修筛选、排序与 seed，worker 负责人补模型缓存自愈。重新 seed、聚合和 API 更新后全部复测通过：minTrust 排除未检测，所选模型摘要与详情同源，可信分/推荐分按所选口径排序且空值排最后。当前无未解决的联调阻塞。
