# 真实 API 联调清单

运行环境为 Node 22。脚本直接访问 8711，不使用 mock；所有输出均不包含密码、JWT、Cookie 或检测 Key。

```sh
node apps/web/scripts/check-api-integration.mjs
```

仅检查公开读取、标准错误、种子普通用户登录和个人数据读取。API 不可达时返回退出码 2；用例失败返回 1；已运行用例全部通过返回 0。结果保存到同目录的 `api-integration-results.json` 和 `api-integration-findings.md`。

完整个人评价和前端代理联调：

```sh
HUB_INTEGRATION_WRITES=1 HUB_WEB_URL=http://127.0.0.1:3210 node apps/web/scripts/check-api-integration.mjs
```

写入检查会注册一个独立账号，验证收藏及 1–2 个站点评价的创建、更新、分页、越权删除和本人删除；脚本清理测试评价与收藏，保留一个无业务数据的注册账号。前端必须先关闭 `HUB_MOCK` 并连接同一真实 API。可用 `HUB_API_URL` 覆盖 API 地址；用 `HUB_INTEGRATION_EMAIL`、`HUB_INTEGRATION_PASSWORD` 覆盖种子普通用户凭据。脚本只检查 API，不请求 Web 页面路由。

站点列表与详情独立校验；若列表失败但渠道可用，会从 `channel.site` 取得站点完成详情与写入检查，并保留列表的失败结果。清理后再次读取个人评价和收藏，确认均为空。

| 范围 | 核对内容 |
| --- | --- |
| meta / vendors / models | 共享字段、nullable 值、模型详情、厂商模型列表 |
| sites / reviews | 分页、站点详情、公开评价结构 |
| channels | 价格、倍率公式、筛选、排序、空值排尾、跨页排名、批量对比 |
| history / reports | 4 个时间窗及桶大小、检查项、时间字段、60 格状态条 |
| rankings / announcements | 模型 Top3、启用公告 |
| go | 302、Location 为站点网址 |
| auth | HttpOnly / SameSite=Lax、真实 JWT 会话、401 / 403 |
| me/reviews | `Paginated<MyReview>`、`site` 与 `status`、分页、同站更新、只本人删除 |
| me/favorites / notifications | 收藏增删、通知读取/标记已读 |
| Next | 同源 API Cookie 透传、`/me/reviews` 真实分页响应 |
| verify / feedback | 未填写字段返回 400；实际鉴定单独启用 |

若要实际验证鉴定报告，可提供 `HUB_VERIFY_BASE_URL`、`HUB_VERIFY_API_KEY`、`HUB_VERIFY_MODEL` 与可选 `HUB_VERIFY_PROTOCOL`。只在配置后发起一次真实检测，最多等待 70 秒；Key 不写入报告。反馈的真实写入没有删除契约，因此默认仅验证输入错误，避免生成无法由普通用户清理的反馈。

当前共享契约的 `MyReview` 已直接被前端页面、组件与 mock 引用。前端使用 `GET /me/reviews?page=...&pageSize=...`、`DELETE /me/reviews/:id`；后端 `routes/me.ts` 路径及字段已对应。
