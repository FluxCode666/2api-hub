# 2API Hub 最终前端验收

2026-10-22，真实 API + worker + 可控 mock-upstream。桌面 1440×900，移动 390×844。

- `home-desktop.png` / `home-mobile.png`：导航后 373ms / 360ms 完成首屏截图，文字与 CTA 始终可见。
- `home-top3-*`：真正的模型 Top3 榜单区域；`home-activity-*`：最近探测动态。
- `rankings-*`：紧凑筛选、首屏七行、移动卡片。
- `guide-scoring-*`：八次方可用率公式与假模型 40 分上限。
- `verify-genuine-*` / `verify-fake-*`：100 / 31 分、八项检查。
- `merchant-report-*` / `admin-approved-*`：任务终态、审核通过；`success-chain.json` 记录审核后 54.6 秒产生定时探测。
- `flaky-*` / `dead-*`：抖动与失效场景；`scoring-display.json` 记录新公式下抖动渠道约 57 分，与 API 一致。
- `hero-visibility.json`、`motion-and-guide.json`：首屏时序、SSR 无 JavaScript、减少动态效果检查。
- `ratio-tasks.json`：最终倍率规则通过；historicalBehavior 仅为规则更新前的历史。
- `real-route-checks.json` / `seo-checks.json`：42 项路由和 25 项 SEO 检查全部通过。

截图和数值反映拍摄时刻，定时探测会继续更新；当前可复查站点 #15、渠道 #35 已上线，每 60 秒探测。API Key、Cookie 与测试账号密码不包含在证据中。
