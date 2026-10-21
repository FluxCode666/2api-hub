# 2API Hub 设计系统

品牌概念：清晰的连接。深墨绿的精密数据界面，以薄荷绿作为可操作和可信的视觉线索。全站简体中文，不使用 emoji。

## 随机化定稿
gpt-taste 模拟 Python seed=2210：Cinematic Center Hero；Geist 字体；Infinite Marquee、Horizontal Accordions、Inline Typography Images；GSAP Scroll Pinning 与 Scrubbing Text Reveals。

## 视觉变量
- 背景 `#0b100f`，面板 `#111816`，高一层面板 `#17201d`；边线 `#26322d`。
- 正文 `#edf4ef`，次级文字 `#98aaa0`；主色 `#bbf49a`，强调文字深色 `#122013`。
- 成功 `#9be6b0`、警告 `#efc47c`、失败 `#f18e91`、未知 `#85948b`。不能仅凭颜色判断状态，必须有文字/可访问标签。
- 亮色通过 `[data-theme=light]` 覆盖语义变量，强调色使用深绿 `#36782b` 搭配白色，保证数字、链接与按钮的对比度。所有组件用 CSS 变量，不写固定白底。
- 字体 Geist，中文回退 PingFang SC / HarmonyOS Sans SC / Noto Sans SC / sans-serif；数据使用 Geist Mono 与 tabular-nums。
- 圆角：按钮 8px、卡片 14px、区块 20px；边线 1px；阴影弱。
- 内容最大宽 1320px，桌面边距 48px、移动端 20px。品牌区块纵向 120–160px；数据页面顶部 48px，表格行距紧凑。

## 公共 CSS 类（根代理提供）
`.container` `.section` `.page-head` `.eyebrow` `.muted` `.mono` `.panel` `.card` `.card-grid` `.stack` `.row` `.between` `.btn` `.btn-primary` `.btn-small` `.badge` `.badge-good` `.badge-warn` `.badge-bad` `.field` `.input` `.select` `.form-grid` `.notice` `.notice-error` `.table-wrap` `.data-table` `.empty` `.metric-grid` `.metric` `.dashboard` `.sidebar` `.dashboard-main` `.tabs` `.tab` `.tab-active`。

## 共用 TypeScript 接口
- `@/lib/api/client`: `api<T>(path, options?: RequestInit): Promise<T>`，浏览器请求同源 /api/v1。
- `@/lib/api/server`: `serverApi<T>(path, options?: RequestInit): Promise<T>`，SSR 透传 cookie；`getSession(): Promise<SessionUser|null>`；`requireSession(admin?: boolean): Promise<SessionUser|null>`（未登录 redirect；admin 不足权限返回 null）。
- `@/components/ui`: `PageHead({title,description?,eyebrow?,children?})`、`Metric({label,value,detail?})`、`Empty({title,description?})`、`StatusBadge({status})`、`FormatDate({value})`。
- `@/components/channel-table`: `ChannelTable({items: ChannelListItem[]})`。
- `@/components/charts`: `UptimeBar({points: SparkPoint[]})`、`Sparkline({points: SparkPoint[]})`、`TrustBadge({score, verdict})`。
- `@/components/dashboard-shell`: `DashboardShell({kind:'merchant'|'admin',user:SessionUser,children:ReactNode})`。

## 版式与动效
品牌页面按 AIDA：导航、宽幅 2–3 行 Hero（max-w-6xl）、密铺四块 bento（12列，7+5 / 5+7）、检测方法滚动叙事、CTA、页脚。每块可点击卡片都有轻微位移/内部放大反馈，按钮有边色和 y 位移反馈。GSAP 在 prefers-reduced-motion 下禁用；pin 仅桌面。
数据页面优先扫读：表头小号、数字右对齐、单位始终可见；60格状态条缺样本显示未知，不以成功补齐。移动端榜单用卡片，后台侧栏变横向导航。

## 目录所有权
主代理负责 src/app/(public)、根布局、globals.css、共享 components。数据代理负责 lib/api、lib/mock、app/api。站长代理负责 app/merchant、components/merchant、lib/mock/merchant.ts。管理代理负责 app/admin、components/admin、lib/mock/admin.ts。不得改他人文件或执行 git 写操作。

## 榜单密度
榜单标题与副标题同排；厂商、搜索与模型占第一行，五个排序分段按钮与「更多筛选」占第二行。次级条件折叠，输入防抖 300ms，其余控件即时生效并同步 URL。桌面表格行高 68px，表头 sticky 于导航下方；1440×900 实测首屏完整显示 7 行。移动端改为卡片，横向厂商导航独立滚动。页面主容器使用 overflow-x:clip，避免破坏 sticky。
