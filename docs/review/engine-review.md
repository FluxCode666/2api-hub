# 第二轮审查：检测引擎、worker 与 API 修复回归

审查日期：2026-10-22。范围：`packages/probe/**`、`apps/worker/**`、`apps/mock-upstream/**`，以及上一轮 API P1 #2–#6。结论基于工作区现场源码、数据库只读抽样、独立验证进程和自建测试资源。共确认 **P0 0 项、P1 9 项、P2 7 项**。

## P1

### 1. Key 脱敏仍有长度门槛和截断顺序漏洞

- **位置**：`packages/probe/src/types.ts:94`、`:97`；`packages/probe/src/index.ts:143`、`:169`、`:249`；`apps/worker/src/probes.ts:43`；`apps/api/src/lib/sanitize.ts:12`。
- **问题**：probe 只精确替换长度 ≥8 的 Key，API 的补充替换也跳过长度 <4 的 Key，而输入契约接受非空短 Key。错误文本和 sample 又先截断、后脱敏，完整 Key 跨越截断边界时精确匹配失效。worker 直接将 probe 的错误写入 `probe_runs`，没有额外保护；discovery 错误也会进入任务 error 和失败通知。
- **复现**：本地上游返回 HTTP 401、正文 `custom key xyz12 rejected`，`probeAvailability` 返回同样的明文。对自建渠道 105 调用 worker 的 `executeProbe` 后，数据库 `error_message` 确实保存 `rejected custom key xyz12`。API 连接测试使用 3 字符虚构 Key `abc` 时，响应及该列均含明文；5 字符、25 字符 Key 经 API 补充处理后不泄露。另用正文 `x.repeat(290) + LONGDUMMYSECRET1234567890`，返回的错误留下 `LONGDUMMYS`，验证了先截断造成的前缀泄露。
- **建议**：对所有允许输入的 Key 做精确替换；完整文本先脱敏再截断，sample/detail/evidence/模型发现错误统一走同一出口；持久化和日志边界再做防御。不要用“短 Key 避免误伤”替代保密要求；若产品禁止短 Key，应在所有输入端明确拒绝。

### 2. 定时探测的锁没有重新判断到期条件，多 worker 会重复探测

- **位置**：`apps/worker/src/scheduler.ts:70`、`:75`、`:125`、`:128`。
- **问题**：到期扫描在事务外执行；真正 `FOR UPDATE SKIP LOCKED` 时仅按先前扫描出的 ID 过滤，不重新检查 `next_probe_at`、渠道状态或站点状态。SKIP LOCKED 只跳过“当前仍被锁住”的行，不能防止另一实例在前一实例提交后用旧扫描结果再次领取。
- **复现**：A、B 先读到同一组到期 ID；A 领取并提交后，B 才调用领取函数。对自建渠道 105 在回滚事务内实测：第一次返回 `[105]`，数据库已确认 `next_probe_at > now()`，第二次传入同样 ID 仍返回 `[105]`。这也证明领取函数会接受已不满足扫描状态的渠道。
- **建议**：将到期筛选、站点/渠道状态检查、行锁和领取更新放在同一条原子 SQL/事务中，并在锁定阶段保留完整谓词；为正在执行的探测增加可识别的租约或持久任务。

### 3. 任务回收与退出缺少实例所有权，旧执行者可以覆盖新执行者

- **位置**：`apps/worker/src/index.ts:79`、`:82`、`:127`；`apps/worker/src/tasks.ts:73`、`:105`、`:117`、`:126`。
- **问题**：退出 SQL 声称归还“本进程领取”的任务，实际归还所有最近启动的 running 任务。超时回收也只有 `started_at`，没有心跳、执行实例或 lease token；`excludeIds` 没参与 WHERE。任务完成/失败更新仅按 ID，不验证当前领取代次。长任务尚在运行时被回收后，可以被另一实例再次执行；旧实例随后还能把新实例的状态改为 done/queued/failed，并重复写报告和通知。
- **触发场景**：A 没有在执行的任务，正常退出；B 正在执行一个刚领取的任务，A 仍会把它改回 queued，C 即可再次领取。另一个确定可达场景是多模型任务运行超过默认 10 分钟：允许一次传 20 个模型，而每个模型包含多个串行请求和重试。单条领取 SQL 本身原子正确，问题发生在领取之后的生命周期。
- **建议**：记录 worker ID、lease token/代次及心跳；回收仅处理过期 lease，所有完成和副作用写入验证 lease。退出只归还本实例持有的任务，并先取消或等待对应执行者。报告/通知增加幂等约束；重试次数条件也应进入原子领取语句。

### 4. 一个没有可用性样本的渠道即可中断全站聚合

- **位置**：`apps/worker/src/aggregate.ts:100`、`:167`、`:173`、`:219`；`packages/db/src/schema.ts:257`。
- **问题**：聚合 CTE 按 `probe_runs` 分组，无 availability 记录的渠道没有分组行。LEFT JOIN 后 `samples_24h` 是 NULL，代码原样写入 NOT NULL 列；SQL 显式写 NULL 不会使用默认值 0。异常中断整个循环，后续渠道及 `site_stats` 不再更新。聚合包含草稿站点的渠道，注册用户创建一个尚未测试的渠道即可触发；长期无样本且历史已清理的渠道也会触发。
- **复现**：新建自有站点 53、渠道 105，未测试时查询得到 `samples_24h: null`。在事务内调用真实聚合路径，仅保留该自建渠道的输出行，写入报 PostgreSQL `23502: null value in column "samples_24h" ... violates not-null constraint`。验证事务已回滚，没有重写其他渠道统计。
- **建议**：SQL 中 `COALESCE(agg.samples_24h,0)`，应用层同步防御；无样本 uptime/延迟/推荐分保持 null。增加真正从零条 `probe_runs` 开始的集成用例；现有 fakeRow 测试手动填 0，绕过了出错的 JOIN。

### 5. worker 测试会改写开发库中的真实队列和统计

- **位置**：`apps/worker/test/setup.ts:9`；`apps/worker/test/tasks.test.ts:46`、`:49`、`:54`、`:88`；`apps/worker/test/scheduler.test.ts:114`；`apps/worker/test/aggregate.test.ts:91`。
- **问题**：测试读取根 `.env`，没有独立测试库或库名保护。tasks 测试把库里全部 queued 任务改成 running，结束后又无条件改回 queued；并发真实 worker 可能回收、执行这些任务，测试清理还会覆盖执行期间发生的合法状态变化。scheduler 测试调用的 tick 扫描全库到期渠道，mock 成功结果可被写入非测试渠道；aggregate 测试会重算全库统计。通知清理按正文 LIKE 匹配，也不限测试资源。
- **触发场景**：开发服务运行时执行 `pnpm --filter @hub/worker test` 即可进入上述路径；测试异常退出时无法保证 afterAll 恢复。此项由完整调用链确认，本轮没有运行该套件。
- **建议**：使用隔离测试数据库并强制检查目标库名；创建独立测试用户和资源，禁止隐藏或恢复全库任务。调度与聚合的集成测试也必须使用同一个隔离库，不能只清理测试创建的站点。

### 6. quick 真伪检测没有 60 秒总预算，串行请求和重试持续占用执行槽

- **位置**：`packages/probe/src/index.ts:200`、`:214`、`:614`、`:629`、`:699`、`:709`、`:738`；`packages/probe/src/http.ts:155`、`:160`。
- **问题**：`timeoutMs` 每次子请求重新计时，`startedAll` 只用于统计耗时，没有共享截止时间。reasoning 的局部预算仅在开始下一题时检查；退避等待也不受总预算约束。API 传入 `quick:true, timeoutMs:60000` 不会形成 60 秒总超时。入口 DNS 查询又位于 timeout signal 创建之前。公开请求和 worker 任务可远超约定时长，并加剧任务回收重复执行。SPEC 要求的独立 20 秒 TTFT 超时也没有实现。
- **复现**：独立上游每个请求 13 秒后返回有效 SSE，所有请求都小于所传 30 秒单次超时。调用 `probeAuthenticity(...,{quick:true,timeoutMs:30000})`，实际完成 **65,031ms**，发出 5 个子请求并返回报告，超过 SPEC §4.4/§5.0 的 60 秒上限。另以 80ms 参数、每次约 40ms 的响应，实测总耗时 253ms、6 个请求。
- **建议**：调用入口创建总 deadline 和组合 AbortSignal，DNS、所有子请求、读取及重试等待共享剩余预算；quick 上限强制为 60 秒。增加独立 TTFT 计时，预算耗尽时停止后续检查并给出未执行状态，避免误判为模型能力失败。

### 7. API 入队事务使用事务外连接，首次并发请求可耗尽连接池并挂起

- **位置**：`apps/api/src/lib/enqueue.ts:36`、`:54`、`:56`、`:73`。
- **问题**：事务持有渠道行锁后，调用 `merchantDailyLimit(db)`，使用外层 db 重新获取连接，而不是使用当前 tx。连接池满时，持锁事务等待空闲连接，其他事务占着连接等待它释放渠道锁，形成连接池层面的循环等待；PostgreSQL 看不到完整等待环，不能自动按数据库死锁解除。
- **复现**：使用自有账号、渠道 105，在无活动任务时，对独立 `buildApp()` 同时注入 12 个手动检测请求，请求全部挂起。`pg_stat_activity` 确认该验证进程的 10 条连接中，1 条 idle in transaction、停在活动任务查询之后，9 条阻塞在 `SELECT id FROM channels WHERE id=$1 FOR UPDATE`。持锁事务没有连接可用于查询 settings。仅结束本次独立验证进程后，事务释放；没有终止既有 API 或 worker 服务。
- **建议**：`merchantDailyLimit` 接受并使用 tx，事务内所有查询共用同一连接；设置合理的事务/锁等待超时作为保护。覆盖“无现存活动任务、并发数超过连接池容量”的回归场景；仅测试复用已存在任务无法发现此问题。

### 8. API `/verify` 全局并发检查与占位分离，上限 4 实际可被突破

- **位置**：`apps/api/src/routes/public.ts:255`、`:259`、`:272`、`:295`。
- **问题**：先检查 `verifyInFlight`，经过 settings 查询和预留事务等多个 await 后才递增。多个不同 IP 的请求可以同时通过旧计数检查，再各自进入探测。单 IP Set 无法阻止这个场景；多 API 实例之间的内存计数也互不共享。
- **复现**：独立 `buildApp()`，6 个不同 remoteAddress 同时请求自己启动的延迟 401 上游。6 个请求均返回 200 鉴定报告，上游实际观察到 **maxActive=6、hits=6**，超过常量 4。同 IP 的对照组 12 个并发仅发出 1 次上游请求，其余返回 429，因此不是代理头信任导致的结果。
- **建议**：使用在第一个 await 之前同步占位的 semaphore，并在统一 finally 释放；如果承诺部署级全局上限，使用共享令牌机制。每 IP 小时额度的 insert/count 在多实例部署时也需按 IP 串行化，不能仅依赖进程内 Set；本次单实例回归不证明其跨实例原子性。

### 9. API 修改连接配置的自动检测仍绕过站长每日额度

- **位置**：`apps/api/src/routes/merchant.ts:431`、`:432`；`apps/api/src/lib/enqueue.ts:51`、`:72`。
- **问题**：PATCH 触发同样的 `trigger='merchant', kind='authenticity'` 任务，但没有传 `checkMerchantDailyLimit:true`。唯一索引只限制同时活动的任务；上一任务完成后，真实修改 Key/baseUrl/primaryModel 等可继续入队，绕过手动入口额度。
- **复现**：自有渠道完成 merchant 任务 81、82、83 后，手动检测返回 429。恢复自有站点上线并 PATCH 一个不同的虚构 Key，接口返回 200，新增第 4 条 merchant authenticity 任务 **84（queued）**。同时验证相同 Key 连续 PATCH 12 次不会新增任务，这部分原修复有效。审查期间倍率变更已被其他协作者调整为不触发检测，本结论按最终代码重新用真实 Key 变化复现。
- **建议**：额度规则放到统一入队函数内，根据 trigger/kind 自动执行，避免每个调用点依赖可选布尔参数。若连接更新确需独立额度，明确独立预算和冷却时间，不能无限制触发同一种昂贵检测。

## P2

### 10. 多模型任务对每个模型都使用列表中同一个目录提示

- **位置**：`apps/worker/src/tasks.ts:177`、`:181`。
- **问题**：循环变量为 `model`，查找却使用 `models.includes(h.slug)`。只要列表含多个目录模型，每轮都得到目录中第一个被列表包含的条目，使用错误的 vendor/tier/expectedTps；同厂商不同档位也受影响。别名没有经过目录匹配。
- **触发场景**：一次检测包含 OpenAI 和 Anthropic 模型，两者会拿到同一个 hint，后者或前者的 token_count、knowledge、reasoning 标准、speed 随之出错。此结论直接由循环和谓词确认。
- **建议**：按当前 `model` 调用 `matchCatalogModel`，再用匹配 ID 读取 hint；为混合厂商、混合档位及别名列表验证各次调用收到的提示。

### 11. 能力检查请求对真实 Anthropic / Responses API 不合法

- **位置**：`packages/probe/src/index.ts:560`、`:562`、`:574`、`:588`；`packages/probe/src/adapters.ts:193`。
- **问题**：Anthropic 请求同时使用 `max_tokens=256` 和 `thinking.budget_tokens=1024`，预算必须小于 max_tokens，这类请求会被真实接口拒绝。Responses 直接复用 Chat Completions 的 `{type:'function',function:{name,...}}` 工具定义，而 Responses 需要顶层 `name/parameters`；适配器没有转换。检测器自己的非法参数会让真实模型的 capability 被扣分。
- **触发场景**：完整（非 quick）检测走到 capability。mock 只检查 tools 非空或 thinking 是否存在，不校验这些约束，因此 mock genuine 通过无法证明真实协议兼容。
- **建议**：按协议分别构造工具定义；Anthropic 保证合法 thinking/max_tokens 预算，并按待测模型支持情况选择能力检查。增加会拒绝错误字段结构和预算的严格 mock/契约测试。

### 12. 流式解析缺少失败终态和运行时结构校验，异常流可成功或直接抛错

- **位置**：`packages/probe/src/index.ts:150`、`:156`、`:681`；`packages/probe/src/adapters.ts:269`、`:410`、`:605`；`packages/probe/src/match.ts:12`。
- **问题**：成功只看累计文本或 `toolCalls !== null`，忽略流内失败、truncated 和空工具数组。JSON.parse 后只用 TypeScript 断言，没有验证 model/id/usage 等字段的运行时类型；不可信对象可离开请求捕获层，令后续评分抛错，违背“永不抛异常”契约。
- **复现**：四协议分别先返回 `pong`，再返回 OpenAI error、`response.failed`、Anthropic error、Gemini error，全部实测 `success:true,errorCode:null`。仅返回 `tool_calls:[]`、无文本也成功。另返回 `{"id":42,"model":42,"choices":[{"delta":{"content":"pong"}}],"usage":{"prompt_tokens":5,"completion_tokens":1}}` SSE，quick 检测直接抛 `TypeError: name.trim is not a function`。
- **建议**：对每种协议事件验证字段类型和有限非负 token 数，显式记录失败终态；可用性按 SPEC 要求非空文本，能力探测另用工具调用判定。异常/截断流返回 invalid_response 等确定结果，并在异常路径 cancel/release reader；报告出口增加兜底，防止上游字段导致未捕获异常。

### 13. worker 的任务探测绕过并发限制，配置的全局/单站预算不成立

- **位置**：`apps/worker/src/index.ts:55`、`:57`、`:123`；`apps/worker/src/tasks.ts:139`、`:182`；`apps/worker/src/scheduler.ts:157`。
- **问题**：limiter 只交给定时 scheduler，任务循环另有固定并发 2，执行 authenticity/discovery/availability 时不获取同一限制。一个站点可同时有 2 个定时探测及 2 个任务，超过配置的单站点 2；每实例可超过“全局 8”，多实例继续叠加。另外定时探测 timeout 硬编码 30 秒，启动时读取的 `probe.timeoutMs` 只传给任务；settings 运行期间也不刷新。
- **触发场景**：某站已有定时探测占满单站额度，同时领取该站多个渠道的任务；任务仍直接开始网络调用。通过入口及依赖传递链确认，未向运行服务施加饱和负载。
- **建议**：所有对外请求统一经过站点和全局预算，明确预算是进程级还是部署级；调度器使用有效 timeout 配置，设置修改应有刷新或明确重启语义。

### 14. 已领取定时探测只保存在内存，拥塞及退出会丢本轮任务

- **位置**：`apps/worker/src/scheduler.ts:64`、`:75`、`:83`、`:92`；`apps/worker/src/index.ts:75`。
- **问题**：先推进 next_probe_at，再尝试执行或放入容量 200 的内存 pending。队列满时没有持久记录、没有回退 next_probe_at，直接丢弃；进程退出也不等待 scheduler 的在途探测，只等待 inFlightTasks。pending 队首站点满时直接 break，其他站点即使有可用并发也无法补位。
- **触发场景**：上游缓慢、同一站点大量渠道到期时积压超过 200，后续已领取渠道本轮不发请求；下次扫描要等到已推进的间隔之后。正常退出时，pending 及未完成定时请求同样丢失。由领取和派发路径确认。
- **建议**：持久化待执行探测并使用 lease；或者只领取当前能执行的容量，失败派发时归还领取状态。退出追踪并等待/取消全部网络任务；pending 应能跳过暂时满额的站点，并暴露积压和丢弃指标。

### 15. 可用性探测不更新模型状态，备用模型也没有单独记录

- **位置**：`apps/worker/src/probes.ts:39`、`:48`；`apps/worker/src/scheduler.ts:40`、`:144`。
- **问题**：SPEC §4.2 要求更新 `channel_models` 最近状态，并将备用模型探测单独记录。当前只写 probe_runs 和 channels 时间戳；定时任务没有读取 backup_model，也没有更新模型的 last_status/last_latency_ms/last_tested_at/last_error_code。模型列表可长期显示“未测”或旧状态，即使主测模型已被反复检测。
- **触发场景**：渠道已声明主测及备用模型，等待定时探测；只出现主测模型记录，模型行的最近可用性状态不变。源码全路径确认。
- **建议**：主测结果按模型行回写；备用模型使用独立探测/记录，避免混入主测渠道可用率。模型状态与明细结果在一致的事务/幂等写入中更新。

### 16. 最近不足三条样本时也进入“连续三败”频率

- **位置**：`apps/worker/src/scheduler.ts:44`、`:47`、`:74`。
- **问题**：`bool_and(NOT success)` 作用于“最多 3 条”，没有检查 COUNT=3。新渠道只有 1 条或 2 条失败记录时也返回 true，提前使用 flakyProbeIntervalSec，与 SPEC §4.2 的连续失败 ≥3 次不一致。
- **复现/触发**：一个仅有一条 availability 失败记录、没有其他样本的渠道，下轮扫描 recent_all_fail=true，使用约 300 秒间隔，而非原始间隔。
- **建议**：同时检查样本数为 3 且三条全部失败，或统一使用可验证的连续失败计数；增加零样本、一败、两败、三败及失败后成功的状态边界用例。

## 真实数据聚合手工复算

只读抽样渠道 1、2，以各行 `channel_stats.updated_at` 为窗口截止时间读取原始 availability 样本，在 JavaScript 中独立统计成功数、排序成功样本取中位数，并手算推荐分。审查期间共享公式经其他协作者改为 `uptime^8`，SPEC §5.5 和 shared 已同步；以下按最终公式核算，不使用旧线性公式。

| 渠道 | 截止时间（UTC） | 成功 / 总样本 | 手算 uptime24h → 库值 | 成功延迟中位数 / 库 p50 | trust / 连败 | 手算推荐分 / 库值 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Claude 官转 | 2026-10-21 19:02:47.501684 | 136 / 137 | 0.9927007299 → 0.9927 | 1644 / 1644ms | 90 / 0 | 94.7 / 94.7 |
| 2 GPT 官方渠道 | 2026-10-21 19:02:47.503077 | 132 / 137 | 0.9635036496 → 0.9635 | 1591 / 1591ms | 96 / 0 | 87.3 / 87.3 |

渠道 1：`94.3076080×0.45 + 99.04×0.20 + 90×0.25 + 100×0.10 = 94.7464236 → 94.7`。

渠道 2：`74.2723067×0.45 + 99.3933333×0.20 + 96×0.25 + 100×0.10 = 87.3012047 → 87.3`。

这两条有数据渠道的窗口过滤、仅成功样本延迟、p50 及推荐分一致。该结果不能覆盖问题 4 的无数据分支，也不能证明调度产生的样本本身没有重复或错误成功。

## 已确认有效的部分与验证边界

- **TLS / SSRF**：HTTPS 已使用 `tls.connect`。实测 HTTPS 指向普通 HTTP 服务失败，HTTP 处理器收到的明文请求数为 0；不可信自签证书被 `DEPTH_ZERO_SELF_SIGNED_CERT` 拒绝；仅在独立验证进程信任测试 CA 后，对匹配 SAN 的地址请求成功。用进程内 DNS stub 将不匹配的域名解析到测试 TLS 服务，确认 `ERR_TLS_CERT_ALTNAME_INVALID`，对端应用数据计数为 0。没有关闭证书校验。
- **DNS rebinding**：进程内 DNS stub 首次返回公网 IP，连接时返回 127.0.0.1，观察到两次解析及 `ssrf_blocked`，未连接到测试 TLS 服务。回环、十进制/八进制/十六进制 IPv4、IPv6 回环、IPv4-mapped 回环、链路本地和 ULA 均实测被禁止。入口与连接两次检查、锁定 IP、manual redirect 保留；未发现 TLS 修复引入私网绕过。保留地址分类仍是手写列表，本结论不表示已穷举全部 IANA 特殊地址段。
- **评分**：正常报告汇总跳过 passed=null，reasoning 按契约的 score 部分给分，最后调用共享 `verdictFromScore`；80/50/执行权重 30 的判定一致。发现的问题在输入、hint、请求格式和预算，不在阈值函数。失败早退的低执行权重报告判 unknown 符合共享契约。
- **差分法**：`usage2−usage1` 消去固定协议开销的逻辑成立；缺失或非正 usage 返回未执行，非正差值判失败，区间使用 ±8%。实际双文本含额外换行及分词边界，因此差值是近似而非严格恒等式。非 OpenAI 的 ratio 为经验值，mock usage 又采用相同系数；mock 通过不能独立证明真实厂商计数分布已校准。本轮没有真实官方 Key，未将系数准确率作为已经实证的结论。
- **队列 / 状态机**：单条 `claimNextTask` 使用原子 UPDATE + SKIP LOCKED，未发现同一 queued 行被同一代并行领取的问题。活动任务部分唯一索引 `probe_tasks_active_uq` 已实际存在，可阻止同时重复入队。定时 authenticity 的 NOT EXISTS/INSERT 仍存在并发竞态，但唯一索引会拒绝冲突，不能据此声称已经插入重复活动任务；当前未捕获冲突会中断该轮 sweep，建议将冲突视为已入队。invalid 的 conditional UPDATE RETURNING 能防止重复 invalid 通知；超过阈值后从定时扫描移除符合 SPEC。恢复通知仍依赖探测历史顺序，问题 2/3 修复前不应承诺严格一次。
- **性能**：聚合在 PostgreSQL 内处理 probe_runs，没有把原始大表全部搬进 Node；结果按渠道、站点逐条 upsert，数据库往返数为 O(C+S)，并重复扫描保留窗口数据。未做共享开发库压测，不把当前未证实的性能阈值问题计入缺陷。上述正确性问题应先修复，再考虑批量 upsert、窗口/增量聚合和执行计划。
- **mock / 测试**：mock 有请求体上限和场景分支，足够做协议冒烟，但不是严格协议验证器。TLS 测试依赖仓库外 `/tmp/probe-tls-test/tlscert`、`tlskey`，且 localhost 可能先解析为 ::1、服务只绑定 IPv4，使“连接失败”误充当证书拒绝；本轮分别验证了确切 TLS 错误码，没有用这个假阳性证明 TLS 正确。建议将测试证书作为可重建 fixture，并验证失败原因。
- **执行情况**：probe、worker、mock-upstream 的 `typecheck` 全部通过。未运行会污染开发库的 worker suite；未写源码、测试脚本或临时证书文件，只新增本报告。四个既有服务未被本轮主动停止。自建用户为 `engine-review-1792609054071@example.com`，站点 53、渠道 105；管理员种子账号仅用于审核/恢复/下架该自建站点。复现结束站点已下架，baseUrl 恢复至现有 mock，留下的 Key 均为虚构值，独立临时服务已结束。

## 总评

TLS 修复有效，核心 SSRF 双重检查没有退化；有数据渠道的聚合算术与最终 SPEC/shared 一致。但当前版本仍不适合直接以多 worker 方式生产运行：领取旧快照、任务 lease/退出回收、无样本聚合，以及任务入口的预算和连接池问题都可能造成重复探测、停摆或失真。应优先修复 P1，并先隔离 worker 测试数据库，再扩充跨实例、异常上游和无数据集成验证。

## API P1 #2–#6 修复回归结论

连接测试、相同 Key PATCH 使用运行中的 8711 服务及自建资源验证。为避免并发复现挂起既有服务，限流及首个任务并发使用相同源码的独立 `buildApp()` + Fastify inject，连接同一数据库、请求自建上游；指定测试 remoteAddress，未通过真实代理头伪造客户端身份。只操作本次新建账号、站点、渠道及专用鉴定记录。

| 上轮问题 | 回归结果 | 本轮证据与剩余问题 |
| --- | --- | --- |
| P1 #2 Key 回显落库 / 公开泄露 | **部分通过** | API 对 25 字符自定义 Key、5 字符 Key 的 401 回显均在响应和落库前替换；公开 history 返回固定分类，实测未含本轮短 Key。3 字符 Key 在 API 响应和库中仍可见；worker 的 5 字符 Key、截断边界也仍泄露。见问题 1。不能据公开展示修复宣称底层明文已完全消除。 |
| P1 #3 X-Forwarded-For 绕过限频 | **通过（默认配置）** | 同一 remoteAddress、12 个不同 XFF 并发请求，只落同一个 `ipHash`，与 `ipHash(remoteAddress)` 相等；仅 1 次请求到上游，其余 429。默认 trustProxy=false 生效。部署若显式启用 TRUST_PROXY=true，仍须由可信代理覆盖头，不能从该默认回归推断任意部署都安全。 |
| P1 #4 verify 额度竞争与并发控制 | **部分通过** | 同 IP 12 并发实际仅 1 次探测；继续顺序请求至总数 10 后，第 11 次 429。6 个不同 IP 同时请求却全部执行，上游并发达到 6，声明的全局 4 失效，见问题 8；跨进程每 IP 额度的事务串行化仍未得到保证。quick 实测 65 秒也超总预算，见问题 6。 |
| P1 #5 手动额度 / PATCH / 入队去重 | **部分通过，仍有 P1** | 同 Key PATCH 12 次，任务总数不变（1→1）；已存在任务时 12 并发全部返回 200 并复用任务 81。三个独立 merchant 任务完成后，手动第 4 次返回 429，额度路径有效。但无活动任务时 12 并发会连接池挂起，见问题 7；改真实 Key 可以排入第 4 个 merchant 任务 84，见问题 9。唯一索引已经在库中确认存在。 |
| P1 #6 API 容器监听 | **生产 compose 路径通过** | `apps/api/src/index.ts` 实际使用 API_HOST，`deploy/docker-compose.prod.yml:59` 设为 0.0.0.0；独立应用按该地址监听临时端口，实际 address=0.0.0.0、healthz=200。未构建/重启生产容器。注意修复记录说 Dockerfile 也设置了该变量，但实际 Dockerfile 没有，单独 docker run 必须显式传 API_HOST；worker 健康服务和 mock 仍默认/固定绑定 loopback，不能从 API 的 compose 修复推断它们的外部端口也已修复。 |

## API 第二轮修复记录（Kimi，2026-10-22）

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 | Key 脱敏长度门槛/截断顺序 | 所有 Key 入口（创建/更新渠道、/verify）校验 ≥ 8 位（中文报错）；API 侧 `sanitizeKeyFromText` 门槛 ≥ 4；先替换再截断由调用方保证（probe 边界由 GLM-A 负责） |
| 7 | enqueue 事务用外层 db 连接 | `enqueueProbeTask` 事务内所有查询（含 settings 读取）统一用 `tx`；开头 `SET LOCAL lock_timeout='5s'` + `statement_timeout='10s'`；新增回归测试：无活动任务时 15 并发全部完成（不挂起），最终活动任务 ≤ 1 |
| 8 | /verify 全局并发可被突破 | 信号量 `verifyInFlight++` 移到第一个 `await` 之前（同步占用），统一 `finally` 释放；6 个不同 IP 并发时上游最大并发 ≤ 4（进程级语义已在 README/handoff 说明） |
| 9 | PATCH 绕过每日额度 | 额度规则收进 `enqueueProbeTask` 内部（`trigger=merchant && kind=authenticity` 自动计入，去掉可选布尔参数）；超额度时 PATCH 配置照常保存但不入队，响应头 `X-Hub-Notice: rate_limited:...` 告知前端 |
| Dockerfile | api 缺 API_HOST | `apps/api/Dockerfile` 加 `ENV API_HOST=0.0.0.0`；compose 中 worker 加 `WORKER_HOST=0.0.0.0`、mock-upstream 加 `MOCK_HOST=0.0.0.0`（对应变量由 GLM-A/GLM-B 在各自入口读取） |

typecheck 通过；23 个测试全通过（新增 #7 并发回归）。

---

## Worker 修复记录（2026-10-22，第二轮审查修复）

负责人：Worker（apps/worker/**）。以下问题已修复并通过验收（hub_test 隔离库 typecheck + 26 测试全过 + 开发环境重启观察 2 分钟无报错）：

### P1 #2 定时探测重复领取
`scheduler.ts` 重写：到期筛选（approved 站点 + active 渠道 + probe_enabled + next_probe_at <= now）、最近 3 条全败降频计算、`FOR UPDATE OF SKIP LOCKED` 行锁、推进 `next_probe_at` 合并为**一条原子 UPDATE**（`claimDueChannels`），锁定阶段保留完整谓词——另一实例用旧快照重复领取时，谓词（`next_probe_at <= now()`）已不成立，不会二次领取。

### P1 #3 任务 lease
- schema 增量迁移 `0002_probe_tasks_lease.sql`：`locked_by`（text）/ `lease_token`（uuid）/ `heartbeat_at`（timestamptz）三个可空列（drizzle-kit 生成，hub 与 hub_test 均已迁移，CONTRACT-CHANGES 已记录；顺带修复 0001 snapshot 的 prevId 链断裂）。
- 领取（`claimNextTask`）：原子 UPDATE 写入新 `lease_token` + `locked_by` + `heartbeat_at`；attempts 上限检查放进领取语句（超限 queued 任务直接标 failed，不进入执行）。
- 心跳：执行中每 30s `heartbeatTask` 续租（`WHERE id AND lease_token AND status='running'`）；authenticity 多模型循环每个模型前检查 lease，丢失即停止。
- 副作用校验：完成/失败/requeue（`completeWithLease`）、authenticity_reports 写入、channel_models trust 回写、task_done/task_failed 通知全部带 lease 校验，校验失败放弃写入——旧执行者无法覆盖新执行者。
- 回收（`reclaimStaleTasks`）：只处理 `heartbeat_at` 超过恢复阈值的 running 任务（不再看 started_at），requeue 并清 lease。
- 退出（`releaseMyTasks`）：只归还 `locked_by = 本实例` 的任务。
- 测试覆盖：lease 写入/续租/易主放弃写入/只归还本实例 四个用例。

### P1 #4 无样本渠道中断聚合
- SQL `COALESCE(agg.samples_24h, 0)`、`COALESCE(cf.consecutive_failures, 0)`；应用层 `buildChannelStat` 同步防御（fakeRow 测试含 samples_24h=0 分支）。
- 逐渠道 try/catch：单个渠道 upsert 失败记录 error 并继续（`failedChannels` 计入返回值与日志），不中断整轮。
- 只聚合 approved 站点的渠道；非 approved 站点的 channel_stats 行每轮清理。
- 新增「零样本渠道」真实集成用例（自建零 probe_runs 渠道，断言 samples_24h=0、uptime=null、recommend=null、failedChannels=0）。

### P1 #5 测试污染开发库
worker 测试全部改用独立库 **hub_test**（`test/setup.ts`：DATABASE_URL 替换库名 + **强制校验库名以 `_test` 结尾否则 process.exit(1)**），与 API 测试同一隔离方式。不再有「隐藏全库 queued 任务再恢复」的全库 UPDATE——每测试自建独立渠道/站点，afterEach 级联清理；tasks 测试 beforeAll 清空 hub_test 的 probe_tasks 残留（隔离库内清空，非开发库）。

### #1 Key 脱敏（worker 侧防御）
`probes.ts` 新增 `scrubKey`：写 `probe_runs.error_message`、任务 error、task_failed 通知正文前，用渠道解密后的真实 Key 做精确子串替换（任意长度、不限 ≥8；split/join 字面替换无正则转义问题）。测试：5 字符 Key `xyz12`、`sk-w-tasks` 出现在错误文本时落库/通知均已替换为 `***`。

### #10 多模型 hint
`runAuthenticity`：每个 model 先 `matchCatalogModel` 匹配目录 id，再取该模型自己的 CatalogHint（vendor/tier/knowledge/tps），不再对整个 models 列表共用一个 hint。

### #13 任务并发与配置刷新
- 任务执行与定时探测共享同一全局/单站点 limiter：`claimNextTask` 领取后 `limiter.acquire(siteId)` 占位，占不到则原子 requeue（带 lease 校验），不再无预算直连。
- 定时探测超时改用 settings 的 `probe.timeoutMs`（不再硬编码 30s）。
- settings 每 60s 刷新（`refreshSettings` 循环）：并发上限变化时重建 limiter、超时即时生效（SchedulerDeps 的 limiter/probeTimeoutMs/globalMax 均为 getter）。

### #14 已领取探测丢失
- `claimDueChannels` 只领取全局剩余容量内的数量（`capacity = globalMax - inFlight`）；同站点满时放弃执行（渠道 next_probe_at 已推进，下轮自然重试），删除内存 pending 队列。
- 退出时 `scheduler.drain()` 等待全部在途探测完成（探测自身有超时上限，drain 受 30s 总预算约束）。

### #15 模型状态回写与备用模型
- 主测模型探测后回写 channel_models：`last_status`（pass/fail）、`last_latency_ms`、`last_tested_at`、`last_error`（UPSERT）。
- 备用模型（`channels.backup_model` 非空）单独探测：独立 probe_runs 记录 + 回写自己的 channel_models 行；**不更新渠道级时间戳、不参与失败升级**；聚合（uptime/样本数/连败/sparkline）与降频判断均只统计 `model = primary_model` 的记录。测试：备用模型记录不影响渠道可用率（10 主测样本 + 5 条备用失败后 uptime 仍 0.9）。

### #16 连败降频判定
领取 SQL 中降频条件改为 `(bool_and(NOT success) AND COUNT(*) = 3)`——恰好 3 条且全部失败才降频。测试：仅 1 条失败记录的渠道仍用基础间隔 600s±10%（断言 next_probe_at 推进 530-670s）。

### 定时 authenticity 入队冲突
`authenticity-schedule.ts`：INSERT 加 `ON CONFLICT DO NOTHING`，唯一索引 `probe_tasks_active_uq` 冲突视为已入队（RETURNING 空数组不计入 enqueued），不中断 sweep。

### 验收记录
- `pnpm --filter @hub/worker typecheck`：通过。
- `pnpm --filter @hub/worker test`（hub_test）：**4 文件 26 用例全过**（aggregate 7 + scheduler 6 + probes 5 + tasks 8），含零样本、lease 生命周期、备用模型、降频边界、Key 脱敏新用例。
- `aggregate:once`（开发库）：channel_stats=34、site_stats=14、failed=0、~180ms（34=仅 approved 站点渠道）。
- 重启验证：SIGINT 优雅停旧实例 → `nohup pnpm --filter @hub/worker start` 重启 → 观察 2 分钟：3 轮聚合（failed=0）、8 次探测全成功、healthz/metrics 正常、无任何报错；手动插入任务 #89 完整流转（lease 写入 → 报告 task_id=89 → done 后 lease 清理）。


## probe 修复记录（GLM，2026-10-22 二轮修复）

范围：`packages/probe/**`、`apps/mock-upstream/**`（worker/API 的问题 #2–#5、#7–#10、#13–#16 由对应负责人处理）。

| 问题 | 修复 | 验证 |
| --- | --- | --- |
| P1 #1 脱敏（截断顺序 / 长度门槛） | 新增 `redactThenTruncate` 统一出口：先脱敏再截断；Key 精确替换门槛 ≥8 → **≥4**；sample/detail/evidence/listUpstreamModels 错误统一走该出口 | 审查复现用例 `x.repeat(290)+LONGDUMMYSECRET...` 断言输出不含 `LONGDUMMYS` 前缀、含 `[REDACTED]`；`xyz12`（5 字符）精确替换；新增 5 项测试 |
| P1 #6 总预算 | `probeAuthenticity` 入口总 deadline + `AbortSignal.any` 组合 signal（前移到 DNS 校验之前）；子请求/读取/重试退避（可中断 sleep）共享剩余预算；quick 强制 60s、非 quick 默认 180s（`totalBudgetMs` 可配）；预算耗尽 → 剩余检查 `passed:null`「检测时间预算耗尽，本项未执行」 | 审查「每请求 13s」复现：quick 检测实测 **60.0s** 截止（旧 65.0s，超 SPEC 上限），剩余检查全部 null 且 detail 标注预算耗尽；`probeAvailability` 3s 超时正确归类 `timeout`（修复 `TimeoutError` cause 未识别为 timeout 的归类缺陷） |
| P1 #6 TTFT 20s | 独立 TTFT 计时：首内容 token 20s 未到 → 中止流判 `timeout`；`expectText:false`（纯工具调用探测）豁免——capability 合法响应可能只有 thinking+tool_use 无文本 delta，误用 TTFT 会把真实模型的 capability 打成超时（修复中发现并解决） | capability 检查在 8 场景中恢复 ✓（此前 20s TTFT timer 误杀纯 tool_use 流） |
| P2 #11 能力检查请求非法 | anthropic `budget_tokens 1024 < max_tokens 2048`（旧 1024≥256 被 400）；openai_responses tools 改顶层 `{type:'function',name,parameters}` | mock 严格校验上线：非法 thinking 预算 → 400、嵌套 function 结构 → 400；probe 新结构 200。四组 curl 验证 + typecheck |
| P2 #12 流内失败终态 | 四协议识别 OpenAI `error` / `response.failed` / Anthropic `error` / Gemini `error` → `invalid_response` | 审查复现四例（先 pong 再发错误事件）全部 `success:false + invalid_response`（旧实现全 true） |
| P2 #12 类型校验 | `asString`/`asTokenCount`：非字符串按缺失；token 必须有限非负（负数/NaN → null）；`modelEchoMatches` 防御非字符串 | `model:42, id:42` 不再抛 `TypeError`（旧复现直接抛错）；`prompt_tokens:-5` → null |
| P2 #12 空 tool_calls | `success` 判定要求非空 toolCalls 数组 | `tool_calls:[]` 无文本 → 失败（旧成功） |
| P2 #12 异常兜底 | `consumeStream` 异常路径 `reader.cancel()`；三个公开函数外层 try/catch 绝不抛异常（内部错误降级 unknown 报告） | 154 项测试全过 |
| mock / TLS fixture | `MOCK_HOST` 环境变量（默认 127.0.0.1）；TLS 测试证书移入 `packages/probe/test/fixtures/`（README 含 openssl 重建命令）；自签证书用例直连 127.0.0.1（修 localhost→::1 的 ECONNREFUSED 假阳性）并断言具体错误码 | `DEPTH_ZERO_SELF_SIGNED_CERT` 精确断言通过 |

**最终验证**：`pnpm --filter @hub/probe test` 154/154 通过；probe + mock-upstream typecheck 通过；8 场景结果——genuine 100 / fast 95 / slow 95 / flaky 100 / ratelimited 100 全部 genuine，downgraded 57 suspect（token_count 差分法 + reasoning + capability 三重命中），fake 25 fake，dead null unknown。mock-upstream 已重启（PID 见 8712 端口，日志 `/tmp/2apihub-logs/mock.log`）。
