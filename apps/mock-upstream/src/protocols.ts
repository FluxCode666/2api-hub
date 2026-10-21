/*
 * 协议响应构造：OpenAI chat / OpenAI Responses / Anthropic Messages / Gemini
 * 四种协议的流式（SSE）与非流式响应，按 scenario 差异化协议特征。
 *
 * 消费方为 packages/probe/src/adapters.ts 的各 adapter（字段名与事件序列必须能被其解析）。
 */

import type { Protocol, Scenario } from './scenarios.js';
import { SCENARIO_BEHAVIORS } from './scenarios.js';
import { THINKING_TEXT, makeSignature } from './replies.js';

export interface ToolCallSpec {
  name: string;
  arguments: string;
  input: Record<string, unknown>;
}

export interface ReplyContext {
  scenario: Scenario;
  protocol: Protocol;
  /** 回显的模型名（fake 场景已被改写） */
  model: string;
  /** 回复文本（工具调用场景为空，thinking 文本单独放 thinking 字段） */
  text: string;
  /** usage 计数（fake 场景为 null，不返回 usage） */
  usage: { inputTokens: number; outputTokens: number } | null;
  /** 是否为工具调用请求 */
  toolCall: ToolCallSpec | null;
  /** anthropic thinking 请求：thinking 文本与 signature（downgraded 为空串） */
  thinking: { text: string; signature: string } | null;
  timing: { ttftMs: number; chunkIntervalMs: number };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 随机 id 后缀 */
function randId(n = 12): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** 按 3-4 字符切 chunk（模拟 token 级流式输出） */
function chunkify(text: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = Math.random() < 0.5 ? 3 : 4;
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks.length > 0 ? chunks : [''];
}

/** 流式写出函数：返回 false 表示连接已断，应停止 */
export type StreamWriter = (chunk: string) => boolean;

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseEvent(event: string, obj: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
}

// ---------------- OpenAI Chat Completions ----------------

function openaiChatId(scenario: Scenario): string {
  return SCENARIO_BEHAVIORS[scenario].shapeOk ? `chatcmpl-mock-${randId()}` : 'x123';
}

function openaiChatNonStream(ctx: ReplyContext): string {
  const id = openaiChatId(ctx.scenario);
  const shapeOk = SCENARIO_BEHAVIORS[ctx.scenario].shapeOk;
  if (ctx.toolCall) {
    const body: Record<string, unknown> = {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: ctx.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: ctx.toolCall.name, arguments: ctx.toolCall.arguments } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    if (shapeOk && ctx.usage) {
      body.usage = {
        prompt_tokens: ctx.usage.inputTokens,
        completion_tokens: ctx.usage.outputTokens,
        total_tokens: ctx.usage.inputTokens + ctx.usage.outputTokens,
      };
    }
    if (shapeOk) body.system_fingerprint = 'fp_mock';
    return JSON.stringify(body);
  }
  const body: Record<string, unknown> = {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: ctx.model,
    choices: [{ index: 0, message: { role: 'assistant', content: ctx.text }, finish_reason: 'stop' }],
  };
  if (shapeOk) body.system_fingerprint = 'fp_mock';
  if (shapeOk && ctx.usage) {
    body.usage = {
      prompt_tokens: ctx.usage.inputTokens,
      completion_tokens: ctx.usage.outputTokens,
      total_tokens: ctx.usage.inputTokens + ctx.usage.outputTokens,
    };
  }
  return JSON.stringify(body);
}

async function openaiChatStream(ctx: ReplyContext, write: StreamWriter): Promise<void> {
  const id = openaiChatId(ctx.scenario);
  const shapeOk = SCENARIO_BEHAVIORS[ctx.scenario].shapeOk;
  await sleep(ctx.timing.ttftMs);
  if (ctx.toolCall) {
    if (
      !write(
        sseData({
          id,
          object: 'chat.completion.chunk',
          model: ctx.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', type: 'function', function: { name: ctx.toolCall.name, arguments: ctx.toolCall.arguments } },
                ],
              },
            },
          ],
        }),
      )
    )
      return;
    await sleep(ctx.timing.chunkIntervalMs);
    write(sseData({ id, object: 'chat.completion.chunk', model: ctx.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    if (shapeOk && ctx.usage) {
      write(
        sseData({
          id,
          model: ctx.model,
          choices: [],
          usage: {
            prompt_tokens: ctx.usage.inputTokens,
            completion_tokens: ctx.usage.outputTokens,
            total_tokens: ctx.usage.inputTokens + ctx.usage.outputTokens,
          },
        }),
      );
    }
    write('data: [DONE]\n\n');
    return;
  }
  for (const chunk of chunkify(ctx.text)) {
    if (!write(sseData({ id, object: 'chat.completion.chunk', model: ctx.model, choices: [{ index: 0, delta: { content: chunk } }] }))) return;
    await sleep(ctx.timing.chunkIntervalMs);
  }
  write(sseData({ id, object: 'chat.completion.chunk', model: ctx.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  if (shapeOk && ctx.usage) {
    write(
      sseData({
        id,
        model: ctx.model,
        choices: [],
        usage: {
          prompt_tokens: ctx.usage.inputTokens,
          completion_tokens: ctx.usage.outputTokens,
          total_tokens: ctx.usage.inputTokens + ctx.usage.outputTokens,
        },
      }),
    );
  }
  write('data: [DONE]\n\n');
}

// ---------------- OpenAI Responses ----------------

function responsesId(scenario: Scenario): string {
  return SCENARIO_BEHAVIORS[scenario].shapeOk ? `resp_mock-${randId()}` : 'x123';
}

function responsesNonStream(ctx: ReplyContext): string {
  const id = responsesId(ctx.scenario);
  const shapeOk = SCENARIO_BEHAVIORS[ctx.scenario].shapeOk;
  const output: Record<string, unknown>[] = [];
  if (ctx.toolCall) {
    output.push({ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: ctx.toolCall.name, arguments: ctx.toolCall.arguments });
  } else {
    output.push({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: ctx.text }] });
  }
  const body: Record<string, unknown> = {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: ctx.model,
    output,
  };
  if (shapeOk && ctx.usage) {
    body.usage = { input_tokens: ctx.usage.inputTokens, output_tokens: ctx.usage.outputTokens };
  }
  return JSON.stringify(body);
}

async function responsesStream(ctx: ReplyContext, write: StreamWriter): Promise<void> {
  const id = responsesId(ctx.scenario);
  const shapeOk = SCENARIO_BEHAVIORS[ctx.scenario].shapeOk;
  write(sseEvent('response.created', { type: 'response.created', response: { id, model: ctx.model, status: 'in_progress' } }));
  await sleep(ctx.timing.ttftMs);
  if (ctx.toolCall) {
    if (!write(sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: ctx.toolCall.name, arguments: ctx.toolCall.arguments } }))) return;
  } else {
    for (const chunk of chunkify(ctx.text)) {
      if (!write(sseEvent('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: chunk }))) return;
      await sleep(ctx.timing.chunkIntervalMs);
    }
  }
  const completedResponse: Record<string, unknown> = { id, model: ctx.model, status: 'completed' };
  if (shapeOk && ctx.usage) {
    completedResponse.usage = { input_tokens: ctx.usage.inputTokens, output_tokens: ctx.usage.outputTokens };
  }
  completedResponse.output =
    ctx.toolCall
      ? [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: ctx.toolCall.name, arguments: ctx.toolCall.arguments }]
      : [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: ctx.text }] }];
  write(sseEvent('response.completed', { type: 'response.completed', response: completedResponse }));
}

// ---------------- Anthropic Messages ----------------

function anthropicId(scenario: Scenario): string {
  return SCENARIO_BEHAVIORS[scenario].shapeOk ? `msg_mock-${randId()}` : 'x123';
}

function anthropicUsageFields(ctx: ReplyContext): Record<string, number> | null {
  // genuine/downgraded：完整四字段 usage；fake：不返回
  if (!SCENARIO_BEHAVIORS[ctx.scenario].shapeOk || !ctx.usage) return null;
  return {
    input_tokens: ctx.usage.inputTokens,
    output_tokens: ctx.usage.outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function anthropicNonStream(ctx: ReplyContext): string {
  const id = anthropicId(ctx.scenario);
  const content: Record<string, unknown>[] = [];
  if (ctx.thinking) {
    content.push({ type: 'thinking', thinking: ctx.thinking.text, signature: ctx.thinking.signature });
  }
  if (ctx.toolCall) {
    content.push({ type: 'tool_use', id: 'toolu_1', name: ctx.toolCall.name, input: ctx.toolCall.input });
  } else {
    content.push({ type: 'text', text: ctx.text });
  }
  const body: Record<string, unknown> = {
    id,
    type: 'message',
    role: 'assistant',
    model: ctx.model,
    content,
    stop_reason: ctx.toolCall ? 'tool_use' : 'end_turn',
    stop_sequence: null,
  };
  const usage = anthropicUsageFields(ctx);
  if (usage) body.usage = usage;
  return JSON.stringify(body);
}

async function anthropicStream(ctx: ReplyContext, write: StreamWriter): Promise<void> {
  const id = anthropicId(ctx.scenario);
  const usage = anthropicUsageFields(ctx);
  const startUsage: Record<string, number> = usage
    ? { ...usage, output_tokens: 1 }
    : { input_tokens: 0, output_tokens: 1 };
  write(
    sseEvent('message_start', {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model: ctx.model, content: [], usage: startUsage },
    }),
  );
  await sleep(ctx.timing.ttftMs);
  let blockIndex = 0;
  // thinking 块（请求带 thinking 参数时）
  if (ctx.thinking) {
    write(sseEvent('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking', thinking: '', signature: '' } }));
    for (const chunk of chunkify(ctx.thinking.text)) {
      if (!write(sseEvent('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: chunk } }))) return;
      await sleep(ctx.timing.chunkIntervalMs);
    }
    write(sseEvent('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'signature_delta', signature: ctx.thinking.signature } }));
    write(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
    blockIndex += 1;
  }
  if (ctx.toolCall) {
    write(sseEvent('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: 'toolu_1', name: ctx.toolCall.name, input: {} } }));
    if (!write(sseEvent('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: ctx.toolCall.arguments } }))) return;
    write(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
    write(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: usage ? { output_tokens: usage.output_tokens } : {} }));
    write(sseEvent('message_stop', { type: 'message_stop' }));
    return;
  }
  write(sseEvent('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } }));
  for (const chunk of chunkify(ctx.text)) {
    if (!write(sseEvent('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: chunk } }))) return;
    await sleep(ctx.timing.chunkIntervalMs);
  }
  write(sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
  write(sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usage ? { output_tokens: usage.output_tokens } : {} }));
  write(sseEvent('message_stop', { type: 'message_stop' }));
}

// ---------------- Gemini ----------------

function geminiNonStream(ctx: ReplyContext): string {
  const shapeOk = SCENARIO_BEHAVIORS[ctx.scenario].shapeOk;
  const parts: Record<string, unknown>[] = [];
  if (ctx.toolCall) {
    parts.push({ functionCall: { name: ctx.toolCall.name, args: ctx.toolCall.input } });
  } else {
    parts.push({ text: ctx.text });
  }
  const body: Record<string, unknown> = {
    candidates: [{ content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 }],
    responseId: shapeOk ? `gemini-mock-${randId()}` : 'x123',
    modelVersion: ctx.model,
  };
  if (shapeOk && ctx.usage) {
    body.usageMetadata = {
      promptTokenCount: ctx.usage.inputTokens,
      candidatesTokenCount: ctx.usage.outputTokens,
      totalTokenCount: ctx.usage.inputTokens + ctx.usage.outputTokens,
    };
  }
  return JSON.stringify(body);
}

async function geminiStream(ctx: ReplyContext, write: StreamWriter): Promise<void> {
  const shapeOk = SCENARIO_BEHAVIORS[ctx.scenario].shapeOk;
  await sleep(ctx.timing.ttftMs);
  if (ctx.toolCall) {
    const chunk: Record<string, unknown> = {
      candidates: [{ content: { parts: [{ functionCall: { name: ctx.toolCall.name, args: ctx.toolCall.input } }], role: 'model' }, finishReason: 'STOP', index: 0 }],
      modelVersion: ctx.model,
    };
    if (shapeOk && ctx.usage) {
      chunk.usageMetadata = {
        promptTokenCount: ctx.usage.inputTokens,
        candidatesTokenCount: ctx.usage.outputTokens,
        totalTokenCount: ctx.usage.inputTokens + ctx.usage.outputTokens,
      };
    }
    write(sseData(chunk));
    return;
  }
  const chunks = chunkify(ctx.text);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const candidate: Record<string, unknown> = { content: { parts: [{ text: chunks[i] }], role: 'model' }, index: 0 };
    if (isLast) candidate.finishReason = 'STOP';
    const chunk: Record<string, unknown> = { candidates: [candidate], modelVersion: ctx.model };
    if (shapeOk && ctx.usage) {
      chunk.usageMetadata = {
        promptTokenCount: ctx.usage.inputTokens,
        candidatesTokenCount: ctx.usage.outputTokens,
        totalTokenCount: ctx.usage.inputTokens + ctx.usage.outputTokens,
      };
    }
    if (!write(sseData(chunk))) return;
    await sleep(ctx.timing.chunkIntervalMs);
  }
}

// ---------------- 对外入口 ----------------

/** 构造非流式响应体（JSON 字符串） */
export function buildNonStream(ctx: ReplyContext): string {
  switch (ctx.protocol) {
    case 'openai_chat':
      return openaiChatNonStream(ctx);
    case 'openai_responses':
      return responsesNonStream(ctx);
    case 'anthropic':
      return anthropicNonStream(ctx);
    case 'gemini':
      return geminiNonStream(ctx);
  }
}

/** 流式输出（SSE），按 timing 逐 chunk 写出 */
export async function writeStream(ctx: ReplyContext, write: StreamWriter): Promise<void> {
  switch (ctx.protocol) {
    case 'openai_chat':
      return openaiChatStream(ctx, write);
    case 'openai_responses':
      return responsesStream(ctx, write);
    case 'anthropic':
      return anthropicStream(ctx, write);
    case 'gemini':
      return geminiStream(ctx, write);
  }
}

/** 构造 anthropic thinking 块信息（按 scenario 决定 signature） */
export function thinkingFor(scenario: Scenario): { text: string; signature: string } | null {
  const b = SCENARIO_BEHAVIORS[scenario];
  if (b.thinkingSignature === 'generated') return { text: THINKING_TEXT, signature: makeSignature() };
  if (b.thinkingSignature === 'empty') return { text: THINKING_TEXT, signature: '' };
  return null;
}
