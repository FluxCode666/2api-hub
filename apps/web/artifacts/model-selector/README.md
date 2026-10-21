# 模型筛选名称修复验收（2026-10-22）

共用模型选择框展示目录 displayName，旁边显示厂商色点，候选项包含厂商名称；筛选 URL 与 API 始终使用模型 slug。支持输入名称或 slug、清空、300ms 防抖和浏览器后退；未匹配目录的搜索草稿不写入 URL，离开输入框恢复当前选中名称。模型详情页保持只读锁定。

`pnpm --filter @hub/web typecheck` 通过。ego-browser TaskSpace 34，真实 API 模式检查：

- 直接进入 `/rankings?model=claude-opus-5-5`、刷新、从模型详情「打开完整筛选」跳转均显示 Opus 5.5，URL 保留 claude-opus-5-5。
- `/models/claude-opus-5-5` 的锁定模型框显示 Opus 5.5。
- `/vendors/anthropic?model=claude-opus-5-5` 正确显示；选择 Sonnet 5.5、后退、清空、输入 slug 均保持厂商限制及正确模型名称。
- 1440×900 桌面和 390×844 移动端截图已目视检查，移动端无文档横向溢出。

截图：`rankings-desktop.png`、`rankings-mobile.png`、`model-desktop.png`、`vendor-desktop.png`。页面值与 URL 证据：`direct.json`、`reload.json`、`model-locked.json`、`browser-checks.json`。Ego Lite 提示有可用更新，未升级。
