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
  redactThenTruncate,
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

/** 临时性错误：429 / 5xx / timeout / network / dns / tls——真伪检测中可重试、重试后仍失败记 null 不计分 */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set(['http_429', 'http_5xx', 'timeout', 'network', 'dns', 'tls']);

export function isTransientErrorCode(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && TRANSIENT_ERROR_CODES.has(code);
}

/** 流式请求未成功时的错误归类：无文本且无 tool_calls → empty_response */
function computeStreamErrorCode(capture: ProtocolCapture): 'empty_response' | null {
  if (capture.text.trim().length === 0 && capture.toolCalls === null) return 'empty_response';
  return null;
}

/** SPEC §5.2：TTFT 独立超时 20s（首内容 token 未在此时间内到达则中止） */
const TTFT_TIMEOUT_MS = 20_000;

/** 外部 signal（总预算）是否已中止——预算中止不归类为 TTFT 超时（由上层按预算处理） */
function budgetSignalAborted(opts: ProbeOptions | undefined): boolean {
  return opts?.signal?.aborted === true;
}

/** 发起流式请求并完整消费为 capture；错误归类到 ProbeResult（不抛异常）。
 * payload.expectText=false 的请求（如纯工具调用探测）不做 TTFT 超时——
 * 合法响应可能没有任何文本 delta（只有 tool_use/thinking）。 */
async function doStreamCapture(
  target: ProbeTarget,
  opts: ProbeOptions | undefined,
  payload: StreamRequestPayload & { expectText?: boolean },
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
        result: failureResult(target, httpStatusToErrorCode(res.status), redactThenTruncate(text, target.apiKey, 300) ?? message, res.status, startedAt),
        startedAt,
        ttftMs: null,
        sseOk: false,
        truncated: false,
      };
    }
    // TTFT 独立计时（P1#6）：首个内容 token 20s 未到 → 中止流，判 timeout。
    // 仅对预期有文本的请求启用（expectText 默认 true；capability 纯工具调用探测为 false）
    const expectText = payload.expectText !== false;
    const ttftTimer = expectText
      ? setTimeout(() => {
          if (firstTokenAt.atMs === null) {
            void res.body?.cancel().catch(() => {});
          }
        }, Math.min(TTFT_TIMEOUT_MS, p.timeoutMs))
      : null;
    let sseOk = false;
    let truncated = false;
    try {
      ({ sseOk, truncated } = await consumeStream(res, adapter, capture, firstTokenAt, 2 * 1024 * 1024));
    } finally {
      if (ttftTimer !== null) clearTimeout(ttftTimer);
    }
    // P2#12：流内错误终态（OpenAI error 事件 / response.failed / Anthropic error / Gemini error）→ 失败
    if (capture.streamError !== null) {
      return {
        capture,
        result: failureResult(target, 'invalid_response', `流内错误终态：${capture.streamError}`, res.status, startedAt),
        startedAt,
        ttftMs: null,
        sseOk: false,
        truncated: false,
      };
    }
    if (expectText && firstTokenAt.atMs === null && p.timeoutMs > TTFT_TIMEOUT_MS && !budgetSignalAborted(opts)) {
      // 首内容 token 20s 内未到达且总超时未到——SPEC：TTFT 超时
      return {
        capture,
        result: failureResult(target, 'timeout', 'TTFT 超时（20s 内无首内容 token）', res.status, startedAt),
        startedAt,
        ttftMs: null,
        sseOk: false,
        truncated: false,
      };
    }
    ttftMs = firstTokenAt.atMs !== null ? firstTokenAt.atMs - startedAt : null;
    const latencyMs = Date.now() - startedAt;
    const outputTokens = capture.outputTokens;
    const durationSec = latencyMs > 0 ? latencyMs / 1000 : null;
    const tps = outputTokens !== null && outputTokens > 0 && durationSec && durationSec > 0 ? outputTokens / durationSec : null;
    // P2#12：空 tool_calls 数组不算成功——必须非空 tool_calls 或非空文本
    const hasToolCalls = Array.isArray(capture.toolCalls) && capture.toolCalls.length > 0;
    const success = capture.text.trim().length > 0 || hasToolCalls;
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
      sample: redactThenTruncate(capture.text, target.apiKey, 200) || null,
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

/** 重试参数（SPEC 修订：真伪检测的子请求遇临时错误退避重试，最多 2 次） */
const RETRY_MAX = 2;
const RETRY_BACKOFF_MS = 800;
const RETRY_AFTER_CAP_MS = 5_000;

/**
 * 带临时错误重试的 doStreamCapture（真伪检测专用，可用性探测不重试——
 * 可用性本身就是衡量失败率）。
 * - 临时错误（429/5xx/timeout/network/dns/tls）：退避重试最多 RETRY_MAX 次；
 *   429 时遵守 Retry-After（上限 5s）
 * - 重试拿到有效响应 → 正常返回（检查照常计分）
 * - 重试后仍临时失败 → 返回原始失败（调用方将该项记 passed: null 不计分）
 */
async function doStreamCaptureWithRetry(
  target: ProbeTarget,
  opts: ProbeOptions | undefined,
  payload: StreamRequestPayload,
): Promise<Awaited<ReturnType<typeof doStreamCapture>>> {
  let last = await doStreamCapture(target, opts, payload);
  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    const code = last.result.errorCode;
    const transient = last.result.success ? false : isTransientErrorCode(code);
    if (!transient) return last;
    // 429 时读取 Retry-After（doStreamCapture 未透传 header，此处保守用固定退避 + 抖动；
    // 上游返回 Retry-After 的场景由 backoff 梯度近似覆盖）
    const jitter = Math.random() * 300;
    const backoff = Math.min(RETRY_BACKOFF_MS * (attempt + 1) + jitter, RETRY_AFTER_CAP_MS);
    // P1#6：退避等待可被外部 signal（总预算）打断
    await new Promise<void>((r) => {
      const t = setTimeout(r, backoff);
      if (opts?.signal) {
        const onAbort = () => { clearTimeout(t); r(); };
        if (opts.signal.aborted) { clearTimeout(t); r(); return; }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    if (opts?.signal?.aborted) {
      // 预算耗尽：不再重试，直接返回（调用方按预算未执行处理）
      return { ...last, result: { ...last.result, errorCode: 'timeout', errorMessage: '检测时间预算耗尽' } };
    }
    last = await doStreamCapture(target, opts, payload);
  }
  return last;
}

// ---------------------------------------------------------------------------
// probeAvailability（SPEC §5.2）
// ---------------------------------------------------------------------------

const PING_PROMPT = 'Reply with exactly: pong';

export async function probeAvailability(target: ProbeTarget, opts?: ProbeOptions): Promise<ProbeResult> {
  // P2#12：公开函数外层兜底——绝不抛异常（审查发现 modelEcho 非字符串曾致 TypeError）
  try {
    const payload: StreamRequestPayload = {
      model: target.model,
      messages: [{ role: 'user', content: PING_PROMPT }],
      maxTokens: 16,
    };
    const { result } = await doStreamCapture(target, opts, payload);
    // 成功判定：收到非空文本内容（HTTP 2xx 由 safeFetch !res.ok 分支保证）
    return result;
  } catch (err) {
    const { code, message } = networkErrorToCode(err, opts?.signal?.aborted === true);
    return failureResult(target, code, message, null);
  }
}

// ---------------------------------------------------------------------------
// listUpstreamModels（SPEC §5.1）
// ---------------------------------------------------------------------------

export async function listUpstreamModels(target: Omit<ProbeTarget, 'model'>, opts?: ProbeOptions): Promise<UpstreamModelList> {
  // P2#12：公开函数外层兜底——绝不抛异常
  try {
    return await listUpstreamModelsImpl(target, opts);
  } catch (err) {
    const { code, message } = networkErrorToCode(err, opts?.signal?.aborted === true);
    return { ok: false, models: [], errorCode: code, errorMessage: message };
  }
}

async function listUpstreamModelsImpl(target: Omit<ProbeTarget, 'model'>, opts?: ProbeOptions): Promise<UpstreamModelList> {
  const allowPrivate = opts?.allowPrivate ?? process.env.ALLOW_PRIVATE_PROBE === 'true';
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const attempt = async (url: string, headers: Record<string, string>): Promise<UpstreamModelList> => {
    try {
      const res = await safeFetch({ url, method: 'GET', headers, timeoutMs, signal: opts?.signal, allowPrivate });
      const { text } = await readBodyLimited(res);
      if (!res.ok) {
        return { ok: false, models: [], errorCode: httpStatusToErrorCode(res.status), errorMessage: redactThenTruncate(text, target.apiKey, 200) };
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
  const judged: { id: string; ok: boolean; expected: string }[] = [];
  const transient: { id: string; code: string }[] = [];
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
    const { capture, result } = await doStreamCaptureWithRetry(target, { ...opts, timeoutMs: Math.min(opts?.timeoutMs ?? 30_000, 45_000) }, payload);
    captures.push(capture);
    if (result.success) {
      const ok = judgeQuestion(q, capture.text);
      if (ok) correct += 1;
      judged.push({ id: q.id, ok, expected: q.expected });
    } else if (isTransientErrorCode(result.errorCode)) {
      // 临时错误（重试后仍 429/5xx/超时）：该题不参与计分（不是答错）
      transient.push({ id: q.id, code: result.errorCode ?? 'unknown' });
    } else {
      judged.push({ id: q.id, ok: false, expected: q.expected });
      details.push(`题目 ${q.id} 请求失败: ${result.errorCode ?? 'unknown'}`);
    }
  }
  // 只用「拿到有效响应」的题计分；全部临时失败 → null（不执行）
  const total = judged.length;
  const ratio = total > 0 ? correct / total : 0;
  const isFlagship = hint?.tier === 'flagship';
  const required = isFlagship ? total : Math.max(2, Math.ceil(total * 2 / 3));
  const passed = total >= 2 && correct >= Math.min(required, total);
  const transientNote = transient.length > 0
    ? `；${transient.length} 题因上游临时错误（${transient.map((t) => t.code).join('/')}）未计分`
    : '';
  const detail = `答对 ${correct}/${total}${isFlagship ? '（flagship 要求全对）' : '（要求 ≥2/3）'}${transientNote}${details.length > 0 ? '；' + details.join('；') : ''}`;
  return {
    check: makeCheck('reasoning', {
      passed: total >= 2 ? passed : null,
      score: total >= 2 ? ratio : undefined,
      detail,
      evidence: { questions: judged, transientSkipped: transient },
    }),
    captures,
  };
}

/** 能力探测请求（capability 检查用）：构造带 tools/thinking 的请求
 * P2#11 修复：anthropic 的 thinking.budget_tokens 必须 < max_tokens（官方约束，
 * 否则真实 API 400）；openai_responses 的 tools 用顶层 {type,name,parameters} 结构。 */
function capabilityPayload(target: ProbeTarget, protocol: ChannelProtocol): StreamRequestPayload {
  const base: StreamRequestPayload = {
    model: target.model,
    messages: [
      { role: 'user', content: 'What is the weather in Beijing? Use the provided tool.' },
    ],
    maxTokens: 2048,
  };
  if (protocol === 'anthropic') {
    return {
      ...base,
      // 纯工具调用探测：可能无文本 delta（thinking + tool_use），不做 TTFT 超时
      expectText: false,
      extra: {
        thinking: { type: 'enabled', budget_tokens: 1024 }, // 1024 < max_tokens 2048 ✓
        tools: [{ name: 'get_weather', description: 'Get current weather of a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
        tool_choice: { type: 'auto' },
      },
    };
  }
  if (protocol === 'gemini') {
    return {
      ...base,
      expectText: false,
      extra: {
        tools: [{ functionDeclarations: [{ name: 'get_weather', description: 'Get current weather of a city', parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' } }, required: ['city'] } }] }],
      },
    };
  }
  if (protocol === 'openai_responses') {
    return {
      ...base,
      expectText: false,
      extra: {
        // Responses API：顶层 {type:'function', name, parameters}（无 function 嵌套）
        tools: [{ type: 'function', name: 'get_weather', description: 'Get current weather of a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      },
    };
  }
  // openai_chat：嵌套结构
  return {
    ...base,
    expectText: false,
    extra: {
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather of a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      }],
      tool_choice: 'auto',
    },
  };
}

/** connectivity 检查结果构造：成功 / 临时错误（null 不计分）/ 真实连通失败 */
function buildConnectivityOutcome(
  bench: { result: ProbeResult },
  transientFail: boolean,
  apiKey: string,
): CheckOutcome {
  if (bench.result.success) {
    return { passed: true, detail: `连通正常（HTTP ${bench.result.httpStatus}，延迟 ${bench.result.latencyMs ?? '?'}ms）` };
  }
  if (transientFail) {
    return { passed: null, detail: `上游临时错误（${bench.result.errorCode}），重试 ${RETRY_MAX} 次后仍失败，本项未计分` };
  }
  return {
    passed: false,
    detail: `连通失败（${bench.result.errorCode ?? 'unknown'}：${redactWithKey(bench.result.errorMessage, apiKey) ?? ''}）`,
  };
}

/** 真伪检测总预算（P1#6 修复）：quick 强制 60s 上限；非 quick 默认 180s（可配） */
const QUICK_TOTAL_BUDGET_MS = 60_000;
const DEFAULT_TOTAL_BUDGET_MS = 180_000;

export async function probeAuthenticity(
  target: ProbeTarget,
  hint: CatalogHint | null,
  opts?: ProbeOptions & { quick?: boolean; totalBudgetMs?: number },
): Promise<AuthenticityResult> {
  // P2#12：公开函数外层兜底——绝不抛异常；内部任何未捕获异常降级为 unknown 报告
  try {
    return await probeAuthenticityImpl(target, hint, opts);
  } catch (err) {
    const { message } = networkErrorToCode(err, opts?.signal?.aborted === true);
    const meta = AUTH_CHECKS.find((c) => c.id === 'connectivity');
    return {
      model: target.model,
      protocol: target.protocol,
      score: null,
      verdict: 'unknown',
      checks: [{
        id: 'connectivity',
        name: meta?.name ?? '连通性',
        passed: null,
        weight: meta?.weight ?? 0,
        detail: `检测过程内部错误（已兜底）：${redactThenTruncate(message, target.apiKey, 200)}`,
      }],
      durationMs: 0,
    };
  }
}

async function probeAuthenticityImpl(
  target: ProbeTarget,
  hint: CatalogHint | null,
  opts?: ProbeOptions & { quick?: boolean; totalBudgetMs?: number },
): Promise<AuthenticityResult> {
  const startedAll = Date.now();
  const quick = opts?.quick === true;
  // 总 deadline：quick 模式无论 timeoutMs 传什么都强制 60s 上限
  const budgetMs = quick
    ? Math.min(opts?.totalBudgetMs ?? QUICK_TOTAL_BUDGET_MS, QUICK_TOTAL_BUDGET_MS)
    : (opts?.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS);
  const deadline = startedAll + budgetMs;
  // 组合 AbortSignal：DNS、所有子请求、读取流、重试退避共享剩余预算；
  // 与外部传入 signal 取 any（任一触发即中止）
  const budgetSignal = AbortSignal.timeout(budgetMs);
  const combinedSignal = opts?.signal ? AbortSignal.any([opts.signal, budgetSignal]) : budgetSignal;
  const budgetOpts: ProbeOptions = { ...opts, signal: combinedSignal };
  const vendor = vendorFromModelOrHint(target, hint);
  const checks: AuthenticityCheck[] = [];
  const captures: ProtocolCapture[] = [];
  /** 预算是否已耗尽（signal 触发或超 deadline） */
  const budgetExhausted = (): boolean => combinedSignal.aborted || Date.now() >= deadline;
  /** 把尚未生成的检查批量标记为未执行（临时错误 / 预算耗尽两种 reason） */
  const markRemainingSkipped = (reason: 'transient' | 'budget'): void => {
    const allIds: AuthenticityCheckId[] = ['connectivity', 'model_echo', 'response_shape', 'token_count', 'knowledge', 'reasoning', 'capability', 'speed'];
    const pending = allIds.filter((id) => !checks.some((c) => c.id === id));
    for (const id of pending) {
      const meta = AUTH_CHECKS.find((c) => c.id === id);
      checks.push({
        id,
        name: meta?.name ?? id,
        passed: null,
        weight: meta?.weight ?? 0,
        detail: reason === 'budget' ? '检测时间预算耗尽，本项未执行' : '基准请求因上游临时错误未获得有效响应，本项未计分',
      });
    }
  };

  // ---- 1. 连通性 + 基准请求（token_count + model_echo + response_shape 数据源）----
  const benchPayload: StreamRequestPayload = {
    model: target.model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: '请用一句话介绍你自己，并说明你的知识截止时间。' },
    ],
    maxTokens: 300,
  };
  const bench = await doStreamCaptureWithRetry(target, budgetOpts, benchPayload);
  captures.push(bench.capture);

  // connectivity（10）：临时错误（重试后仍 429/5xx/超时）→ null 不计分，
  // 不再把被限流的正规渠道冤枉成连通失败
  const benchTransientFail = !bench.result.success && isTransientErrorCode(bench.result.errorCode);
  const connectivityOutcome = buildConnectivityOutcome(bench, benchTransientFail, target.apiKey);
  checks.push(makeCheck('connectivity', connectivityOutcome));
  if (benchTransientFail || budgetExhausted()) {
    // 基准请求是后续检查的数据源：临时错误 / 预算耗尽时后续检查全部未执行 → 权重不足判 unknown
    const score = null;
    const executedWeight = 10; // 只有 connectivity 权重 10，但 passed=null 不计入
    markRemainingSkipped(benchTransientFail ? 'transient' : 'budget');
    return {
      model: target.model,
      protocol: target.protocol,
      score,
      verdict: verdictFromScore(score, executedWeight),
      checks,
      durationMs: Date.now() - startedAll,
    };
  }
  if (!bench.result.success) {
    // 真实连通性失败（401/403/404 等）→ 其余检查不执行
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
  if (budgetExhausted()) {
    markRemainingSkipped('budget');
    // 走到评分统一出口
  } else {
  const bench2 = await doStreamCaptureWithRetry(target, budgetOpts, bench2Payload);
  captures.push(bench2.capture);
  const bench2xPayload: StreamRequestPayload = {
    model: target.model,
    messages: [
      { role: 'system', content: 'You are a translation assistant.' },
      { role: 'user', content: `${BENCHMARK_TEXT}\n\n${BENCHMARK_TEXT}` },
    ],
    maxTokens: 512,
  };
  const bench2x = await doStreamCaptureWithRetry(target, budgetOpts, bench2xPayload);
  captures.push(bench2x.capture);
  const tokenTransient = (!bench2.result.success && isTransientErrorCode(bench2.result.errorCode))
    || (!bench2x.result.success && isTransientErrorCode(bench2x.result.errorCode));
  const tokenCheckDiff = checkTokenCountDiff(vendorSlug, bench2.capture.inputTokens, bench2x.capture.inputTokens);
  const tokenTransientCode = !bench2.result.success ? bench2.result.errorCode : bench2x.result.errorCode;
  checks.push(makeCheck('token_count', {
    passed: tokenTransient ? null : tokenCheckDiff.passed,
    detail: tokenTransient
      ? `上游临时错误（${tokenTransientCode}），重试 ${RETRY_MAX} 次后仍失败，本项未计分`
      : buildTokenCountDiffDetail(tokenCheckDiff, bench2.capture.inputTokens, bench2x.capture.inputTokens),
    evidence: {
      usage1x: bench2.capture.inputTokens,
      usage2x: bench2x.capture.inputTokens,
      diff: tokenCheckDiff.diff,
      expected: tokenCheckDiff.expected,
      range: tokenCheckDiff.range,
      source: tokenCheckDiff.source,
    },
  }));
  } // end token_count budget guard

  // knowledge（10）：基于第一个基准请求的回复文本（要求自我介绍）
  checks.push(makeCheck('knowledge', checkKnowledge(bench.capture.text, vendorSlug)));

  // reasoning（20）：3 道题（预算检查在函数内部逐题进行）
  if (!budgetExhausted()) {
    const remainingBudget = Math.max(1, deadline - Date.now());
    const reasoningBudget = Math.min(quick ? 20_000 : 60_000, remainingBudget);
    const reasoning = await runReasoningChecks(target, budgetOpts, hint, reasoningBudget);
    checks.push(reasoning.check);
  } else {
    const meta = AUTH_CHECKS.find((c) => c.id === 'reasoning');
    checks.push({ id: 'reasoning', name: meta?.name ?? 'reasoning', passed: null, weight: meta?.weight ?? 0, detail: '检测时间预算耗尽，本项未执行' });
  }

  // capability（10）：quick 模式跳过
  if (quick) {
    checks.push(makeCheck('capability', { passed: null, detail: '快速模式跳过 capability 检查' }));
  } else if (budgetExhausted()) {
    const meta = AUTH_CHECKS.find((c) => c.id === 'capability');
    checks.push({ id: 'capability', name: meta?.name ?? 'capability', passed: null, weight: meta?.weight ?? 0, detail: '检测时间预算耗尽，本项未执行' });
  } else {
    const capPayload = capabilityPayload(target, target.protocol);
    const cap = await doStreamCaptureWithRetry(target, { ...budgetOpts, timeoutMs: Math.min(opts?.timeoutMs ?? 30_000, 45_000) }, capPayload);
    captures.push(cap.capture);
    if (!cap.result.success && (isTransientErrorCode(cap.result.errorCode) || combinedSignal.aborted)) {
      checks.push(makeCheck('capability', {
        passed: null,
        detail: combinedSignal.aborted
          ? '检测时间预算耗尽，本项未计分'
          : `上游临时错误（${cap.result.errorCode}），重试 ${RETRY_MAX} 次后仍失败，本项未计分`,
      }));
    } else {
      checks.push(makeCheck('capability', checkCapability(target.protocol, cap.capture)));
    }
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
  const score = executedWeight > 0 ? Math.round((passedWeight / executedWeight) * 100) : null;
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
