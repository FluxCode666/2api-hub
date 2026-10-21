# API 独立审查报告

审查日期：2026-10-22。审查对象为当前工作区的 `apps/api/**`、`packages/probe/src/ssrf.ts`、`packages/probe/src/http.ts`；同时阅读了 AGENTS、SPEC、shared 与 db 源码，并追踪了 probe 的错误脱敏调用链。未修改源码，未重置数据库，未停止现有进程。

结论：**建议修复后再上线。P0：0 项；P1：6 项；P2：7 项。** TLS 与公开错误脱敏直接涉及 API Key 安全；限频与入队控制可被绕过。以下只列确认存在或有明确代码依据的问题。

## P1

### 1. HTTPS 实际通过明文 TCP 发送认证头

- **位置**：`packages/probe/src/http.ts:74`、`:94`、`:95`。
- **问题**：自定义 undici connector 不区分 `http:` / `https:`，始终 `net.connect()` 并直接把普通 socket 交给 undici。设置 HTTPS URL 不会自动替换该 socket 为 TLS；没有 TLS 握手、证书验证或 SNI。真实 TLS 上游通常连接失败；能接收明文的服务或链路攻击者可以读取认证头及请求内容。公开鉴定、站长连接测试、发现模型均使用此层。
- **实测**：在独立进程中启动普通 `node:http` 服务，调用 `safeFetch({url: 'https://127.0.0.1:<临时端口>/tls-check', headers: {Authorization: 'Bearer review-dummy-only'}, allowPrivate: true})`。普通 HTTP 服务实际收到 `Authorization: Bearer review-dummy-only`，客户端返回 200 和 `plain-http-accepted`。`allowPrivate:true` 仅用于本地复现；connector 的明文行为与该开关无关。
- **建议**：保留 undici 默认 TLS connector，通过受控 lookup 固定已验证 IP；或对 HTTPS 使用 `tls.connect`，设置原域名 SNI、正常证书及主机名验证，完成握手后再回调。加入“HTTPS 不能被普通 HTTP 服务接收”和证书失败测试。

### 2. 上游回显的 Key 会落入 probe_runs，并通过公开接口泄露

- **位置**：`apps/api/src/routes/merchant.ts:462`、`:468`；`apps/api/src/lib/serialize.ts:88`；公开出口 `apps/api/src/routes/channels.ts:160`。相关来源：`packages/probe/src/index.ts:132`、`packages/probe/src/types.ts:79`。
- **问题**：错误脱敏只猜测 `sk-`、Bearer、AIza 和 JWT 等格式，没有按实际提供的 Key 做替换。自定义中转站完全可以使用其他格式的 Key；上游将其放进错误消息后，会原样返回并写入 `probe_runs.error_message`。公开历史接口所谓的脱敏只截取前 80 字符，仍保留短消息中的完整 Key。
- **实测**：审查专用渠道 36 使用虚构 Key `review_custom_token_20261022_dummy`，临时上游返回 401：`{"error":{"message":"invalid credential review_custom_token_20261022_dummy"}}`。站长 `/test` 响应包含完整 Key；站点通过审核后，无需登录的 `GET /channels/36/history` 也包含完整 Key。全过程未使用真实 Key。
- **建议**：在 probe 边界按实际 `target.apiKey` 对所有错误、sample、报告 detail/evidence 做精确脱敏，必要时处理编码变体；持久化前再次过滤。公开错误最好仅提供固定中文错误分类。对历史错误记录执行受控清理，检查已经暴露的真实凭据并轮换。

### 3. 无条件信任 X-Forwarded-For，可绕过全部按 IP 限频

- **位置**：`apps/api/src/app.ts:26`、`:45`；`apps/api/src/routes/public.ts:253`、`:315`。
- **问题**：`trustProxy: true` 信任所有来源的代理头；`req.ip` 同时用于全局 rate-limit、公开鉴定及反馈额度。任何可以直达 API、或能把未清洗头部带到 API 的客户端，都能通过更换 X-Forwarded-For 换一个限频身份。
- **实测**：真实 `/verify` 使用同一 `X-Forwarded-For: 198.51.100.25`，前 10 次为 200，第 11 次为 429；仅更换为 `192.0.2.25` 后立刻恢复 200。独立 `app.inject` 中，同一头部的第 601 次 `/healthz` 为 429，更换头部后的下一次为 200。
- **建议**：只信任明确的代理地址/网段或可信跳数；入口代理覆盖客户端提交的转发头；直接访问 API 时按 socket 地址限频。部署和应用两侧都应限定该信任边界。

### 4. /verify 完成后才记额度，并发请求可突破每小时限制

- **位置**：`apps/api/src/routes/public.ts:254`、`:275`、`:295`。
- **问题**：流程是“查询已有记录 → 执行昂贵鉴定 → 插入记录”。执行中的请求不占额度，没有事务锁、原子计数或并发上限。同一 IP 可以同时启动任意多个检测，独立于问题 3 的代理头绕过；不产生记录的异常路径还会继续保留额度。
- **实测**：临时上游延迟 300ms 后返回固定 401。同一个新 IP `198.51.100.233` 同时发送 12 个有效 `/verify` 请求，结果 **12 个均为 200**；配置上限为 10。该场景只触发虚构凭据的本地请求。
- **建议**：检测开始前原子预留额度，使用数据库原子计数/锁或共享限流存储；预留时覆盖执行中的请求，并明确失败请求是否退还额度。为公开鉴定增加全局和单 IP 并发上限。

### 5. 站长检测额度非原子，修改 Key 还能直接绕过额度和入队去重

- **位置**：`apps/api/src/routes/merchant.ts:382`、`:415`、`:558`、`:569`；其他不去重入口：`:318`、`apps/api/src/routes/admin.ts:305`。`packages/db/src/schema.ts:217` 的任务表也没有活动任务唯一约束。
- **问题**：手动检测先 count 再 insert，存在并发竞态。已上线渠道 PATCH 则直接入队，不经过每日额度检查；只要传入非空 `apiKey` 就视为变化，即使与原 Key 相同。各入口均不会复用已有 queued/running 任务，能重复制造消耗额度的真伪检测。
- **实测**：审查专用渠道 36 的每日上限为 3；6 个同时发出的 `/authenticity` 请求全部返回 202、产生不同任务 ID。随后连续 4 次 PATCH 相同虚构 Key 全部为 200，又新增 4 个任务。只读 SQL 确认该渠道已有 **10 个 trigger=merchant/kind=authenticity 任务**，另有 1 个 onboarding 任务。
- **建议**：把额度、活动任务去重和插入封装为所有调用方共用的原子入队操作；对 channel 加锁，或为活动任务设置符合业务语义的部分唯一约束。配置变更应合并已有待执行任务；同 Key 不应生成新任务，自动检测也应有明确的防滥用策略。

### 6. API 生产容器只监听回环地址，web 容器及端口映射无法访问

- **位置**：`apps/api/src/index.ts:10`；使用入口：`apps/api/Dockerfile:32`，部署关联 `deploy/docker-compose.prod.yml:106`。
- **问题**：生产 Dockerfile 同样启动此入口，但监听地址固定为 `127.0.0.1`。容器内 healthcheck 可以成功，其他容器访问 `http://api:8711` 以及宿主机映射端口却不会命中该 listener。生产公开站会整体出现 API 连接错误。
- **触发场景**：按现有 compose 启动 api/web，api 自身 healthcheck 通过，web 请求 `http://api:8711/healthz` 失败。此结论来自明确的监听地址与 bridge 网络配置；本次没有启动或重启生产容器。
- **建议**：监听地址从环境变量读取，容器设置 `0.0.0.0`；本地开发可继续设置回环地址。健康检查应增加从 web 网络命名空间访问 API 的检查。

## P2

### 7. 按模型查榜单时一对多 JOIN 造成同一渠道重复上榜

- **位置**：`apps/api/src/lib/channelList.ts:99`、`:148`、`:169`、`:194`。
- **问题**：同一渠道允许多个 `upstream_name` 映射同一个 `model_id`，唯一约束只限制 `(channel_id, upstream_name)`。按目录模型连接时，每个别名都生成一条榜单行，导致 total、rank、分页和首页 Top3 错误；覆盖价不同还会让同一渠道以多个价格占榜。
- **实测**：种子数据 `GET /channels?model=gemini-3.8-flash&pageSize=100` 返回 `total=4`、ID `[6,6,17,17]`、rank `[1,2,3,4]`，实际只有 2 个渠道。审查专用单渠道同样返回两行 `[36,36]`。
- **建议**：先确定每个渠道用于该目录模型的一条报价映射（例如主测别名优先，再按明确价格规则），用 lateral 子查询或窗口函数缩减到一行后 count/sort/page。不能仅对最终结果做内存去重。

### 8. 会话 Cookie 在生产中也缺少 Secure

- **位置**：`apps/api/src/plugins/auth.ts:52`。
- **问题**：设置了 HttpOnly、SameSite=Lax 和 7 天 Max-Age，但没有 Secure。生产 HTTPS 登录生成的会话同样可被浏览器附加到同域 HTTP 请求；在没有预加载 HSTS 等额外保证时，会话可能在明文链路暴露。
- **实测**：新注册用户的 Set-Cookie 属性为 `Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`，没有 Secure。代码中也不存在生产环境分支。
- **建议**：生产环境强制 Secure，本地 HTTP 开发允许关闭；清理 Cookie 时保持属性一致，并配合入口 HTTPS/HSTS。

### 9. /go 的跳转 URL 没有 http/https 白名单

- **位置**：`apps/api/src/routes/merchant.ts:31`、`:32`、`:286`；`apps/api/src/routes/public.ts:347`。管理员输入同样见 `apps/api/src/routes/admin.ts:245`。
- **问题**：`z.string().url()` 接受 `javascript:` 等绝对 URL。站长能在审核通过后修改官网或邀请链接，跳转接口再将其原样写进 Location，缺少使用时的协议校验。这里确认的是危险跳转协议被接受，不声称现代浏览器一定执行 javascript 302。
- **实测**：新建审查站点时提交 `inviteUrl: 'javascript:alert(1)'` 被接受；审核通过后 `GET /go/36` 返回 `302`，Location 精确为 `javascript:alert(1)`。复现后已将该邀请链接恢复为 `https://example.com`。
- **建议**：站点 URL 写入及 `/go` 使用时都只允许 http/https，拒绝 URL 凭据和控制字符。外部导航本身属于产品功能；本问题不是要求跳转只限本站域名。

### 10. 关闭注册设置不会阻止注册

- **位置**：`apps/api/src/routes/auth.ts:37`；配置入口 `apps/api/src/routes/admin.ts:809`。
- **问题**：后台可保存 `site.allowRegistration=false`，但注册处理函数从未读取该配置，直接创建用户。管理员关闭注册后仍可继续批量注册和创建入驻资源。
- **触发场景**：将该设置设为 false 后提交合法的新邮箱注册，处理逻辑没有任何分支拒绝。此问题通过完整调用链确认；为避免更改其他使用者的全局设置，本次未实际切换该值。
- **建议**：注册开始时读取有效设置，关闭时返回清晰的 403/业务错误；登录不受此设置影响。

### 11. 更新渠道时 apiKey 空字符串违反“留空不修改”的契约

- **位置**：`apps/api/src/routes/merchant.ts:54`、`:380`；契约 `packages/shared/src/contract.ts:499` 的 `ChannelInput.apiKey`。
- **问题**：共享契约和 SPEC 约定更新时 Key 留空表示不修改；`partial()` 只允许字段缺失，不移除 `min(1)`。编辑表单按契约发送 `apiKey:''` 会整体更新失败。
- **实测**：对审查专用渠道 36 PATCH `{"apiKey":""}`，返回 400 `validation_error`，问题字段为 apiKey，minimum=1。
- **建议**：区分创建与更新 schema；更新时把空字符串归一为 undefined，创建继续要求非空 Key。管理编辑若采用相同交互也需同步处理。

### 12. 站长详情为取得每渠道最新报告，读取该站所有历史报告到内存

- **位置**：`apps/api/src/routes/merchant.ts:250`、`:256`。
- **问题**：查询按渠道集合筛选并排序，却没有 LIMIT/每组取一；随后 JS Map 丢弃同渠道的历史报告。报告包含 checks/evidence JSON，随着日常检测不断增长，详情请求的数据库传输量和 Node 内存占用都随全部历史报告数增长。已有 `(channel_id, created_at)` 索引不能消除读取所有结果的成本。
- **触发场景**：一个站点每个渠道有数千份历史报告，打开一次站长站点详情就加载这些报告，但响应每渠道仅使用其中一份。此结论为代码确认，本次未向共享库灌入大量历史数据。
- **建议**：使用 `DISTINCT ON(channel_id) ORDER BY channel_id, created_at DESC, id DESC` 或 lateral LIMIT 1，在数据库内只取每渠道最新报告，利用已有索引。

### 13. 渠道详情依赖同站前 100 名列表，超过 100 个渠道时合法详情返回 404

- **位置**：`apps/api/src/routes/channels.ts:75`、`:76`、`:77`。
- **问题**：已经按目标 ID 读取渠道后，却再查该站点推荐排序前 100 个渠道，再用 `.find(id)` 取目标；排在第 101 名以后的 active 渠道会被误判为下线。创建渠道没有站点 100 条上限，因此这是可达的业务规模边界。
- **触发场景**：一个上线站点有 101 个 active 渠道，访问同站推荐排序第 101 个渠道详情，尽管榜单后续分页可查到该渠道，详情仍返回 404。
- **建议**：详情直接用 `queryChannels({ids:[id], page:1, pageSize:1})` 或专门的单渠道查询。不要让单资源读取依赖列表的第一页。

## 验证及审查边界

- `pnpm --filter @hub/api typecheck` 通过。未运行 `apps/api/test/api.test.ts`：其 beforeAll 会 TRUNCATE 共享业务表，afterAll 会重新 seed，不符合本次约束。
- 写操作仅围绕新注册用户 `review-1792604975442@example.com`、专用站点 16、渠道 36 和本次公开鉴定记录。管理员种子账号只用于登录和审核该专用站点。复现结束已修正危险邀请链接并将专用站点下架，保留其记录供复核；本次启动的临时 HTTP 服务均已关闭。
- 已确认用户访问他人站点返回 404、非管理员访问管理总览返回 403；各管理路由均调用 `requireRole(admin)`。站点/渠道/任务归属检查明确；站长 PATCH 使用白名单，未发现 ownerId/status/role mass assignment。
- JWT 使用 jose 验签并验证有效期，请求重新从库读取 active 状态及角色。登出按 SPEC 清除 Cookie；它没有撤销已签发 JWT，因此复制出的 token 仍可用到过期，这是当前无状态会话设计的边界，不另外计为违约问题。
- 未发现基于请求参数的 raw SQL 字符串拼接注入；排序列、方向和历史时间窗均来自白名单。榜单主要在 SQL 中筛选/排序/分页，NULLS LAST 和跨页 rank 公式正确，报价 COALESCE 优先覆盖价。问题 7 的 JOIN 重复会破坏这些正确公式的最终结果。
- SSRF：未开启放行开关时，已实测阻止回环、十进制/八进制/十六进制 IPv4、IPv6 回环和 IPv4-mapped 回环、RFC1918 与链路本地地址。请求不自动跟随重定向，连接回调对重新解析的 IP 再做检查，未发现 DNS rebinding 直接绕过私网检查的证据。未设置环境变量时默认不放行；`.env.example` 开发值为 true，生产模板/compose 默认 false。未将显式开发放行作为生产默认漏洞报告。
- 榜单没有推荐分/可用率等排序索引，计算倍率/价格排序也需要表达式计算；当前规模下未做性能阈值推断。未把正常小表排序或已有索引覆盖的查询凑成独立性能问题；问题 12 是确认存在的无界读取。
- 本报告基于工作区现场版本，包括审查开始前已有的未提交修改；没有回退或改写其他协作者的文件。

## 总评

基础权限和 SQL 参数化比较完整，入驻提交及审核操作也有明确的顺序状态检查。但当前版本不能直接生产上线：应优先修复 TLS、Key 泄露、代理信任及原子限频/入队，同时解决容器监听问题。随后修复重复榜单与契约边界，并使用隔离数据库补充这些回归场景；现有测试通过不足以覆盖本报告中的风险。

## 修复记录（Kimi，2026-10-22）

| # | 状态 | 说明 |
| --- | --- | --- |
| 1 | 不属本范围 | probe 库 TLS 问题由 GLM-A 修复（`packages/probe` 不属 `apps/api` 范围）。 |
| 2 | 已修（API 侧） | 写入 `probe_runs.error_message` 前用渠道真实 Key 精确替换（`sanitizeKeyFromText`，含 URL 编码变体）；公开接口改为 errorCode 映射固定中文分类；一次性清理脚本 `apps/api/src/clean-error-messages.ts` 已跑（更新 1 行）。probe 边界的 sample/detail/evidence 脱敏由 GLM-A 负责。 |
| 3 | 已修 | `trustProxy` 从 `TRUST_PROXY` 环境变量读取（默认 false；支持 `loopback`/`linklocal`/`uniquelocal`/具体网段）。`.env.example`、`deploy/prod.env.example`、compose 已更新。 |
| 4 | 已修 | `/verify` 事务内先插入 pending 记录再计数（原子预留额度）；单 IP 并发上限 1、全局并发上限 4；失败退还预留额度（删除占位记录）。 |
| 5 | 已修 | 抽出所有入口共用的 `enqueueProbeTask()`：`SELECT ... FOR UPDATE` 锁渠道行、同一 channel+kind 已有 queued/running 时直接复用、站长手动触发在同一事务内检查每日额度。PATCH 时仅 Key/baseUrl/protocol/primaryModel 真实变化才入队（解密旧 Key 比较）。新增部分唯一索引 `probe_tasks_active_uq`（增量迁移 0001，已记录 CONTRACT-CHANGES）。 |
| 6 | 已修 | 监听地址从 `API_HOST` 读取（默认 127.0.0.1）；Dockerfile 与 compose 设 `0.0.0.0`。worker 8713 与 mock-upstream 8712 有同样问题，已在 handoff 注明由 GLM-B / GLM-A 修。 |
| 7 | 已修 | 按模型查榜单改用 lateral 子查询，每渠道只取一行（主测模型优先 → 有覆盖价 → 价格最低）；count/sort/page 前去重。测试覆盖。 |
| 8 | 已修 | 生产环境（`NODE_ENV=production` 或 `COOKIE_SECURE=true`）cookie 自动加 Secure。 |
| 9 | 已修 | 站点/渠道 URL 写入与 `/go` 跳转都只允许 http/https（`httpUrl()` zod 校验器）。 |
| 10 | 已修 | 注册前读 `site.allowRegistration`，关闭返回 403 `registration_closed`。 |
| 11 | 已修 | `apiKey: ''` 经 zod transform 归一为 `undefined`（留空不修改）；创建仍要求非空。 |
| 12 | 已修 | 站长站点详情最新报告用 `DISTINCT ON (channel_id) ORDER BY channel_id, created_at DESC, id DESC` 在数据库中取。 |
| 13 | 已修 | 渠道详情改为 `queryChannels({ids:[id], page:1, pageSize:1})` 按 id 直查，不再依赖站点前 100 名列表。 |

**测试改为独立测试库 `hub_test`**（`CREATE DATABASE hub_test` + migrate），不再 TRUNCATE 开发库。`pnpm --filter @hub/api typecheck` 通过；19 个测试全通过（含 #7 去重、#5 入队复用、PATCH 同 Key 不入队）。
