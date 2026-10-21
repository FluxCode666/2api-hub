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
| token_count (20) | 发送固定基准文本（中英混合+代码，o200k 计 142 token），比较 usage.input_tokens 与厂商期望区间（±10%）。OpenAI 用 gpt-tokenizer o200k 精确计算；Anthropic ×1.2（官方文档：tiktoken 少计 15-20%）、Gemini ×1.05（官方 ~4 chars/token，实测英文 ×1.01 中文 ×0.85）、DeepSeek ×1.1（官方 0.6 token/汉字）等经验系数见 calibration.ts 注释（含来源）。协议包装开销：openai_chat +8 / responses +6 / anthropic +8 / gemini +4 | **换皮最强信号**，但要求上游如实回报 usage；区间放宽到 ±10% 以吸收中转站 prepend 系统提示的差异。mock 验证：anthropic 渠道换 gpt 后端 → 156 vs 期望 [160,196]，正确判负 |
| knowledge (10) | 问自我介绍+知识截止，与目录厂商比对；明确自称其他厂商才判负（弱信号） | 模型可被 system prompt 洗白身份，故仅 10 分且只在「自称别家」时判负 |
| reasoning (20) | 12 道确定性题库随机抽 3 道（算术/字符串/逻辑，答案可程序化判定，不依赖世界知识）；flagship 要求 3/3，其余 ≥2/3；部分得分按比例计 | mock 的 downgraded 交替答对（1/3）→ 判负；真实降智模型答对率通常 1-2/3 → 部分得分 |
| capability (10) | 按协议：Anthropic 请求带 thinking → 校验 thinking 块 + ≥32 字符 signature（真 Anthropic 必有加密签名）；OpenAI 带工具定义 → 校验 tool_calls 格式；Gemini → functionCall。quick 模式（公开鉴定）跳过 | 中转站可能剥离 thinking 或不透传 tools 参数 → 误判，但结合权重（10）影响有限 |
| speed (5) | tokens/s 落在期望区间（目录 expected_tps 的 20%-10 倍，宽松） | mock fast 场景 916 tps 超上限判负属预期（真实渠道极少）；slow 场景 2.3 tps 判负 |

评分 = Σ(通过项权重，reasoning 按正确率折算) / Σ(已执行项权重) × 100；`verdictFromScore`（shared）：≥80 genuine / 50-79 suspect / <50 fake / 已执行权重 <30 unknown。**未执行（null）的检查不计入分母**，因此 429/502 场景的分数会随失败项浮动。

### SSRF 防护（SPEC §5.4）

- `assertSafeUrl`：scheme 白名单（http/https）→ DNS 解析（all+verbatim）→ 逐 IP 检查私网/回环/链路本地/保留/CGNAT/NAT64/文档段（IPv4+IPv6 含 v4-mapped）
- 实际请求经 undici Agent：connect 回调再次校验 IP 并**锁定连接到已校验 IP**（TLS SNI/Host 保持域名），消除 DNS TOCTOU；DNS 结果缓存 5s
- 重定向 `redirect: 'manual'` 不自动跟随；响应体 2MB 上限
- `ALLOW_PRIVATE_PROBE=true`（.env 默认 true，开发用）放行私网；生产必须 false
- 关键实现说明：**必须用 undici 包自己的 `fetch` + `Agent` 组合**。Node 22 全局 fetch 内置的 undici 与 npm undici 8 的 Agent 跨版本不兼容（`invalid onRequestStart method`）——这是集成初期 API 侧 /verify 全部 network 失败的根因，已修复。

### Key 安全

- 所有错误信息过 `redact()`：`sk-xxx…`→`sk-****`、`Bearer xxx`→`Bearer ****`、`AIza…`、JWT 样式串
- ProbeResult/日志/报告不含 key；http 层不打印请求体

## 二、@hub/mock-upstream（端口 8712）

由 subagent 实现，交付说明见 `docs/handoff/mock-upstream-subagent.md`。要点：

- Node 原生 http，无框架；路径前缀 `/\<scenario\>/v1/...`；4 协议流式+非流式 + `/v1/models` + `/v1beta/models`
- usage 与 calibration.ts 对齐：genuine 按厂商系数（anthropic genuine BENCHMARK 请求实测 input=178，精确命中期望）；downgraded 统一 o200k+8（=150/156，落在 anthropic 期望区间 [160,196] 外 → token_count 判负）；fake 不返回 usage
- 启动：`pnpm --filter @hub/mock-upstream dev`（tsx watch），监听 127.0.0.1:8712，`MOCK_UPSTREAM_PORT` 可覆盖

## 三、运行与验证

```bash
# 1. 单元测试（100 个：SSE 解析、协议解析、评分、SSRF、模型匹配、题库）
pnpm --filter @hub/probe test
# 2. typecheck
pnpm --filter @hub/probe typecheck && pnpm --filter @hub/mock-upstream typecheck
# 3. 启动 mock
pnpm --filter @hub/mock-upstream dev
# 4. 集成验证（8 场景 × availability + authenticity）
cd packages/probe && npx tsx scripts/verify-scenarios.ts
```

### 集成验证结果表（2026-10-22，mock-upstream @ 127.0.0.1:8712）

**probeAvailability**（flaky/ratelimited 各 10 次统计）：

| scenario | ok | latency | ttft | error |
| --- | --- | --- | --- | --- |
| genuine | 1/1 | 56ms | 45ms | — |
| fast | 1/1 | 9ms | 7ms | — |
| slow | 1/1 | 9055ms | 9049ms | — |
| flaky | 6/10 | 84ms | 62ms | http_5xx(502)×4 |
| ratelimited | 4/10 | 57ms | 47ms | http_429×6 |
| downgraded | 1/1 | 54ms | 42ms | — |
| fake | 1/1 | 82ms | 61ms | — |
| dead | 0/1 | 1ms | — | http_5xx(503) |

**probeAuthenticity**（主测模型按 seed 渠道配置）：

| scenario | score | verdict | 失败项 |
| --- | --- | --- | --- |
| genuine | 100 | **genuine** ✓ | 无 |
| fast | 95 | **genuine** ✓ | speed（916 tps 超宽松上限，属 mock 特性） |
| slow | 95 | **genuine** ✓ | speed（2.3 tps，TTFT 9s 属设计） |
| flaky | 87 | genuine | reasoning 1/3（一次 502 打断，属设计） |
| ratelimited | 79 | suspect | reasoning 2/3 + capability（429 打断，属设计） |
| downgraded (anthropic) | 57 | **suspect** ✓ | token_count（156∉[160,196] 换皮信号命中）+ reasoning 1/3 + capability（无 signature） |
| fake | 25 | **fake** ✓ | model_echo（回显 gpt-4o-mini）+ response_shape（x123 无前缀、无 usage）+ reasoning 0/3 |
| dead | — | 连通失败 | http_5xx |

判定校验全部符合预期：genuine/fast/slow → genuine（≥80）；downgraded → suspect；fake → fake（<50）；dead 连通失败。

补充：DB seed 渠道实测——channel 1（genuine/anthropic）score=100 genuine；channel 15（downgraded/anthropic）score=57 suspect；channel 31（dead）连通失败。channel 14（downgraded/openai_responses）score=93 genuine 属正常：该渠道声明 openai 协议，mock 的 downgraded 对 openai 家族 usage 计数恰好落在 openai 期望区间，降智信号主要体现在 reasoning（交替答错），本次抽题偶然答对比例高；多轮检测会向 suspect 收敛。

## 四、已知问题与说明

1. **speed 检查对 mock fast/slow 场景判负**：mock 特意制造的极端速度（916 tps / 2.3 tps）超出「期望 tps 的 20%-10 倍」区间，符合设计意图（这两个场景模拟的是延迟异常，真伪判定仍为 genuine，仅扣 5 分）。
2. **flaky/ratelimited 的 authenticity 分数随失败项浮动**：429/502 打断部分检查（null 不计分母），87/79 分属正常波动；SPEC 未对这两个场景的判定做要求。
3. **downgraded + openai 协议渠道的 token_count 不报警**：mock 的 downgraded 只伪造「anthropic 收到 openai 计数」这一换皮形态；openai 渠道收到 o200k 计数本就正确。真实世界的换皮（openai 渠道换 deepseek 后端等）同理可被厂商区间差异捕捉。
4. **`listUpstreamModels` 对 anthropic 协议先试 `/v1/models`**（SPEC §5.1），mock 与 new-api 均支持；官方 Anthropic 无此端点时会返回 404 errorCode（不影响主流程）。
5. **worker 对接**：worker 直接调用本库公开导出；`AuthenticityResult` 需调用方补齐 id/channelId/trigger/createdAt 后入库。`ProbeResult.at` 为 ISO 时间串。
6. **全局 fetch 兼容性教训**（重要）：任何直接 `fetch(url, { dispatcher })` 的代码在 Node 22 + npm undici 8 下会 `invalid onRequestStart method`——必须 `import { fetch } from 'undici'`。API 侧 /verify 初期全失败即此因，已在本库修复；若其他角色直接用 undici Agent 请注意。

## 五、对其他角色的依赖 / 请求

- 无阻塞依赖。worker agent 只需按 SPEC §5.0 签名调用；DB 已 READY（seed 完成，34 渠道指向 8712 各 scenario）。
- 建议编排者提交时包含：`packages/probe/**`、`apps/mock-upstream/**`、`pnpm-lock.yaml`（gpt-tokenizer/undici/vitest/tsx 新增）。
