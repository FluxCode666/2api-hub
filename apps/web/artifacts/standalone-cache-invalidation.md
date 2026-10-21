# Standalone 公共页面缓存失效验证

- 时间：2026-10-21T17:55:47.340Z
- 服务：http://127.0.0.1:3210
- 页面：/sites/xinghe-api
- 结果：通过
- 仅通过同源 API 保存、删除独立临时评价，未修改代码或服务。

| 阶段 | HTTP | x-nextjs-cache | 临时评价 |
| --- | --- | --- | --- |
| warm | 200 | MISS | 无 |
| warm-confirm | 200 | HIT | 无 |
| first-read-after-save | 200 | MISS | 出现 |
| saved-cache-hit | 200 | HIT | 出现 |
| first-read-after-delete | 200 | MISS | 无 |
| deleted-cache-hit | 200 | HIT | 无 |

- 修改前FullRoute缓存HIT
- 保存评价后首次访问MISS且HTML立即出现；随后HIT保留
- 删除评价后首次访问MISS且HTML立即消失；随后HIT保持消失
- 临时评价全部清理，退出并清会话Cookie

测试账号随机密码未持久化，保留一个无评价数据的独立账号。报告不包含密码、Cookie 或 JWT。
