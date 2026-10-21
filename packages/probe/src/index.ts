/*
 * @hub/probe 对外 API（契约见 docs/SPEC.md §5.0）。
 * 全部公开函数永不抛异常（assertSafeUrl 除外）；Key 不出现在任何日志/错误信息中。
 */
import type {
  AuthenticityCheck,
  AuthenticityCheckId,
  AuthenticityReport,
  ChannelProtocol,
  ProbeResult,
  TrustVerdict,
} from '@hub/shared';
import { AUTH_CHECKS, verdictFromScore } from '@hub/shared';
import {
  consumeStream,
  emptyCapture,
  getAdapter,
  type ProtocolCapture,
  type StreamRequestPayload,
} from './adapters.js';
import { BENCHMARK_TEXT, checkTokenCountDiff } from './calibration.js';
import { readBodyLimited, safeFetch } from './http.js';
import { matchCatalogModelImpl, modelEchoMatches } from './match.js';
import { judgeQuestion, pickQuestions } from './questions.js';
import { assertSafeUrlImpl } from './ssrf.js';
import type {
  CatalogHint,
  ProbeOptions,
  ProbeTarget,
} from './types.js';
import {
  failureResult,
  httpStatusToErrorCode,
  networkErrorToCode,
  redactDeep,
  redactWithKey,
} from './types.js';

export interface UpstreamModelList { ok: boolean; models: string[]; errorCode: string | null; errorMessage: string | null }
export type AuthenticityResult = Omit<AuthenticityReport, 'id' | 'channelId' | 'trigger' | 'createdAt'>;

export class ProbeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ProbeError';
  }
}

// re-export 内部模块供测试与 mock 使用
export {
  BENCHMARK_TEXT,
  checkTokenCount,
  checkTokenCountDiff,
  expectedPureTokens,
  expectedTokenRange,
  O200K_BENCHMARK_TOKENS,
  TOKEN_COUNT_TOLERANCE,
  VENDOR_CALIBRATION,
} from './calibration.js';
export { matchCatalogModelImpl, modelEchoMatches, normalizeModelName } from './match.js';
export { judgeQuestion, pickQuestions, QUESTIONS, extractAnswer } from './questions.js';
export { isPrivateIp, UnsafeUrlError } from './ssrf.js';
export { SseParser, parseSse } from './sse.js';
export {
  anthropicAdapter,
  geminiAdapter,
  getAdapter,
  openaiChatAdapter,
  openaiResponsesAdapter,
  consumeStream,
  emptyCapture,
} from './adapters.js';
export type {
  BuiltRequest,
  ChatMessage,
  ProtocolCapture,
  ProtocolAdapter,
  StreamRequestPayload,
} from './adapters.js';
export type { CatalogHint, ProbeOptions, ProbeTarget } from './types.js';
export { httpStatusToErrorCode, redact } from './types.js';

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

function prepare(opts: ProbeOptions | undefined): { allowPrivate: boolean; timeoutMs: number } {
  return {
    allowPrivate: opts?.allowPrivate ?? process.env.ALLOW_PRIVATE_PROBE === 'true',
    timeoutMs: opts?.timeoutMs ?? 30_000,
  };
}

/** 流式请求未成功时的错误归类：无文本且无 tool_calls → empty_response */
function computeStreamErrorCode(capture: ProtocolCapture): 'empty_response' | null {
  if (capture.text.trim().length === 0 && capture.toolCalls === null) return 'empty_response';
  return null;
}

/** 发起流式请求并完整消费为 capture；错误归类到 ProbeResult（不抛异常） */
async function doStreamCapture(
  target: ProbeTarget,
  opts: ProbeOptions | undefined,
  payload: StreamRequestPayload,
): Promise<{
  capture: ProtocolCapture;
  result: ProbeResult;
  startedAt: number;
  ttftMs: number | null;
  sseOk: boolean;
  truncated: boolean;
}> {
  const adapter = getAdapter(target.protocol);
  const req = adapter.build(target.baseUrl, target.apiKey, payload, true);
  const p = prepare(opts);
  const startedAt = Date.now();
  const capture = emptyCapture();
  const firstTokenAt: { atMs: number | null } = { atMs: null };
  let ttftMs: number | null = null;
  try {
    const res = await safeFetch({
      url: req.url,
      method: 'POST',
      headers: req.headers,
      body: req.body,
      timeoutMs: p.timeoutMs,
      signal: opts?.signal,
      allowPrivate: p.allowPrivate,
    });
    if (!res.ok) {
      const { text } = await readBodyLimited(res);
      const err = new Error(`HTTP ${res.status}`);
      const { message } = networkErrorToCode(err, false);
      return {
        capture,
        result: failureResult(target, httpStatusToErrorCode(res.status), redactWithKey(text.slice(0, 300), target.apiKey) ?? message, res.status, startedAt),
        startedAt,
        ttftMs: null,
        sseOk: false,
        truncated: false,
      };
    }
    const { sseOk, truncated } = await consumeStream(res, adapter, capture, firstTokenAt, 2 * 1024 * 1024);
    ttftMs = firstTokenAt.atMs !== null ? firstTokenAt.atMs - startedAt : null;
    const latencyMs = Date.now() - startedAt;
    const outputTokens = capture.outputTokens;
    const durationSec = latencyMs > 0 ? latencyMs / 1000 : null;
    const tps = outputTokens !== null && outputTokens > 0 && durationSec && durationSec > 0 ? outputTokens / durationSec : null;
    const success = capture.text.trim().length > 0 || capture.toolCalls !== null;
    const result: ProbeResult = {
      success,
      model: target.model,
      protocol: target.protocol,
      httpStatus: res.status,
      errorCode: success ? null : computeStreamErrorCode(capture),
      errorMessage: null,
      latencyMs,
      ttftMs,
      inputTokens: capture.inputTokens,
      outputTokens,
      tokensPerSec: tps,
      sample: redactWithKey(capture.text.slice(0, 200), target.apiKey) || null,
      at: new Date().toISOString(),
    };
    return { capture, result, startedAt, ttftMs, sseOk, truncated };
  } catch (err) {
    const aborted = opts?.signal?.aborted === true;
    const { code, message } = networkErrorToCode(err, aborted);
    return {
      capture,
      result: failureResult(target, code, message, null, startedAt),
      startedAt,
      ttftMs: null,
      sseOk: false,
      truncated: false,
    };
  }
}

// ---------------------------------------------------------------------------
// probeAvailability（SPEC §5.2）
// ---------------------------------------------------------------------------

const PING_PROMPT = 'Reply with exactly: pong';

export async function probeAvailability(target: ProbeTarget, opts?: ProbeOptions): Promise<ProbeResult> {
  const payload: StreamRequestPayload = {
    model: target.model,
    messages: [{ role: 'user', content: PING_PROMPT }],
    maxTokens: 16,
  };
  const { result } = await doStreamCapture(target, opts, payload);
  // 成功判定：收到非空文本内容（HTTP 2xx 由 safeFetch !res.ok 分支保证）
  return result;
}

// ---------------------------------------------------------------------------
// listUpstreamModels（SPEC §5.1）
// ---------------------------------------------------------------------------

export async function listUpstreamModels(target: Omit<ProbeTarget, 'model'>, opts?: ProbeOptions): Promise<UpstreamModelList> {
  const allowPrivate = opts?.allowPrivate ?? process.env.ALLOW_PRIVATE_PROBE === 'true';
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const attempt = async (url: string, headers: Record<string, string>): Promise<UpstreamModelList> => {
    try {
      const res = await safeFetch({ url, method: 'GET', headers, timeoutMs, signal: opts?.signal, allowPrivate });
      const { text } = await readBodyLimited(res);
      if (!res.ok) {
        return { ok: false, models: [], errorCode: httpStatusToErrorCode(res.status), errorMessage: redactWithKey(text.slice(0, 200), target.apiKey) };
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, models: [], errorCode: 'invalid_response', errorMessage: '响应不是合法 JSON' };
      }
      // OpenAI: { data: [{ id }] }; Anthropic: { data: [{ id }] }; Gemini: { models: [{ name: "models/gemini-..." }] }
      const models: string[] = [];
      const obj = data as { data?: { id?: string }[]; models?: { name?: string }[] };
      if (Array.isArray(obj.data)) {
        for (const m of obj.data) {
          if (typeof m.id === 'string' && m.id) models.push(m.id);
        }
      } else if (Array.isArray(obj.models)) {
        for (const m of obj.models) {
          if (typeof m.name === 'string' && m.name) models.push(m.name.replace(/^models\//, ''));
        }
      }
      return { ok: true, models, errorCode: null, errorMessage: null };
    } catch (err) {
      const aborted = opts?.signal?.aborted === true;
      const { code, message } = networkErrorToCode(err, aborted);
      return { ok: false, models: [], errorCode: code, errorMessage: message };
    }
  };
  if (target.protocol === 'gemini') {
    const base = (await import('./adapters.js')).geminiBase(target.baseUrl);
    return attempt(`${base}/models`, { 'x-goog-api-key': target.apiKey });
  }
  // openai_chat / openai_responses / anthropic：先试 {base}/v1/models
  const { openaiBase } = await import('./adapters.js');
  const url = `${openaiBase(target.baseUrl)}/models`;
  const headers: Record<string, string> =
    target.protocol === 'anthropic'
      ? { 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01', authorization: `Bearer ${target.apiKey}` }
      : { authorization: `Bearer ${target.apiKey}` };
  return attempt(url, headers);
}

// ---------------------------------------------------------------------------
// probeAuthenticity（SPEC §5.3）
// ---------------------------------------------------------------------------

function vendorFromModelOrHint(target: ProbeTarget, hint: CatalogHint | null): string {
  if (hint?.vendorSlug) return hint.vendorSlug;
  // 从模型名猜厂商（openai 系 / claude / gemini / deepseek / grok / glm / kimi / doubao）
  const m = target.model.toLowerCase();
  if (m.includes('claude') || m.includes('anthropic')) return 'anthropic';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('openai')) return 'openai';
  if (m.includes('gemini') || m.includes('google')) return 'google';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('grok')) return 'xai';
  if (m.includes('glm')) return 'zhipu';
  if (m.includes('kimi')) return 'moonshot';
  if (m.includes('doubao') || m.includes('seedance')) return 'bytedance';
  return 'unknown';
}

interface CheckOutcome {
  passed: boolean | null;
  detail: string;
  score?: number;
  evidence?: Record<string, unknown>;
}

function makeCheck(id: AuthenticityCheckId, outcome: CheckOutcome): AuthenticityCheck {
  const meta = AUTH_CHECKS.find((c) => c.id === id);
  return {
    id,
    name: meta?.name ?? id,
    passed: outcome.passed,
    weight: meta?.weight ?? 0,
    ...(outcome.score !== undefined ? { score: outcome.score } : {}),
    detail: outcome.detail,
    ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
  };
}

/** 协议特征检查（response_shape，15 分） */
function checkResponseShape(protocol: ChannelProtocol, capture: ProtocolCapture, sseOk: boolean): CheckOutcome {
  const notes: string[] = [];
  let ok = true;
  const id = capture.responseId;
  if (protocol === 'anthropic') {
    if (!id || !id.startsWith('msg_')) {
      ok = false;
      notes.push(`id 前缀非 msg_（${id ?? '缺失'}）`);
    }
    if (sseOk && capture.eventSequence.length > 0) {
      const seq = capture.eventSequence;
      const hasStart = seq.includes('message_start');
      const hasStop = seq.includes('message_stop') || seq.length >= 3;
      if (!hasStart || !hasStop) {
        ok = false;
        notes.push(`事件序列缺少 message_start/message_stop（${seq.slice(0, 6).join(',')}…）`);
      }
    }
    const raw = capture.raw as { usage?: { cache_creation_input_tokens?: number } } | null;
    if (raw?.usage && !('cache_creation_input_tokens' in raw.usage)) {
      ok = false;
      notes.push('usage 缺少 cache_* 字段');
    }
  } else if (protocol === 'openai_chat') {
    if (!id || !(id.startsWith('chatcmpl-') || id.startsWith('chatcmpl_'))) {
      ok = false;
      notes.push(`id 前缀非 chatcmpl-（${id ?? '缺失'}）`);
    }
  } else if (protocol === 'openai_responses') {
    if (!id || !id.startsWith('resp_')) {
      ok = false;
      notes.push(`id 前缀非 resp_（${id ?? '缺失'}）`);
    }
    if (sseOk && capture.eventSequence.length > 0) {
      const seq = capture.eventSequence;
      if (!seq.includes('response.output_text.delta')) {
        ok = false;
        notes.push('缺少 response.output_text.delta 事件');
      }
      if (!seq.includes('response.completed') && !seq.includes('response.failed')) {
        ok = false;
        notes.push('缺少 response.completed 事件');
      }
    }
  } else {
    // gemini：SSE chunk 均为 candidates/usageMetadata 结构
    if (sseOk && capture.eventSequence.length === 0) {
      ok = false;
      notes.push('无任何合法 chunk');
    }
    if (capture.raw === null && capture.text === '' && capture.inputTokens === null) {
      ok = false;
      notes.push('响应缺少 candidates/usageMetadata 结构');
    }
  }
  if (capture.inputTokens === null && capture.outputTokens === null) {
    ok = false;
    notes.push('缺少 usage 计数');
  }
  return {
    passed: ok,
    detail: ok ? '协议特征符合官方响应格式' : notes.join('；') || '协议特征异常',
    evidence: { responseId: id, eventSequence: capture.eventSequence.slice(0, 10) },
  };
}

function buildTokenCountDiffDetail(
  tc: { passed: boolean | null; expected: number; range: [number, number]; source: string; diff: number | null },
  usage1: number | null,
  usage2: number | null,
): string {
  if (tc.passed === null) return '上游未返回 usage.input_tokens，无法评估（差分法需要 1×/2× 两次计数）';
  const rangeStr = `[${tc.range[0]}, ${tc.range[1]}]`;
  const diffStr = tc.diff !== null ? `差值 ${tc.diff}` : '差值不可用';
  if (tc.passed) {
    return `差分法通过：usage(2×)=${usage2} − usage(1×)=${usage1} → 纯文本 ${tc.diff}，落在期望区间 ${rangeStr}（期望 ${tc.expected}，${tc.source}）`;
  }
  if (tc.diff !== null && tc.diff <= 0) {
    return `差分法失败：2× 请求计数未增长（${usage1} → ${usage2}），usage 疑似伪造常量`;
  }
  return `差分法失败：纯文本 ${tc.diff} 偏离期望区间 ${rangeStr}（期望 ${tc.expected}）——疑似换皮模型`;
}

/** 知识与身份检查（knowledge，10 分）——弱信号 */
function checkKnowledge(text: string, vendor: string): CheckOutcome {
  if (!text) return { passed: null, detail: '无回复内容，无法评估' };
  const t = text.toLowerCase();
  const vendorNames: Record<string, string[]> = {
    anthropic: ['claude', 'anthropic'],
    openai: ['chatgpt', 'openai', 'gpt'],
    google: ['gemini', 'google', 'bard'],
    deepseek: ['deepseek'],
    xai: ['grok', 'xai'],
    zhipu: ['glm', '智谱', 'zhipu', 'chatglm'],
    moonshot: ['kimi', '月之暗面', 'moonshot'],
    bytedance: ['doubao', '豆包', 'bytedance'],
  };
  const names = vendorNames[vendor];
  if (!names) return { passed: null, detail: '未知厂商，跳过身份比对' };
  const mentioned = names.filter((n) => t.includes(n));
  const wrongMention: string[] = [];
  for (const [v, ns] of Object.entries(vendorNames)) {
    if (v === vendor) continue;
    for (const n of ns) {
      if (t.includes(n)) wrongMention.push(n);
    }
  }
  if (wrongMention.length > 0 && mentioned.length === 0) {
    return {
      passed: false,
      detail: `自称是其他厂商模型（提到 ${wrongMention[0]}），与目录厂商 ${vendor} 不符`,
      evidence: { mentioned: wrongMention },
    };
  }
  return {
    passed: mentioned.length > 0 || wrongMention.length === 0,
    detail: mentioned.length > 0
      ? `身份表述与厂商 ${vendor} 一致`
      : '回复未明确否认身份（弱信号，不计负分）',
  };
}

/** 能力特征检查（capability，10 分）：Anthropic thinking / OpenAI tool_calls / Gemini functionCall */
function checkCapability(protocol: ChannelProtocol, capture: ProtocolCapture): CheckOutcome {
  if (protocol === 'anthropic') {
    if (capture.thinkingSignature && capture.thinkingSignature.length >= 32) {
      return { passed: true, detail: '返回 thinking 块且带合法 signature' };
    }
    if (capture.thinkingText && !capture.thinkingSignature) {
      return { passed: false, detail: '有 thinking 内容但缺少 signature（官方必有）' };
    }
    return { passed: false, detail: '未返回 thinking 块或 signature 缺失' };
  }
  if (protocol === 'openai_chat' || protocol === 'openai_responses') {
    if (capture.toolCalls && capture.toolCalls.length > 0) {
      return { passed: true, detail: `tool_calls 格式正确（${capture.toolCalls.length} 个调用）` };
    }
    return { passed: false, detail: '未返回 tool_calls' };
  }
  // gemini
  if (capture.toolCalls && capture.toolCalls.length > 0) {
    return { passed: true, detail: '返回 functionCall 结构' };
  }
  return { passed: false, detail: '未返回 functionCall' };
}

/** 输出速度检查（speed，5 分） */
function checkSpeed(result: ProbeResult, hint: CatalogHint | null): CheckOutcome {
  const tps = result.tokensPerSec;
  const expected = hint?.expectedTps ?? null;
  if (tps === null || tps <= 0) return { passed: null, detail: '无有效 tokens/s 数据' };
  if (expected === null || expected <= 0) {
    // 无目录参考：宽泛区间 5–500 tps
    const ok = tps >= 3 && tps <= 600;
    return { passed: ok, detail: `${tps.toFixed(1)} tokens/s（无目录参考，按宽泛区间判定）` };
  }
  // 宽松：期望的 20% – 10 倍
  const ok = tps >= expected * 0.2 && tps <= expected * 10;
  return {
    passed: ok,
    detail: `${tps.toFixed(1)} tokens/s，期望约 ${expected}（宽松区间 ${Math.round(expected * 0.2)}–${expected * 10}）`,
  };
}

/** 推理检查（reasoning，20 分）：3 道题，flagship 要求全对 */
async function runReasoningChecks(
  target: ProbeTarget,
  opts: ProbeOptions | undefined,
  hint: CatalogHint | null,
  timeBudgetMs: number,
): Promise<{ check: AuthenticityCheck; captures: ProtocolCapture[] }> {
  const questions = pickQuestions(3);
  const startedAt = Date.now();
  const captures: ProtocolCapture[] = [];
  let correct = 0;
  const details: string[] = [];
  const perQuestion: { id: string; ok: boolean; expected: string }[] = [];
  for (const q of questions) {
    if (Date.now() - startedAt > timeBudgetMs) {
      details.push('时间预算不足，剩余题目跳过');
      break;
    }
    const payload: StreamRequestPayload = {
      model: target.model,
      messages: [{ role: 'user', content: q.prompt }],
      maxTokens: 512,
    };
    const { capture, result } = await doStreamCapture(target, { ...opts, timeoutMs: Math.min(opts?.timeoutMs ?? 30_000, 45_000) }, payload);
    captures.push(capture);
    if (result.success) {
      const ok = judgeQuestion(q, capture.text);
      if (ok) correct += 1;
      perQuestion.push({ id: q.id, ok, expected: q.expected });
    } else {
      perQuestion.push({ id: q.id, ok: false, expected: q.expected });
      details.push(`题目 ${q.id} 请求失败: ${result.errorCode ?? 'unknown'}`);
    }
  }
  const total = perQuestion.length;
  const ratio = total > 0 ? correct / total : 0;
  const isFlagship = hint?.tier === 'flagship';
  const passed = total === 3 && (isFlagship ? correct === 3 : correct >= 2);
  const detail = `答对 ${correct}/${total}${isFlagship ? '（flagship 要求全对）' : '（要求 ≥2/3）'}${details.length > 0 ? '；' + details.join('；') : ''}`;
  return {
    check: makeCheck('reasoning', {
      passed: total > 0 ? passed : null,
      score: ratio,
      detail,
      evidence: { questions: perQuestion },
    }),
    captures,
  };
}

/** 能力探测请求（capability 检查用）：构造带 tools/thinking 的请求 */
function capabilityPayload(target: ProbeTarget, protocol: ChannelProtocol): StreamRequestPayload {
  const base: StreamRequestPayload = {
    model: target.model,
    messages: [
      { role: 'user', content: 'What is the weather in Beijing? Use the provided tool.' },
    ],
    maxTokens: 256,
  };
  const weatherTool = {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather of a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  };
  if (protocol === 'anthropic') {
    return {
      ...base,
      extra: {
        thinking: { type: 'enabled', budget_tokens: 1024 },
        tools: [{ name: 'get_weather', description: 'Get current weather of a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
        tool_choice: { type: 'auto' },
      },
    };
  }
  if (protocol === 'gemini') {
    return {
      ...base,
      extra: {
        tools: [{ functionDeclarations: [{ name: 'get_weather', description: 'Get current weather of a city', parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' } }, required: ['city'] } }] }],
      },
    };
  }
  return { ...base, extra: { tools: [weatherTool], tool_choice: 'auto' } };
}

export async function probeAuthenticity(
  target: ProbeTarget,
  hint: CatalogHint | null,
  opts?: ProbeOptions & { quick?: boolean },
): Promise<AuthenticityResult> {
  const startedAll = Date.now();
  const quick = opts?.quick === true;
  const vendor = vendorFromModelOrHint(target, hint);
  const checks: AuthenticityCheck[] = [];
  const captures: ProtocolCapture[] = [];

  // ---- 1. 连通性 + 基准请求（token_count + model_echo + response_shape 数据源）----
  const benchPayload: StreamRequestPayload = {
    model: target.model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: '请用一句话介绍你自己，并说明你的知识截止时间。' },
    ],
    maxTokens: 300,
  };
  const bench = await doStreamCapture(target, opts, benchPayload);
  captures.push(bench.capture);

  // connectivity（10）
  checks.push(makeCheck('connectivity', {
    passed: bench.result.success,
    detail: bench.result.success
      ? `连通正常（HTTP ${bench.result.httpStatus}，延迟 ${bench.result.latencyMs ?? '?'}ms）`
      : `连通失败（${bench.result.errorCode ?? 'unknown'}：${redactWithKey(bench.result.errorMessage, target.apiKey) ?? ''}）`,
  }));
  if (!bench.result.success) {
    // 连通性失败 → 其余检查不执行
    const score = 0;
    return {
      model: target.model,
      protocol: target.protocol,
      score,
      verdict: verdictFromScore(score, 10),
      checks,
      durationMs: Date.now() - startedAll,
    };
  }

  // model_echo（10）
  const echoOk = modelEchoMatches(target.model, bench.capture.modelEcho);
  checks.push(makeCheck('model_echo', {
    passed: echoOk,
    detail: echoOk
      ? `回显模型名一致（${bench.capture.modelEcho ?? target.model}）`
      : `回显模型名 ${bench.capture.modelEcho ?? '（缺失）'} 与请求 ${target.model} 不符`,
    evidence: { requested: target.model, echoed: bench.capture.modelEcho },
  }));

  // response_shape（15）
  checks.push(makeCheck('response_shape', checkResponseShape(target.protocol, bench.capture, bench.sseOk)));

  // token_count（20）：差分法——分别发送 1× 与 2× 基准文本，
  // usage(2×) − usage(1×) = 纯文本 token 数（协议开销相减消除），
  // 与厂商纯文本期望区间（±8%）比较。可检测组合从 14/56 提升到 26/56。
  const vendorSlug = hint?.vendorSlug ?? vendor;
  const bench2Payload: StreamRequestPayload = {
    model: target.model,
    messages: [
      { role: 'system', content: 'You are a translation assistant.' },
      { role: 'user', content: BENCHMARK_TEXT },
    ],
    maxTokens: 512,
  };
  const bench2 = await doStreamCapture(target, opts, bench2Payload);
  captures.push(bench2.capture);
  const bench2xPayload: StreamRequestPayload = {
    model: target.model,
    messages: [
      { role: 'system', content: 'You are a translation assistant.' },
      { role: 'user', content: `${BENCHMARK_TEXT}\n\n${BENCHMARK_TEXT}` },
    ],
    maxTokens: 512,
  };
  const bench2x = await doStreamCapture(target, opts, bench2xPayload);
  captures.push(bench2x.capture);
  const tokenCheckDiff = checkTokenCountDiff(vendorSlug, bench2.capture.inputTokens, bench2x.capture.inputTokens);
  checks.push(makeCheck('token_count', {
    passed: tokenCheckDiff.passed,
    detail: buildTokenCountDiffDetail(tokenCheckDiff, bench2.capture.inputTokens, bench2x.capture.inputTokens),
    evidence: {
      usage1x: bench2.capture.inputTokens,
      usage2x: bench2x.capture.inputTokens,
      diff: tokenCheckDiff.diff,
      expected: tokenCheckDiff.expected,
      range: tokenCheckDiff.range,
      source: tokenCheckDiff.source,
    },
  }));

  // knowledge（10）：基于第一个基准请求的回复文本（要求自我介绍）
  checks.push(makeCheck('knowledge', checkKnowledge(bench.capture.text, vendorSlug)));

  // reasoning（20）：3 道题
  const reasoningBudget = quick ? 20_000 : 60_000;
  const reasoning = await runReasoningChecks(target, opts, hint, reasoningBudget);
  checks.push(reasoning.check);

  // capability（10）：quick 模式跳过
  if (quick) {
    checks.push(makeCheck('capability', { passed: null, detail: '快速模式跳过 capability 检查' }));
  } else {
    const capPayload = capabilityPayload(target, target.protocol);
    const cap = await doStreamCapture(target, { ...opts, timeoutMs: Math.min(opts?.timeoutMs ?? 30_000, 45_000) }, capPayload);
    captures.push(cap.capture);
    checks.push(makeCheck('capability', checkCapability(target.protocol, cap.capture)));
  }

  // speed（5）：基于基准请求
  checks.push(makeCheck('speed', checkSpeed(bench.result, hint)));

  // ---- 评分 ----
  let executedWeight = 0;
  let passedWeight = 0;
  for (const c of checks) {
    if (c.passed === null) continue;
    executedWeight += c.weight;
    // 有 score 的部分给分（如 reasoning 2/3）
    if (c.id === 'reasoning' && typeof (c as { score?: number }).score === 'number') {
      passedWeight += c.weight * ((c as { score: number }).score);
    } else if (c.passed) {
      passedWeight += c.weight;
    }
  }
  const score = executedWeight > 0 ? Math.round((passedWeight / executedWeight) * 100) : 0;
  const verdict: TrustVerdict = verdictFromScore(score, executedWeight);

  // P1 修复：报告出口按真实 apiKey 深度脱敏（check.detail / evidence 中
  // 可能嵌有上游回显的错误原文，含自定义格式 Key）
  const report: AuthenticityResult = {
    model: target.model,
    protocol: target.protocol,
    score,
    verdict,
    checks: redactDeep(checks, target.apiKey),
    durationMs: Date.now() - startedAll,
  };
  return report;
}

// ---------------------------------------------------------------------------
// matchCatalogModel（SPEC §5.0）
// ---------------------------------------------------------------------------

export function matchCatalogModel(
  upstreamName: string,
  catalog: { id: number; slug: string; aliases: string[] }[],
): number | null {
  return matchCatalogModelImpl(upstreamName, catalog);
}

// ---------------------------------------------------------------------------
// assertSafeUrl（SPEC §5.4）
// ---------------------------------------------------------------------------

export async function assertSafeUrl(url: string, allowPrivate?: boolean): Promise<void> {
  await assertSafeUrlImpl(url, allowPrivate);
}
