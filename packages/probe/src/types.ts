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
    errorMessage: redact(errorMessage),
    latencyMs: Date.now() - startedAt,
    ttftMs: null,
    inputTokens: null,
    outputTokens: null,
    tokensPerSec: null,
    sample: null,
    at: new Date().toISOString(),
  };
}

/** 从文本中抹掉疑似 API Key 的片段 */
export function redact(text: string | null): string | null {
  if (!text) return text;
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-****')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ****')
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, 'AIza****')
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '****');
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
