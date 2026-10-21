/*
 * 共享类型（内部使用）+ 错误分类辅助。
 */
import type { AuthenticityReport, ChannelProtocol, ModelTier, ProbeErrorCode, ProbeResult } from '@hub/shared';

export interface ProbeTarget { baseUrl: string; apiKey: string; protocol: ChannelProtocol; model: string }
export interface ProbeOptions { timeoutMs?: number; allowPrivate?: boolean; signal?: AbortSignal }
export interface CatalogHint {
  slug: string;
  vendorSlug: string;
  tier: ModelTier;
  knowledgeCutoff: string | null;
  expectedTps: number | null;
}
export interface UpstreamModelList { ok: boolean; models: string[]; errorCode: string | null; errorMessage: string | null }
export type AuthenticityResult = Omit<AuthenticityReport, 'id' | 'channelId' | 'trigger' | 'createdAt'>;

export interface ProbeError {
  code: string;
  message: string;
}

/** HTTP 状态码 → ProbeErrorCode */
export function httpStatusToErrorCode(status: number): ProbeErrorCode {
  if (status === 401) return 'http_401';
  if (status === 403) return 'http_403';
  if (status === 404) return 'http_404';
  if (status === 429) return 'http_429';
  if (status >= 500) return 'http_5xx';
  return 'http_4xx';
}

/** fetch/网络异常 → ProbeErrorCode + 脱敏 message（不含 key/url 凭据） */
export function networkErrorToCode(err: unknown, signalAborted: boolean): { code: ProbeErrorCode; message: string } {
  if (signalAborted) return { code: 'timeout', message: '请求超时' };
  const e = err as { name?: string; message?: string; cause?: { code?: string; name?: string } };
  const causeCode = e?.cause?.code;
  const name = e?.name ?? '';
  if (name === 'AbortError' || signalAborted) return { code: 'timeout', message: '请求超时' };
  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN' || /getaddrinfo/i.test(e?.message ?? '')) {
    return { code: 'dns', message: '域名解析失败' };
  }
  if (causeCode === 'CERT_HAS_EXPIRED' || causeCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || causeCode === 'SELF_SIGNED_CERT_IN_CHAIN' || causeCode === 'ERR_TLS_CERT_ALTNAME_INVALID' || name === 'TLS_ERROR' || /certificate|tls/i.test(e?.message ?? '')) {
    return { code: 'tls', message: 'TLS/证书错误' };
  }
  if (causeCode === 'ECONNREFUSED' || causeCode === 'ECONNRESET' || causeCode === 'EPIPE' || causeCode === 'EHOSTUNREACH' || causeCode === 'ENETUNREACH' || causeCode === 'ETIMEDOUT' || causeCode === 'ECONNABORTED') {
    return { code: 'network', message: '网络连接失败' };
  }
  if (name === 'TypeError' && /fetch/i.test(e?.message ?? '')) return { code: 'network', message: '网络请求失败' };
  return { code: 'network', message: '网络错误' };
}

/** 构造一个失败的 ProbeResult（不含 key） */
export function failureResult(
  target: ProbeTarget,
  errorCode: ProbeErrorCode | null,
  errorMessage: string | null,
  httpStatus: number | null = null,
  startedAt = Date.now(),
): ProbeResult {
  return {
    success: false,
    model: target.model,
    protocol: target.protocol,
    httpStatus,
    errorCode,
    errorMessage: redactWithKey(errorMessage, target.apiKey),
    latencyMs: Date.now() - startedAt,
    ttftMs: null,
    inputTokens: null,
    outputTokens: null,
    tokensPerSec: null,
    sample: null,
    at: new Date().toISOString(),
  };
}

/** 通用格式脱敏（无真实 Key 时兑底）：常见 Key 形态 + 凭据头 */
export function redact(text: string | null): string | null {
  if (!text) return text;
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-****')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ****')
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, 'AIza****')
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '****');
}

/**
 * 按真实 Key 精确脱敏（P1 修复）：在 probe 边界用实际 apiKey 及其常见变体
 * 对所有对外输出做替换。变体覆盖：原样、URL 编码、URL 查询编码、base64、
 * base64url、JSON 字符串转义。Key 过短（<8 字符）时不生效（避免误伤普通词）。
 * 兑底再叠一层 redact() 的格式匹配。
 */
export function redactWithKey(text: string | null, apiKey: string | undefined | null): string | null {
  if (!text) return text;
  let out = text;
  if (apiKey && apiKey.length >= 8) {
    const variants = new Set<string>([apiKey]);
    try {
      variants.add(encodeURIComponent(apiKey));
      variants.add(encodeURI(apiKey));
    } catch {
      // ignore
    }
    try {
      variants.add(Buffer.from(apiKey, 'utf8').toString('base64'));
      variants.add(Buffer.from(apiKey, 'utf8').toString('base64url'));
    } catch {
      // ignore
    }
    try {
      variants.add(JSON.stringify(apiKey).slice(1, -1)); // 字符串内部的转义形式
    } catch {
      // ignore
    }
    // 长变体优先替换，避免短变体先匹配破坏长变体
    for (const v of [...variants].sort((a, b) => b.length - a.length)) {
      if (v.length >= 8) {
        out = out.split(v).join('[REDACTED]');
      }
    }
    // Key 本体可能出现在 Authorization/x-api-key 头附近的原文里已被上面覆盖；
    // 若 Key 含正则特殊字符，split/join 也是字面量替换，安全。
  }
  return redact(out);
}

/** 深度遍历对象，对其中的所有字符串做按真实 Key 的精确脱敏（evidence 等嵌套结构） */
export function redactDeep<T>(value: T, apiKey: string | undefined | null): T {
  if (typeof value === 'string') {
    // SAFETY: redactWithKey 只改字符串内容不改类型，断言仅为还原泛型 T（运行时形状未变）
    return redactWithKey(value, apiKey) as unknown as T;
  }
  if (Array.isArray(value)) {
    // SAFETY: map 只替换字符串叶子，数组长度与元素结构不变，断言仅为还原泛型 T
    return value.map((v) => redactDeep(v, apiKey)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, apiKey);
    }
    return out as T;
  }
  return value;
}

export function emptyProbeResult(): ProbeResult {
  return {
    success: false,
    model: '',
    protocol: 'openai_chat',
    httpStatus: null,
    errorCode: null,
    errorMessage: null,
    latencyMs: null,
    ttftMs: null,
    inputTokens: null,
    outputTokens: null,
    tokensPerSec: null,
    sample: null,
    at: new Date().toISOString(),
  };
}
