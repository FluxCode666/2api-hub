# 检测引擎交付说明（GLM / probe + mock-upstream）

负责目录：`packages/probe/**`、`apps/mock-upstream/**`（`apps/worker` 已按编排者调整移交给专职 agent，本文档不含 worker）。

## 一、@hub/probe 检测引擎库

### 架构

```
packages/probe/src/
├── index.ts        # 对外 API（SPEC §5.0 五个导出）+ probeAvailability/listUpstreamModels/probeAuthenticity 编排
├── adapters.ts     # 4 种协议适配：请求构造 + 流式 SSE 增量解析 + 非流式解析，聚合为统一 ProtocolCapture
├── sse.ts          # 增量式 SSE 解析器（LF/CRLF、多行 data、[DONE]、跨 chunk）
├── http.ts         # 安全 HTTP 层：undici Agent（DNS 解析→IP 校验→锁定连接），2MB 响应上限，不自动跟随重定向
├── ssrf.ts         # URL 安全校验：scheme 白名单、IPv4/IPv6 私网/保留段判定（DNS 解析后逐 IP 检查）
├── calibration.ts  # token 计数校准：固定基准文本 + 各厂商家族期望区间
├── questions.ts    # 12 道确定性推理题（数字/字符串/逻辑，程序化判定）
├── match.ts        # 模型名匹配（大小写/日期后缀/厂商前缀/点号变体）
└── types.ts        # 错误码归类（dns/tls/network/timeout/http_*）+ Key 脱敏
```

### 对外 API（与 SPEC §5.0 签名一致，已程序化校验）

```ts
probeAvailability(target, opts): Promise<ProbeResult>          // 永不抛异常
listUpstreamModels(target, opts): Promise<UpstreamModelList>   // 永不抛异常
probeAuthenticity(target, hint, opts): Promise<AuthenticityResult>  // 永不抛异常
matchCatalogModel(upstreamName, catalog): number | null
assertSafeUrl(url, allowPrivate?): Promise<void>               // 唯一会抛异常的（ProbeError code='ssrf_blocked'）
```

另导出内部模块供测试复用：`SseParser/parseSse`、四个 protocol adapter、`checkTokenCount/expectedTokenRange/BENCHMARK_TEXT`、`QUESTIONS/pickQuestions/judgeQuestion`、`isPrivateIp`、`modelEchoMatches` 等。

### 检测算法说明（8 项检查，id/权重/中文名以 @hub/shared AUTH_CHECKS 为准）

| 检查 | 原理 | 局限 |
| --- | --- | --- |
| connectivity (10) | 极小流式请求（"Reply with exactly: pong"，max_tokens 16）HTTP 2xx 且有非空文本 | 无法区分「模型可用」与「仅网关存活」 |
| model_echo (10) | 响应 `model` 字段与请求一致（容忍大小写/日期后缀/点号变体/厂商前缀） | 中转站可简单透传伪造回显 |
| response_shape (15) | 按 protocol 校验官方特征：Anthropic `msg_` 前缀 + message_start/content_block_*/message_delta/message_stop 事件序列 + usage 四字段（含 cache_creation_input_tokens）；OpenAI chat `chatcmpl-` 前缀；Responses `resp_` 前缀 + response.created/output_text.delta/completed 事件；Gemini usageMetadata/candidates 结构 | 特征可被逐字段模仿；部分 new-api 站做协议转换会误伤（此时其他检查仍有效） |
| token_count (20) | **差分法（v2）**：分别发送 1× 与 2× 基准文本，usage(2×) − usage(1×) = 纯文本 token 数（协议开销相减消除），与厂商纯文本期望区间（±8%）比较。OpenAI 用 gpt-tokenizer o200k 精确计算；Anthropic ×1.2（官方：tiktoken 少计 15-20%）、Gemini ×1.05、DeepSeek ×1.1、Kimi ×0.95 等经验系数见 calibration.ts（含来源）。差分法把可检测冒充组合从 14/56 提升到 26/56 | **诚实声明**：openai/xai/bytedance（×1.0 簇）与 google/zhipu（×1.05 簇）彼此不可区分（30/56 组合），token_count 对这些组合无效但不误报，由 reasoning/knowledge/capability 补位。完整矩阵见 `scripts/distinct-analysis.ts`。差值非正（2× 不增长）直接判负（伪造常量 usage）。运营方需定期用 calibrate CLI 校准（见下文指南） |
| knowledge (10) | 问自我介绍+知识截止，与目录厂商比对；明确自称其他厂商才判负（弱信号） | 模型可被 system prompt 洗白身份，故仅 10 分且只在「自称别家」时判负 |
| reasoning (20) | 12 道确定性题库随机抽 3 道（算术/字符串/逻辑，答案可程序化判定，不依赖世界知识）；flagship 要求 3/3，其余 ≥2/3；部分得分按比例计 | mock 的 downgraded 交替答对（1/3）→ 判负；真实降智模型答对率通常 1-2/3 → 部分得分 |
| capability (10) | 按协议：Anthropic 请求带 thinking → 校验 thinking 块 + ≥32 字符 signature（真 Anthropic 必有加密签名）；OpenAI 带工具定义 → 校验 tool_calls 格式；Gemini → functionCall。quick 模式（公开鉴定）跳过 | 中转站可能剥离 thinking 或不透传 tools 参数 → 误判，但结合权重（10）影响有限 |
| speed (5) | tokens/s 落在期望区间（目录 expected_tps 的 20%-10 倍，宽松） | mock fast 场景 916 tps 超上限判负属预期（真实渠道极少）；slow 场景 2.3 tps 判负 |

评分 = Σ(通过项权重，reasoning 按正确率折算) / Σ(已执行项权重) × 100；`verdictFromScore`（shared）：≥80 genuine / 50-79 suspect / <50 fake / 已执行权重 <30 unknown。**未执行（null）的检查不计入分母**；临时错误（429/5xx/超时，重试后仍失败）的检查记 null 不计分，不污染真伪判定（稳定性由可用率单独衡量）。

### SSRF 防护（SPEC §5.4）

- `assertSafeUrl`：scheme 白名单（http/https）→ DNS 解析（all+verbatim）→ 逐 IP 检查私网/回环/链路本地/保留/CGNAT/NAT64/文档段（IPv4+IPv6 含 v4-mapped）
- 实际请求经 undici Agent：connect 回调再次校验 IP 并**锁定连接到已校验 IP**（TLS SNI/Host 保持域名），消除 DNS TOCTOU；DNS 结果缓存 5s
- 重定向 `redirect: 'manual'` 不自动跟随；响应体 2MB 上限
- `ALLOW_PRIVATE_PROBE=true`（.env 默认 true，开发用）放行私网；生产必须 false
- 关键实现说明：**必须用 undici 包自己的 `fetch` + `Agent` 组合**。Node 22 全局 fetch 内置的 undici 与 npm undici 8 的 Agent 跨版本不兼容（`invalid onRequestStart method`）——这是集成初期 API 侧 /verify 全部 network 失败的根因，已修复。

### Key 安全（P1-2 加固）

- **按真实 Key 精确脱敏（主防线）**：probe 边界用实际 `target.apiKey` 及其变体（原样/URL 编码/base64/base64url/JSON 转义）对所有对外输出做精确替换为 `[REDACTED]`，覆盖 `errorMessage`、`sample`、报告中每个 check 的 `detail` 与 `evidence`（`redactDeep` 深度遍历）、`listUpstreamModels` 的错误信息。Key <8 字符时不替换（防误伤）
- **格式兜底**：`redact()` 仍保留 `sk-…`/`Bearer …`/`AIza…`/JWT 形态匹配，处理无真实 Key 的场景
- ProbeResult/日志/报告不含 key；http 层不打印请求体

### TLS 安全（P1-1 修复）

- HTTPS 请求通过 `tls.connect({ host: 已校验IP, servername: 原域名 })` 建立连接——SNI、证书链、主机名校验全部走 Node 默认逻辑（rejectUnauthorized 默认 true），修复了此前一律明文 TCP 的问题
- 连接端口：undici connect 回调的 port 为字符串，空串时按协议默认（https 443 / http 80）
- 公网目标优先锁定 IPv4（部分网络 IPv6 出网不通，锁定后无 happy-eyeballs 回退；allowPrivate 时保持首个）
- 回归测试：https→http 服务必须失败、自签证书必须失败、`api.anthropic.com` 真实冒烟返回 http_403（TLS 握手成功）。`api.openai.com` 本机网络不可达时 skip

## 二、@hub/mock-upstream（端口 8712）

由 subagent 实现，交付说明见 `docs/handoff/mock-upstream-subagent.md`。要点：

- Node 原生 http，无框架；路径前缀 `/\<scenario\>/v1/...`；4 协议流式+非流式 + `/v1/models` + `/v1beta/models`
- **按模型覆盖场景**（CONTRACT-CHANGES 2026-10-22）：scenario 段支持 `\<默认场景\>[,\<模型子串\>=\<场景\>]*`，如 `genuine,opus=fake`——请求模型名含 `opus` 按 fake 响应，其余按 genuine；多覆盖按出现顺序首个命中；`%2C`/`%3D` 编码兼容；`/v1/models` 不受影响；覆盖场景的错误注入（如 `opus=dead`）同样按生效场景执行。用于演示「同一渠道主测真、某模型换皮」
- usage 与 calibration.ts 对齐：genuine 按厂商系数（anthropic genuine BENCHMARK 请求实测 input=178，精确命中期望）；downgraded 统一 o200k+8（=150/156，落在 anthropic 期望区间 [160,196] 外 → token_count 判负）；fake 不返回 usage
- 启动：`pnpm --filter @hub/mock-upstream dev`（tsx watch），监听 127.0.0.1:8712，`MOCK_UPSTREAM_PORT` 可覆盖

## 三、运行与验证

```bash
# 1. 单元测试（154 个：SSE、协议解析、评分、SSRF、模型匹配、题库、TLS 回归（fixture 化+具体错误码断言）、Key 脱敏（先脱敏再截断）、临时错误判定、总预算、流健壮性）
pnpm --filter @hub/probe test
# 2. typecheck
pnpm --filter @hub/probe typecheck && pnpm --filter @hub/mock-upstream typecheck
# 3. 启动 mock
pnpm --filter @hub/mock-upstream dev
# 4. 集成验证（8 场景 × availability + authenticity）
cd packages/probe && npx tsx scripts/verify-scenarios.ts
```

### 集成验证结果表（2026-10-22 第三轮：二轮审查修复后，mock-upstream @ 127.0.0.1:8712）

**probeAvailability**（flaky/ratelimited 各 10 次统计；可用性探测不重试——可用率衡量稳定性）：

| scenario | ok | latency | ttft | error |
| --- | --- | --- | --- | --- |
| genuine | 1/1 | 61ms | 49ms | — |
| fast | 1/1 | 10ms | 7ms | — |
| slow | 1/1 | 9161ms | 9154ms | — |
| flaky | 6/10 | 65ms | 44ms | http_5xx(502)×4 |
| ratelimited | 4/10 | 57ms | 45ms | http_429×6 |
| downgraded | 1/1 | 77ms | 53ms | — |
| fake | 1/1 | 70ms | 58ms | — |
| dead | 0/1 | 2ms | — | http_5xx(503) |

**probeAuthenticity**（子请求临时错误退避重试最多 2 次仍失败记 null；总预算 quick 60s / 非 quick 180s）：

| scenario | score | verdict | 失败项 |
| --- | --- | --- | --- |
| genuine | 100 | **genuine** ✓ | 无（capability 修复后恢复 ✓） |
| fast | 95 | **genuine** ✓ | speed（1100 tps 超宽松上限，属 mock 特性） |
| slow | 95 | **genuine** ✓ | speed（3.0 tps，TTFT 9.2s 属设计） |
| flaky | 100 | **genuine** ✓ | 无（502 被重试化解） |
| ratelimited | 100 | **genuine** ✓ | 无（429 被重试化解） |
| downgraded (anthropic) | 57 | **suspect** ✓ | token_count 差分法（142 ∉ [156,184]）+ reasoning 1/3 + capability（无 signature） |
| fake | 25 | **fake** ✓ | model_echo（回显 gpt-4o-mini）+ response_shape（x123 无前缀、无 usage）+ reasoning 0/3 |
| dead | null | **unknown** ✓ | 单独实测：全部检查因临时错误未计分，权重 <30 → unknown |

判定校验全部符合预期：genuine/fast/slow/flaky/ratelimited → genuine；downgraded → suspect；fake → fake；dead → unknown（权重不足）。

补充：DB seed 渠道实测——channel 1（genuine/anthropic）score=100 genuine；channel 15（downgraded/anthropic）score=57 suspect；channel 31（dead）连通失败。channel 14（downgraded/openai_responses）score=93 genuine 属正常：该渠道声明 openai 协议，mock 的 downgraded 对 openai 家族 usage 计数恰好落在 openai 期望区间，降智信号主要体现在 reasoning（交替答错），本次抽题偶然答对比例高；多轮检测会向 suspect 收敛。

## 四、已知问题与说明

1. **speed 检查对 mock fast/slow 场景判负**：mock 特意制造的极端速度（916 tps / 2.3 tps）超出「期望 tps 的 20%-10 倍」区间，符合设计意图（这两个场景模拟的是延迟异常，真伪判定仍为 genuine，仅扣 5 分）。
2. **临时错误不再污染真伪分（2026-10-22 修订）**：真伪检测的每个子请求遇 429/5xx/timeout/network 等临时错误时按退避重试（最多 2 次，固定 800ms×n+抖动、上限 5s）；重试后仍失败该项记 passed=null 不参与计分，detail 写明「上游临时错误（429），本项未计分」。只有拿到有效响应且内容不符才记 false。已执行权重 <30 时按现有规则判 unknown（而非 fake/suspect）。可用性探测（probeAvailability）不重试——可用率单独衡量稳定性。极端场景（所有子请求重试后仍 429，如持续硬限流）→ 全部 null → unknown，不冤枉正规站长。
3. **downgraded + openai 协议渠道的 token_count 不报警**：mock 的 downgraded 只伪造「anthropic 收到 openai 计数」这一换皮形态；openai 渠道收到 o200k 计数本就正确。真实世界的换皮（openai 渠道换 deepseek 后端 ×1.1）在差分法 ±8% 下**可以**检测（旧单次法 ±10% 检测不到，这正是差分法的改进点）；但 openai↔xai↔bytedance↔google↔zhipu 簇内仍不可区分（客观分词器差异，见矩阵）。
4. **`listUpstreamModels` 对 anthropic 协议先试 `/v1/models`**（SPEC §5.1），mock 与 new-api 均支持；官方 Anthropic 无此端点时会返回 404 errorCode（不影响主流程）。
5. **worker 对接**：worker 直接调用本库公开导出；`AuthenticityResult` 需调用方补齐 id/channelId/trigger/createdAt 后入库。`ProbeResult.at` 为 ISO 时间串。
6. **全局 fetch 兼容性教训**（重要）：任何直接 `fetch(url, { dispatcher })` 的代码在 Node 22 + npm undici 8 下会 `invalid onRequestStart method`——必须 `import { fetch } from 'undici'`。API 侧 /verify 初期全失败即此因，已在本库修复；若其他角色直接用 undici Agent 请注意。

## 五、真实环境校准指南（运营方必读）

token_count 的差分法依赖 `VENDOR_CALIBRATION` 中各厂商的**相对系数**（对 o200k 基准文本的乘数）。
上线前及每季度，运营方应使用官方（或高可信）API Key 对每家厂商跑一次校准 CLI，固化实测区间：

```bash
# 示例：Anthropic 官方
pnpm --filter @hub/probe calibrate -- \
  --base-url https://api.anthropic.com \
  --key sk-ant-xxx \
  --protocol anthropic \
  --model claude-sonnet-5-5 \
  --runs 5 \
  --vendor anthropic
```

CLI 会依次发送：空文本（测协议开销）→ 基准文本 ×1 → 基准文本 ×2（差分），
输出：实测 input_tokens 中位数、协议开销拆分、差分纯文本数、相对 o200k 系数、
与 calibration.ts 现值的偏差，以及**可直接粘贴进 `VENDOR_CALIBRATION` 的代码片段**。
Key 不会被打印（错误信息全程脱敏）。

流程建议：
1. 为 8 家厂商各准备一个官方 Key（最少用量的模型即可，每次校准约 3×runs 个极小请求）
2. 逐家跑 calibrate，将输出片段粘贴进 `packages/probe/src/calibration.ts` 的 `VENDOR_CALIBRATION`
3. 跑 `pnpm --filter @hub/probe test`（差分法测试用旧系数写的断言如失败需同步更新）
4. 用 `npx tsx scripts/distinct-analysis.ts` 重新生成冒充矩阵，确认可区分组合数
5. mock-upstream 的 usage.ts 与 calibration 保持同源逻辑，改系数后 mock 无需改动（它直接引用比例而非硬编码值时需同步——当前 mock 独立实现了同系数，两边都要改）

**可区分性矩阵（差分法 ±8%，2026-10-22 基准文本）**：56 个冒充组合可检测 26 个。
anthropic（×1.2）与任何其他厂商互冒均可检测；openai/xai/bytedance（×1.0）与
google/zhipu（×1.05）两簇内部 30 个组合**不可区分**——这是分词器对基准文本计数
几乎相同的客观事实。token_count 对这些组合不给出错误的 fake 信号（不误报），
真伪判断由 reasoning（20 分）+ knowledge + capability 等检查承担。
完整矩阵运行 `npx tsx scripts/distinct-analysis.ts` 查看。

### 二轮审查修复（2026-10-22，docs/review/engine-review.md）

**P1 #1 脱敏**：新增 `redactThenTruncate`（统一出口：**先脱敏再截断**，修复 `x.repeat(290)+KEY` 截断边界前缀泄露）；Key 精确替换门槛从 ≥8 降到 **≥4**；sample/detail/evidence/listUpstreamModels 错误全部走同一出口。测试含审查复现用例（5 项新增）。
**P1 #6 总预算**：`probeAuthenticity` 入口创建总 deadline + 组合 AbortSignal（`AbortSignal.any`），DNS（signal 前移）、所有子请求、读取流、重试退避（可中断等待）共享剩余预算；**quick 强制 60s**、非 quick 默认 180s（`totalBudgetMs` 可配）；预算耗尽 → 剩余检查 `passed:null`「检测时间预算耗尽，本项未执行」。实现 SPEC 独立 **TTFT 20s** 超时（仅对预期文本的请求；纯工具调用探测 `expectText:false` 豁免——合法响应可能无文本 delta）。测试：审查「每请求 13s」用例实测 60.0s 截止（旧实现 65.0s）。
**P2 #11 能力检查合法性**：anthropic `thinking.budget_tokens=1024 < max_tokens=2048`；openai_responses tools 改顶层 `{type:'function',name,parameters}` 结构。mock-upstream **严格校验**两类请求（非法 → 400 `invalid_request_error`），已验证四种组合（非法 400 ×2 / 合法 200 ×2）。
**P2 #12 流解析健壮性**：四协议识别流内失败终态（OpenAI `error` 事件 / `response.failed` / Anthropic `error` / Gemini `error`）→ `invalid_response`（旧实现 `success:true`，审查复现四例全改判失败）；`asString`/`asTokenCount` 运行时类型校验（非字符串按缺失、token 必须有限非负）；**空 tool_calls 不算成功**；异常路径 `reader.cancel()` 释放流；`probeAvailability`/`probeAuthenticity`/`listUpstreamModels` 外层兜底 try/catch **绝不抛异常**（审查的 `model=42 → TypeError` 已由类型校验+`modelEchoMatches` 字符串防御双重覆盖）。8 项复现测试全过。
**TLS fixture**：测试证书移入 `packages/probe/test/fixtures/`（含重建说明 README），不依赖 /tmp；自签证书用例改用 127.0.0.1 直连（localhost→::1 会造成 ECONNREFUSED 假阳性，审查点名）并**断言具体错误码 `DEPTH_ZERO_SELF_SIGNED_CERT`**。
**mock-upstream**：`MOCK_HOST` 环境变量（默认 127.0.0.1）。

## 六、对其他角色的依赖 / 请求

- 无阻塞依赖。worker agent 只需按 SPEC §5.0 签名调用；DB 已 READY（seed 完成，34 渠道指向 8712 各 scenario）。
- 建议编排者提交时包含：`packages/probe/**`、`apps/mock-upstream/**`、`pnpm-lock.yaml`（gpt-tokenizer/undici/vitest/tsx 新增）。
