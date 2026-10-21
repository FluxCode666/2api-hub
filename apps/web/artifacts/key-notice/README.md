# API Key 与额度提示验收

真实 API / worker / mock-upstream，2026-10-22。

- `browser-validation.json`：公开鉴定、站长新建/编辑、管理员编辑的短 Key 拦截，统一中文错误；8 位边界和编辑留空允许。
- `browser-notice.json`：真实浏览器 PATCH 返回 200，经过 Next 同源代理读取到 rate_limited 提示头，页面显示「配置已保存，但今日自动检测额度已用完，本次未重新检测。」
- `merchant-notice-desktop.png`：提示与渠道状态的实际截图。
- `real-api.json`：独立站点 #66 / 渠道 #130 的三次手动检测和队列终态，无额外入队。
- `cleanup.json`：空草稿已删除，额度测试站点验收后下架，未启用定时探测。此前 #15/#35 的成功链资源未改动。

测试只用本地 mock 的虚构 Key；证据不包含明文 Key、Cookie 或账号密码。

本轮 `pnpm --filter @hub/web typecheck` 与真实 API `build` 均通过，详见 `build.log`；3210 已恢复真实开发模式。Ego TaskSpace 32 已结束。
