# mock-upstream 子代理交付说明

## 做了什么

在 `apps/mock-upstream` 实现了 `@hub/mock-upstream` 包：单进程、Node 原生 `http` 模块（无框架）的模拟 AI 中转站上游服务，用于测试 `@hub/probe` 检测引擎。

### 代码组织

```
apps/mock-upstream/
├── package.json        # type module，main/exports → src/index.ts，scripts: dev/start/typecheck
├── tsconfig.json       # 继承 ../../tsconfig.base.json（同 packages/probe 写法），include ["src","test"]
└── src/
    ├── index.ts        # 入口 + HTTP server：路由（scenario 前缀解析、4 协议端点、模型列表）、鉴权、body 收集（1MB 上限）、错误注入、请求日志
    ├── scenarios.ts    # 8 种 scenario 行为定义（usage 模式 / 推理题正确性 / 协议特征 / thinking signature / 延迟 / 错误概率）
    ├── replies.ts      # 回复内容生成（pong / 身份介绍 / 12 道推理题 / BENCHMARK / 兜底），题面特征→答案映射与 packages/probe/src/questions.ts 对齐
    ├── protocols.ts    # 4 种协议的流式（SSE）与非流式响应构造，字段名与事件序列与 packages/probe/src/adapters.ts 的消费逻辑对齐
    └── usage.ts        # token 计数：gpt-tokenizer o200k_base 精确计数 + 厂商系数换算（与 packages/probe/src/calibration.ts 对齐）
```

依赖：`gpt-tokenizer`（运行时）；dev：`tsx`、`typescript`、`@types/node`。均通过 `pnpm --filter @hub/mock-upstream add` 安装。

### 支持的端点（每个 scenario 前缀下）

- `POST /<scenario>/v1/chat/completions`（OpenAI Chat，stream true/false，缺省 false）
- `POST /<scenario>/v1/responses`（OpenAI Responses，stream true/false）
- `POST /<scenario>/v1/messages`（Anthropic Messages，stream true/false；system 接受顶层字段/数组/role=system 消息三种形式）
- `POST /<scenario>/v1beta/models/{model}:generateContent` 与 `:streamGenerateContent?alt=sse`（Gemini）
- `GET /<scenario>/v1/models`（OpenAI 格式）与 `GET /<scenario>/v1beta/models`（Gemini 格式）

鉴权：任意 key 均接受；`invalid-key`（Bearer / x-api-key / x-goog-api-key）→ 401 `{"error":{"message":"Invalid key"}}`。未知路径 → 404 `{"error":{"message":"Not found"}}`。

### scenario 行为摘要

| scenario | 行为 |
| --- | --- |
| genuine | 正确模型回显；协议特征完整（msg_/chatcmpl-/resp_ 前缀、完整事件序列、system_fingerprint、usage 四字段含 cache_*）；按厂商分词器计数；推理题全对；thinking 带 88 字符随机 signature；工具调用按协议格式 |
| fast | 同 genuine，TTFT ~5ms、chunk 间隔 1ms（实测整请求 8-15ms） |
| slow | 同 genuine，TTFT 6-12s 随机（实测 8.5s）后正常输出 |
| flaky | 30% 概率 502（JSON 错误体），70% 同 genuine（实测 10 次中 2 次 502） |
| ratelimited | 50% 概率 429，50% 同 genuine（实测 10 次中 2 次 429） |
| downgraded | 回显正确；usage 全协议统一 o200k+8（anthropic 也返回 150 而非 178 —— 换皮信号）；推理题按请求序号交替对/错；thinking 返回但 signature 为空串 |
| fake | claude 请求回显 gpt-4o-mini / gpt 请求回显 claude-3-5-haiku / 其他 some-random-model；id 用 "x123" 无前缀、无 usage、无 system_fingerprint；推理题全答 "Answer: 42" |
| dead | 永远 503 |

## 如何启动

```bash
cd /Users/duegin/project/2api-hub
pnpm --filter @hub/mock-upstream dev        # 或 apps/mock-upstream 下 npx tsx src/index.ts
# 监听 http://127.0.0.1:8712（端口可用 MOCK_UPSTREAM_PORT 覆盖）
```

## 验证结果

### 1. typecheck

`pnpm --filter @hub/mock-upstream typecheck` → **通过**（tsc --noEmit 无错误）。

### 2. 启动验证（自起自杀，进程已清理，端口 8712 已释放）

| 检查 | 结果 |
| --- | --- |
| `GET /genuine/v1/models` | ✅ OpenAI 格式 `{"object":"list","data":[{"id":...}]}`，18 个模型（与 SEED_MODELS 一致） |
| `GET /genuine/v1beta/models` | ✅ `{"models":[{"name":"models/xxx"}]}` |
| openai_chat pong（非流式） | ✅ `chatcmpl-mock-` id、`system_fingerprint:"fp_mock"`、content "pong"、usage prompt 13 |
| anthropic 身份介绍（非流式） | ✅ `msg_mock-` id、Claude 身份回复、usage 四字段（input 25） |
| anthropic 流式 | ✅ message_start → content_block_start → content_block_delta×N → content_block_stop → message_delta → message_stop，事件序列与 adapters.ts 对齐 |
| anthropic system 作为 role=system 消息 | ✅ 正常接受，input 19 |
| dead | ✅ 503 |
| invalid-key（Bearer） | ✅ 401 `{"error":{"message":"Invalid key"}}` |
| flaky ×10 | 200×8 / 502×2（约 30%） |
| ratelimited ×10 | 200×8 / 429×2（约 50%） |
| 404 | ✅ 未知路径与未知 scenario 均 404 |
| fast 延迟 | ✅ 整请求 ~15ms |
| slow TTFT | ✅ 实测 8.5s（6-12s 区间内） |
| openai_chat 流式 | ✅ delta chunk → finish_reason stop → usage chunk → [DONE] |
| openai_responses 流式 | ✅ response.created → output_text.delta×N → response.completed（含 usage + 全文 output） |
| gemini 流式 | ✅ data: {candidates…usageMetadata}×N，末块 finishReason STOP，modelVersion 回显 |
| anthropic thinking+tools 流式 | ✅ thinking 块（thinking_delta×N → signature_delta）→ tool_use 块（input_json_delta）→ message_delta/stop |
| openai_chat tools（非流式） | ✅ tool_calls + finish_reason tool_calls |
| gemini tools（非流式） | ✅ functionCall + finishReason STOP |

### 3. usage 数值验证（BENCHMARK 文本，与 calibration.ts 对齐）

BENCHMARK_TEXT 的 o200k 计数 = **142**（与 probe 的校准注释一致）。

| 请求 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- |
| anthropic genuine | round(142×1.2)+8 = **178** | **input_tokens: 178** | ✅ 精确命中（token_count 检查期望值 178，区间约 [160,196]） |
| anthropic downgraded | 142+8 = **150** | **input_tokens: 150** | ✅ 换皮信号成立（150 落在 genuine 期望区间外 —— 178×0.90=160.2，150 < min，会被判 token_count 不通过） |
| openai_chat genuine | 142+8 = **150** | prompt_tokens: 150 | ✅ |
| openai_responses genuine | 142+6 = **148** | input_tokens: 148 | ✅ |
| gemini genuine | round(142×1.05)+4 = **153** | promptTokenCount: 153 | ✅ |
| fake | 无 usage | 响应不含 usage | ✅ |

### 4. 推理题验证

- genuine：12 题全部答对（含计算过程 + `Answer: <正确答案>` 行，能被 questions.ts 的 extractAnswer/check 判对）
- downgraded：同一题连发 6 次 → 对/错交替（对 3 错 3），3 题抽测约对 1-2 题
- fake：全答 `Answer: 42`

## 已知问题 / 注意事项

1. **`gpt-6.1-sol` 类 OpenAI Responses 模型的 o200k 匹配**：usage 按「请求中的模型名」推断厂商系数，`glm`/`kimi`/`deepseek` 等走 openai_chat 协议时按各自系数（1.05/0.95/1.1）计数——与 calibration.ts 的 VENDOR_CALIBRATION 一致。
2. **downgraded 的交替计数是进程内全局状态**：按「推理题请求次数」奇偶交替，多客户端共享同一计数器。如果 probe 引擎一次检测发 3 题（目前 pickQuestions(3) 的实现是逐题串行发请求），会得到 对/错/对 = 2/3 正确；若检测顺序或重试不同，比例可能在 1/3~2/3 之间浮动——仍是「降智」特征（genuine 要求全对，flagship 模型全对判定不受影响）。
3. **fake 场景对 gemini 协议**：`modelVersion` 会被改写为 `some-random-model`（gemini 系模型名不含 claude/gpt）；`responseId` 为 "x123" 无前缀、无 usageMetadata。
4. **OpenAI Responses 流式的工具调用**：单条 `response.output_item.done` 事件 + completed 里的 function_call output item（adapters.ts 的 feedEvent 只在 output 数组里捕获 function_call，非流式路径已覆盖）。
5. **slow 场景与 probe 超时的关系**：TTFT 6-12s 可能触发 probe 的 TTFT 超时（20s 上限内）或总超时（30s 内，除非回复很长），这是设计意图（模拟慢上游）。
6. **仓库中存在其他并行修改**：`apps/web/**`、根 `package.json`、`apps/*/Dockerfile`（含一个不是我创建的 `apps/mock-upstream/Dockerfile`）在我工作期间被其他会话/编排者改动，与本任务无关，我未触碰。`pnpm-lock.yaml` 因本包加依赖而更新。
7. 未发现 `packages/probe` 的 bug 或契约问题；adapters.ts 的解析逻辑与 mock 的输出格式完全兼容（事件名、字段名、usage 字段均对齐）。

## 对其他角色的依赖 / 请求

- 无。db seed（§9）把渠道 base_url 指向 `http://127.0.0.1:8712/<scenario>` 即可直接使用。
