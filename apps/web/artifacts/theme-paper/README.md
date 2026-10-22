# 纸白主题、shadcn 与分页验收

最终 typecheck/build、74 项对比度、Mock/真实模式各 42 项路由、25 项 SEO 均通过。真实 API 为 26 通过、0 失败、2 脚本跳过；浏览器另完成 genuine/fake 鉴定。详见 acceptance.json。

| 检查场景 | 亮色 | 暗色 |
| --- | --- | --- |
| 首页 Hero | light-home-hero.png | dark-home-hero.png |
| 首页 Top3 | light-home-top3.png | dark-home-top3.png |
| 榜单第一页 | light-rankings-top.png | dark-rankings-top.png |
| 榜单第二页 | light-rankings-page2.png | dark-rankings-page2.png |
| 失败格、疑似假模型 | light-rankings-status.png | dark-rankings-status.png |
| 抖动渠道 | light-flaky.png | dark-flaky.png |
| 公开鉴定 | light-verify-genuine.png / light-verify-fake.png | dark-verify-genuine.png / dark-verify-fake.png |
| 站长工作台 | light-merchant.png | dark-merchant.png |
| 站长渠道 | light-merchant-channel.png | dark-merchant-channel.png |
| 入驻向导 | light-onboarding.png | dark-onboarding.png |
| 管理审核 | light-admin-reviews.png | dark-admin-reviews.png |
| 管理日志第二页 | light-admin-runs-page2.png / light-admin-runs-page2-pagination.png | dark-admin-runs-page2.png / dark-admin-runs-page2-pagination.png |

移动 390px：light-mobile-home.png、light-mobile-rankings.png、light-mobile-rankings-page2.png、light-mobile-pagination.png。OG：og-home.png、og-model.png、og-site.png（均 1200×630）。全部目视检查；失败采用酒红文字、图标/虚线徽章与斜纹状态格，朱红仅用于品牌与交互。

主题首帧证据 theme-first-frame.json；分页交互 pagination-interactions.json；源码扫描 source-scan.json；生产路由 real-route-checks.json；SEO seo-checks.json；接口 api-integration-results.json。截图尺寸清单 screenshots.json。Ego TaskSpace 37 已关闭，未执行浏览器升级。
