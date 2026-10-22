# 2API Hub 设计系统

品牌概念：清晰的连接。纸白、墨黑、朱红的评测杂志与权威榜单；默认亮色，暗色可选。全站简体中文，无 emoji。此轮保留布局、Geist 字体与 GSAP 动效。

## 既有设计定稿

gpt-taste 模拟 Python seed=2210：Cinematic Center Hero；Geist；Infinite Marquee、Horizontal Accordions、Inline Typography Images；Scroll Pinning、Scrubbing Text Reveals。品牌页保持 AIDA 导航→宽幅 Hero→12 列 7+5 / 5+7 密铺 bento→检测叙事→CTA/页脚。Hero max-w-6xl，2–3 行，SSR 完整可见，入场仅 8px 位移，总长 0.61 秒。减少动态效果时关闭动画。

## 色板与语义

唯一色值来源 `src/lib/theme-tokens.json`。`theme.ts` 在服务端生成 CSS 变量；OG/favicons 使用同源 token（Satori 不支持 CSS 变量）。应用中不得硬编码颜色，也不得使用带透明度的 hex；透明效果使用 `color-mix` 或 Tailwind token 透明度。

| token | 亮色（默认） | 暗色 |
| --- | --- | --- |
| background | #F6F4EF | #121110 |
| card / popover | #FFFFFF | #1A1917 |
| secondary / muted / accent | #EFECE5 | #22201D |
| border | #E2DED5 | #2E2B27 |
| input（控件边界） | #898174 | #777168 |
| foreground | #16130F | #F2EFE9 |
| muted-foreground | #6B655B | #A39E94 |
| primary（朱红） | #C4313B | #FF6B6F |
| primary-foreground | #FFFFFF | #16130F |
| success（成功绿） | #246B45 | #83CFA0 |
| warning（琥珀） | #875500 | #E4B663 |
| danger / destructive（酒红） | #7C2948 | #E4A0C0 |
| unknown（灰） | #6D675F | #AAA398 |

**朱红 primary 只用于品牌、链接、主按钮、选中态和编辑性排名序号，永远不表示状态。** 质量分数使用正文色；成功用 success，存疑用 warning，失败/不可用/假模型用偏紫酒红 danger，未检测用 unknown。徽章必须有文字/图标；失败可信徽章同时使用虚线边框和 ShieldSlash 图标，可用率失败格增加斜纹。错误提示使用 danger。destructive 仅用于删除、驳回等破坏性动作，不能用 primary。延迟曲线使用中性的 chart-1，不用品牌色或成功色暗示状态。

shadcn 的 accent 是交互悬停底色，和品牌 primary 含义不同；muted 是背景，次级文字必须使用 muted-foreground。ring=primary；chart-1..5 使用墨黑/中灰/蓝/靛/棕；sidebar-* 映射 card、foreground、primary、accent、border、ring。radius=0.75rem。旧领域变量 bg/panel/text/line/good/warn/bad 是对应规范 token 的别名，不另定义颜色。

`next-themes`：attribute=class、defaultTheme=light、enableSystem=false、storageKey=hub-theme。SSR 输出亮色；next-themes 在渲染内容前恢复保存的 .dark 类；head 内联脚本在首帧前恢复 class/data-theme，ThemeMeta 跟踪切换并更新 data-theme 和 theme-color。按钮图标由 CSS 类切换，避免 hydration 时错误闪动。字体继续使用本地 geist 包及 PingFang SC / HarmonyOS Sans SC / Noto Sans SC 回退，不使用 next/font/google。

## 对比度

执行 `node apps/web/scripts/check-contrast.mjs --save`。两主题 74 个组合全部通过，包括正文、次级文字、朱红链接、四色状态在背景/白面板/高层面板上的文字对比，主按钮与 hover、状态徽章浅底、厂商标记、控件边界。文字最低 **4.62:1**，控件边界最低 **3.26:1**。

| 组合 | 亮色 | 暗色 |
| --- | --- | --- |
| 正文 / 背景 | 16.85 | 16.44 |
| 次级文字 / 背景 | 5.25 | 7.07 |
| 朱红链接 / 背景 | 4.96 | 6.81 |
| 主按钮文字 / 主按钮 | 5.46 | 6.69 |
| 成功 / 背景 | 5.85 | 10.24 |
| 警告 / 背景 | 5.74 | 10.03 |
| 失败 / 背景 | 8.42 | 9.06 |
| 未知 / 背景 | 5.09 | 7.55 |

面板以边线与 3% 墨色阴影区分；控件边线单独使用 input token。表格使用克制的隔行底色/hover，弹窗、Toast、代码、骨架、滚动条均继承主题。

## 组件约定

初始化 shadcn/ui radix-nova，Tailwind v4，Phosphor 图标。通用组件放 `src/components/ui/`，类名用 `cn` 合并。禁止继续添加手写 btn/input/select/badge/tabs/panel/card/data-table/notice 类。旧 ui.tsx 已改为 page-kit.tsx，只保留 PageHead、Metric、Empty、StatusBadge、FormatDate 等领域组合，内部使用 shadcn。

- Button 的 default=primary，outline/secondary/ghost/link 为普通操作，destructive 为破坏性动作。
- Card / Table / Badge / Alert / Tabs / ToggleGroup / Select / Input / Textarea / Label / Checkbox / Switch 为唯一通用表现组件。Badge 扩展 success/warning/danger/unknown，默认 unknown。
- 模型和站点搜索使用 Command + Popover，模型显示 displayName 与厂商，URL/API 使用 slug。
- 表单使用 react-hook-form + zod + Form。Key 最少 8 位，编辑空值表示保留。配置保存额度提示用 Sonner；不要将保存成功误报失败。
- Dialog / AlertDialog 处理编辑、审核、确认删除；Sheet 处理移动导航和 Sidebar 移动模式；DropdownMenu 处理用户菜单；Tooltip 解释每格探测结果。
- Skeleton / Separator / Avatar / ScrollArea / Accordion 为统一加载、分隔、头像、滚动与 FAQ 组件。
- Sidebar 支持折叠、移动 Sheet，后台包含 Breadcrumb。延迟趋势、60 格探测条是领域专用 SVG/轻量组件，继承 chart/status token。

## 分页约定

所有增长型列表使用 `DataPagination`（shadcn Pagination + Select）：共 N 条、20/50/100、上一页/下一页、省略页码；390px 简化为第 x/y 页。页码是真实 a href，page/pageSize 同步 URL，过滤变化回到第一页。多列表用独立键 runsPage/runsPageSize、modelsPage/modelsPageSize 等，保留其他条件。榜单 rank 使用 API 返回的跨页连续名次。

服务端分页：公开榜单、站点目录、站点评价、探测记录 /channels/:id/runs、收藏、我的评价、通知；后台各 Paginated 接口、站长日志。数组接口（models、vendors、merchant/sites、admin/vendors、announcements 等）先过滤再用 slicePage，仍使用相同 URL 和分页组件。首页 Top3、固定对比不分页。

## 版式

内容最大宽 1320px，桌面边距 48px、移动 20px。品牌区块纵向 120–160px，数据页紧凑。榜单标题与副标题同排，筛选紧凑、更多条件折叠；数字 tabular-nums，行高 68px，表头 sticky 于导航下方。手机改卡片，表格不得撑宽文档。
