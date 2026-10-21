/*
 * 协议适配层：统一 4 种协议的请求构造与流式/非流式响应解析。
 *
 * 每种协议实现：
 * - buildRequest(payload) → { url, headers, body }
 * - parseStreamEvent(ev) → 增量文本 / usage / 回显模型等（供流式消费）
 * - parseFullResponse(text) → 完整响应的统一抽取
 *
 * 统一抽取结构 ProtocolCapture：
 * - text：全部文本内容
 * - thinkingText：thinking/推理内容（Anthropic thinking 块）
 * - thinkingSignature：thinking signature（真 Anthropic 特征）
 * - modelEcho：响应中回显的模型名
 * - inputTokens / outputTokens：usage
 * - shapeOk / shapeDetail：协议特征检查结果（id 前缀、事件序列、usage 字段等）
 * - toolCalls：工具调用原文（capability 检查用）
 * - raw：原始 JSON（调试）
 */

import type { ChannelProtocol } from '@hub/shared';
import { SseParser, parseJsonData, type RawSseEvent } from './sse.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 首 token 时间标记：各 adapter 在产出首个内容 delta 时记录时间戳（仅一次） */
export interface FirstTokenMark {
  atMs: number | null;
}

export interface StreamRequestPayload {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** 附加字段（如 tools、thinking 配置） */
  extra?: Record<string, unknown>;
}

export interface BuiltRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface ProtocolCapture {
  text: string;
  thinkingText: string | null;
  thinkingSignature: string | null;
  modelEcho: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** 协议特征检查（response_shape 检查用）：null = 无法评估（如非流式无事件序列） */
  shapeOk: boolean | null;
  shapeDetail: string;
  /** tool_calls / functionCall 原始内容 */
  toolCalls: unknown[] | null;
  /** 事件类型序列（流式），用于特征检查 */
  eventSequence: string[];
  /** 响应 id */
  responseId: string | null;
  /** finish/stop 原因 */
  stopReason: string | null;
  /** 原始最终响应对象（非流式为整个 JSON；流式为聚合元数据） */
  raw: unknown;
}

export function emptyCapture(): ProtocolCapture {
  return {
    text: '',
    thinkingText: null,
    thinkingSignature: null,
    modelEcho: null,
    inputTokens: null,
    outputTokens: null,
    shapeOk: null,
    shapeDetail: '',
    toolCalls: null,
    eventSequence: [],
    responseId: null,
    stopReason: null,
    raw: null,
  };
}

/** base_url 规范化：去掉尾部 /，若已以 /v1 结尾则不重复拼接（openai 系）；anthropic/gemini 各自处理 */
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  return `${b}${path}`;
}

export function openaiBase(base: string): string {
  const b = base.replace(/\/+$/, '');
  return /\/v\d+(beta)?$/.test(b) ? b : `${b}/v1`;
}

export function geminiBase(base: string): string {
  const b = base.replace(/\/+$/, '');
  return /\/v\d+beta$/.test(b) ? b : `${b}/v1beta`;
}

// ---------------- OpenAI Chat Completions ----------------

export const openaiChatAdapter = {
  build(baseUrl: string, apiKey: string, payload: StreamRequestPayload, stream: boolean): BuiltRequest {
    const url = `${openaiBase(baseUrl)}/chat/completions`;
    const body: Record<string, unknown> = {
      model: payload.model,
      messages: payload.messages,
      max_tokens: payload.maxTokens ?? 1024,
      stream,
    };
    if (payload.extra) Object.assign(body, payload.extra);
    return {
      url,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    };
  },

  /** 解析一条 SSE 事件，增量更新 capture */
  feedEvent(capture: ProtocolCapture, ev: RawSseEvent, firstTokenAt: FirstTokenMark): string | null {
    const data = parseJsonData<{
      id?: string;
      model?: string;
      choices?: { delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: unknown[] }; finish_reason?: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    }>(ev);
    if (!data) return null;
    capture.eventSequence.push('chunk');
    if (data.id && !capture.responseId) capture.responseId = data.id;
    if (data.model) capture.modelEcho = data.model;
    const choice = data.choices?.[0];
    let delta: string | null = null;
    if (choice?.delta?.content) {
      delta = choice.delta.content;
      if (firstTokenAt.atMs === null) firstTokenAt.atMs = Date.now();
      capture.text += choice.delta.content;
    }
    if (choice?.delta?.reasoning_content) {
      capture.thinkingText = (capture.thinkingText ?? '') + choice.delta.reasoning_content;
    }
    if (choice?.delta?.tool_calls) {
      capture.toolCalls = [...(capture.toolCalls ?? []), ...choice.delta.tool_calls];
    }
    if (choice?.finish_reason) capture.stopReason = choice.finish_reason;
    if (data.usage) {
      capture.inputTokens = data.usage.prompt_tokens ?? capture.inputTokens;
      capture.outputTokens = data.usage.completion_tokens ?? capture.outputTokens;
    }
    return delta;
  },

  /** 非流式完整响应解析 */
  parseFull(capture: ProtocolCapture, bodyText: string): void {
    let data: {
      id?: string;
      model?: string;
      choices?: { message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: unknown[] }; finish_reason?: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      system_fingerprint?: string;
    } | null = null;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return;
    }
    if (!data) return;
    capture.raw = data;
    if (data.id) capture.responseId = data.id;
    if (data.model) capture.modelEcho = data.model;
    const msg = data.choices?.[0]?.message;
    if (msg?.content) capture.text += msg.content;
    if (msg?.reasoning_content) capture.thinkingText = (capture.thinkingText ?? '') + msg.reasoning_content;
    if (msg?.tool_calls) capture.toolCalls = msg.tool_calls;
    if (data.choices?.[0]?.finish_reason) capture.stopReason = data.choices[0]?.finish_reason ?? null;
    if (data.system_fingerprint) {
      capture.eventSequence.push('system_fingerprint');
    }
    if (data.usage) {
      capture.inputTokens = data.usage.prompt_tokens ?? null;
      capture.outputTokens = data.usage.completion_tokens ?? null;
    }
  },
};

// ---------------- OpenAI Responses API ----------------

export const openaiResponsesAdapter = {
  build(baseUrl: string, apiKey: string, payload: StreamRequestPayload, stream: boolean): BuiltRequest {
    const url = `${openaiBase(baseUrl)}/responses`;
    const body: Record<string, unknown> = {
      model: payload.model,
      input: payload.messages.map((m) => ({ role: m.role, content: m.content })),
      max_output_tokens: payload.maxTokens ?? 1024,
      stream,
    };
    if (payload.extra) Object.assign(body, payload.extra);
    return {
      url,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    };
  },

  feedEvent(capture: ProtocolCapture, ev: RawSseEvent, firstTokenAt: FirstTokenMark): string | null {
    const data = parseJsonData<{
      type?: string;
      response?: { id?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number }; output?: unknown[] };
      delta?: string;
    }>(ev);
    if (!data || !data.type) return null;
    capture.eventSequence.push(data.type);
    let delta: string | null = null;
    switch (data.type) {
      case 'response.created':
      case 'response.in_progress': {
        if (data.response?.id) capture.responseId = data.response.id;
        if (data.response?.model) capture.modelEcho = data.response.model;
        break;
      }
      case 'response.output_text.delta': {
        if (typeof data.delta === 'string' && data.delta) {
          delta = data.delta;
          if (firstTokenAt.atMs === null) firstTokenAt.atMs = Date.now();
          capture.text += data.delta;
        }
        break;
      }
      case 'response.completed': {
        if (data.response?.id) capture.responseId = data.response.id;
        if (data.response?.model) capture.modelEcho = data.response.model;
        if (data.response?.usage) {
          capture.inputTokens = data.response.usage.input_tokens ?? capture.inputTokens;
          capture.outputTokens = data.response.usage.output_tokens ?? capture.outputTokens;
        }
        capture.raw = data.response;
        // output 数组中提取 reasoning / tool_calls
        const output = data.response?.output;
        if (Array.isArray(output)) {
          for (const item of output as { type?: string; summary?: { text?: string }[]; text?: string; signature?: string; arguments?: string; name?: string }[]) {
            if (item?.type === 'reasoning' && Array.isArray(item.summary)) {
              capture.thinkingText = (capture.thinkingText ?? '') + item.summary.map((s) => s.text ?? '').join('');
              if (item.signature) capture.thinkingSignature = item.signature;
            }
            if (item?.type === 'message' && Array.isArray((item as { content?: { text?: string }[] }).content)) {
              for (const c of (item as { content?: { text?: string }[] }).content ?? []) {
                if (typeof c?.text === 'string') capture.text += '';
              }
            }
            if (item?.type === 'function_call') {
              capture.toolCalls = [...(capture.toolCalls ?? []), item];
            }
          }
        }
        capture.stopReason = 'completed';
        break;
      }
      case 'response.failed':
      case 'response.incomplete': {
        capture.stopReason = data.type.replace('response.', '');
        capture.raw = data.response;
        break;
      }
      default:
        break;
    }
    return delta;
  },

  parseFull(capture: ProtocolCapture, bodyText: string): void {
    let data: {
      id?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number };
      output?: { type?: string; content?: { text?: string; type?: string }[]; summary?: { text?: string }[]; signature?: string; name?: string; arguments?: string }[];
      status?: string; incomplete_details?: unknown;
    } | null = null;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return;
    }
    if (!data) return;
    capture.raw = data;
    if (data.id) capture.responseId = data.id;
    if (data.model) capture.modelEcho = data.model;
    if (data.usage) {
      capture.inputTokens = data.usage.input_tokens ?? null;
      capture.outputTokens = data.usage.output_tokens ?? null;
    }
    for (const item of data.output ?? []) {
      if (item.type === 'reasoning') {
        capture.thinkingText = (capture.thinkingText ?? '') + (item.summary ?? []).map((s) => s.text ?? '').join('');
        if (item.signature) capture.thinkingSignature = item.signature;
      } else if (item.type === 'message') {
        for (const c of item.content ?? []) {
          if (typeof c?.text === 'string') capture.text += c.text;
        }
      } else if (item.type === 'function_call') {
        capture.toolCalls = [...(capture.toolCalls ?? []), item];
      }
    }
    capture.stopReason = data.status ?? null;
  },
};

// ---------------- Anthropic Messages ----------------

export const anthropicAdapter = {
  build(baseUrl: string, apiKey: string, payload: StreamRequestPayload, stream: boolean): BuiltRequest {
    // anthropic 官方 path 为 /v1/messages；base 若已带 /v1 则不重复
    const b = baseUrl.replace(/\/+$/, '');
    const url = /\/v1$/.test(b) ? `${b}/messages` : `${b}/v1/messages`;
    const msgs = payload.messages.filter((m) => m.role !== 'system');
    const system = payload.messages.flatMap((m) => (m.role === 'system' ? [m.content] : [])).join('\n\n');
    const body: Record<string, unknown> = {
      model: payload.model,
      messages: msgs,
      max_tokens: payload.maxTokens ?? 1024,
      stream,
    };
    if (system) body.system = system;
    if (payload.extra) Object.assign(body, payload.extra);
    return {
      url,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    };
  },

  feedEvent(capture: ProtocolCapture, ev: RawSseEvent, firstTokenAt: FirstTokenMark): string | null {
    // anthropic 事件名在 event: 行，data 里也有 type
    const data = parseJsonData<{
      type?: string;
      message?: { id?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      index?: number;
      content_block?: { type?: string; thinking?: string; signature?: string; text?: string; name?: string };
      delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string };
      usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
      error?: { type?: string; message?: string };
    }>(ev);
    if (!data) return null;
    const type = data.type ?? ev.event ?? '';
    capture.eventSequence.push(type);
    let delta: string | null = null;
    switch (type) {
      case 'message_start': {
        if (data.message?.id) capture.responseId = data.message.id;
        if (data.message?.model) capture.modelEcho = data.message.model;
        if (data.message?.usage) {
          capture.inputTokens = data.message.usage.input_tokens ?? capture.inputTokens;
          capture.outputTokens = data.message.usage.output_tokens ?? capture.outputTokens;
        }
        break;
      }
      case 'content_block_start': {
        const block = data.content_block;
        if (block?.type === 'thinking') {
          if (block.thinking) capture.thinkingText = (capture.thinkingText ?? '') + block.thinking;
          if (block.signature) capture.thinkingSignature = block.signature;
        } else if (block?.type === 'text') {
          if (block.text) {
            delta = block.text;
            if (firstTokenAt.atMs === null) firstTokenAt.atMs = Date.now();
            capture.text += block.text;
          }
        } else if (block?.type === 'tool_use') {
          capture.toolCalls = [...(capture.toolCalls ?? []), { name: block.name, index: data.index }];
        }
        break;
      }
      case 'content_block_delta': {
        const d = data.delta;
        if (d?.type === 'text_delta' && d.text) {
          delta = d.text;
          if (firstTokenAt.atMs === null) firstTokenAt.atMs = Date.now();
          capture.text += d.text;
        } else if (d?.type === 'thinking_delta' && d.thinking) {
          capture.thinkingText = (capture.thinkingText ?? '') + d.thinking;
        } else if (d?.type === 'signature_delta' && d.signature) {
          capture.thinkingSignature = d.signature;
        } else if (d?.type === 'input_json_delta' && d.partial_json) {
          capture.toolCalls = [...(capture.toolCalls ?? []), { partial_json: d.partial_json, index: data.index }];
        }
        break;
      }
      case 'message_delta': {
        if (data.delta?.stop_reason) capture.stopReason = data.delta.stop_reason;
        if (data.usage) {
          capture.outputTokens = data.usage.output_tokens ?? capture.outputTokens;
          capture.inputTokens = data.usage.input_tokens ?? capture.inputTokens;
        }
        break;
      }
      case 'error': {
        capture.stopReason = `error:${data.error?.type ?? 'unknown'}`;
        break;
      }
      default:
        break; // ping / message_stop / content_block_stop
    }
    return delta;
  },

  parseFull(capture: ProtocolCapture, bodyText: string): void {
    let data: {
      id?: string; type?: string; model?: string; role?: string;
      content?: { type?: string; text?: string; thinking?: string; signature?: string; name?: string; input?: unknown }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    } | null = null;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return;
    }
    if (!data) return;
    capture.raw = data;
    if (data.id) capture.responseId = data.id;
    if (data.model) capture.modelEcho = data.model;
    if (data.type) capture.eventSequence.push(data.type);
    for (const block of data.content ?? []) {
      if (block.type === 'text' && block.text) capture.text += block.text;
      if (block.type === 'thinking') {
        capture.thinkingText = (capture.thinkingText ?? '') + (block.thinking ?? '');
        if (block.signature) capture.thinkingSignature = block.signature;
      }
      if (block.type === 'tool_use') capture.toolCalls = [...(capture.toolCalls ?? []), block];
    }
    if (data.stop_reason) capture.stopReason = data.stop_reason;
    if (data.usage) {
      capture.inputTokens = data.usage.input_tokens ?? null;
      capture.outputTokens = data.usage.output_tokens ?? null;
    }
  },
};

// ---------------- Gemini ----------------

export const geminiAdapter = {
  build(baseUrl: string, apiKey: string, payload: StreamRequestPayload, stream: boolean): BuiltRequest {
    const base = geminiBase(baseUrl);
    const url = stream
      ? `${base}/models/${encodeURIComponent(payload.model)}:streamGenerateContent?alt=sse`
      : `${base}/models/${encodeURIComponent(payload.model)}:generateContent`;
    const contents = payload.messages.flatMap((m) => {
      if (m.role === 'system') return [];
      const role = m.role === 'assistant' ? 'model' : 'user';
      return [{ role, parts: [{ text: m.content }] }];
    });
    const systemParts = payload.messages.flatMap((m) => (m.role === 'system' ? [{ text: m.content }] : []));
    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: payload.maxTokens ?? 1024 },
    };
    if (systemParts.length > 0) body.systemInstruction = { parts: systemParts };
    if (payload.extra) Object.assign(body, payload.extra);
    return {
      url,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    };
  },

  feedEvent(capture: ProtocolCapture, ev: RawSseEvent, firstTokenAt: FirstTokenMark): string | null {
    const data = parseJsonData<{
      candidates?: { content?: { parts?: { text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown } }[]; role?: string }; finishReason?: string; index?: number }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
      responseId?: string;
      modelVersion?: string;
    }>(ev);
    if (!data) return null;
    capture.eventSequence.push('chunk');
    let delta: string | null = null;
    if (data.responseId && !capture.responseId) capture.responseId = data.responseId;
    if (data.modelVersion) capture.modelEcho = data.modelVersion;
    const cand = data.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text) {
        if (part.thought === true) {
          capture.thinkingText = (capture.thinkingText ?? '') + part.text;
        } else {
          delta = part.text;
          if (firstTokenAt.atMs === null) firstTokenAt.atMs = Date.now();
          capture.text += part.text;
        }
      }
      if (part.functionCall) {
        capture.toolCalls = [...(capture.toolCalls ?? []), part.functionCall];
      }
    }
    if (cand?.finishReason) capture.stopReason = cand.finishReason;
    if (data.usageMetadata) {
      capture.inputTokens = data.usageMetadata.promptTokenCount ?? capture.inputTokens;
      capture.outputTokens = data.usageMetadata.candidatesTokenCount ?? capture.outputTokens;
    }
    return delta;
  },

  parseFull(capture: ProtocolCapture, bodyText: string): void {
    let data: {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean; functionCall?: unknown }[]; role?: string }; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      responseId?: string; modelVersion?: string;
    } | null = null;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return;
    }
    if (!data) return;
    capture.raw = data;
    if (data.responseId) capture.responseId = data.responseId;
    if (data.modelVersion) capture.modelEcho = data.modelVersion;
    const cand = data.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text) {
        if (part.thought === true) capture.thinkingText = (capture.thinkingText ?? '') + part.text;
        else capture.text += part.text;
      }
      if (part.functionCall) capture.toolCalls = [...(capture.toolCalls ?? []), part.functionCall];
    }
    if (cand?.finishReason) capture.stopReason = cand.finishReason;
    if (data.usageMetadata) {
      capture.inputTokens = data.usageMetadata.promptTokenCount ?? null;
      capture.outputTokens = data.usageMetadata.candidatesTokenCount ?? null;
    }
  },
};

// ---------------- 工厂 ----------------

export interface ProtocolAdapter {
  build(baseUrl: string, apiKey: string, payload: StreamRequestPayload, stream: boolean): BuiltRequest;
  feedEvent(capture: ProtocolCapture, ev: RawSseEvent, firstTokenAt: FirstTokenMark): string | null;
  parseFull(capture: ProtocolCapture, bodyText: string): void;
}

export function getAdapter(protocol: ChannelProtocol): ProtocolAdapter {
  switch (protocol) {
    case 'openai_chat': return openaiChatAdapter;
    case 'openai_responses': return openaiResponsesAdapter;
    case 'anthropic': return anthropicAdapter;
    case 'gemini': return geminiAdapter;
    default: {
      const never: never = protocol;
      throw new Error(`未知协议: ${String(never)}`);
    }
  }
}

/**
 * 流式读取响应并聚合为 capture。
 * 返回 null 表示响应体不是合法 SSE 流（invalid_response）。
 */
export async function consumeStream(
  res: { body: ReadableStream<Uint8Array> | null },
  adapter: ProtocolAdapter,
  capture: ProtocolCapture,
  firstTokenAt: FirstTokenMark,
  maxBytes = 2 * 1024 * 1024,
): Promise<{ sseOk: boolean; truncated: boolean }> {
  const parser = new SseParser();
  const reader = res.body?.getReader();
  if (!reader) return { sseOk: false, truncated: false };
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let total = 0;
  let truncated = false;
  let sawAnyEvent = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      break;
    }
    const text = decoder.decode(value, { stream: true });
    const events = parser.feed(text);
    for (const ev of events) {
      sawAnyEvent = true;
      adapter.feedEvent(capture, ev, firstTokenAt);
    }
  }
  const tail = parser.flush();
  for (const ev of tail) {
    sawAnyEvent = true;
    adapter.feedEvent(capture, ev, firstTokenAt);
  }
  return { sseOk: sawAnyEvent, truncated };
}
