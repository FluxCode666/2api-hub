/*
 * 错误消息脱敏：写入/读取 probe_runs.error_message 前，用渠道真实 Key 做精确替换（防御纵深）。
 * 公开接口不返回原始 errorMessage，改为 errorCode → 固定中文分类。
 */
import type { ProbeErrorCode } from '@hub/shared';

/** 用真实 Key 精确替换文本中的泄露（含 URL 编码变体） */
export function sanitizeKeyFromText(text: string | null, apiKey?: string | null): string | null {
  if (!text) return text;
  if (!apiKey || apiKey.length < 4) return text;
  let out = text;
  // 精确替换原文与常见编码变体
  const variants = new Set([apiKey, encodeURIComponent(apiKey), encodeURI(apiKey)]);
  for (const v of variants) {
    if (v && out.includes(v)) out = out.split(v).join('***');
  }
  return out;
}

/** 公开接口的错误分类（固定中文，不含任何上游原文） */
const PUBLIC_ERROR_LABEL: Record<string, string> = {
  timeout: '连接超时',
  network: '网络错误',
  dns: '域名解析失败',
  tls: 'TLS 握手失败',
  http_401: '认证失败（401）',
  http_403: '无权限（403）',
  http_404: '接口不存在（404）',
  http_429: '触发限流（429）',
  http_4xx: '客户端错误（4xx）',
  http_5xx: '上游服务错误（5xx）',
  empty_response: '上游返回空内容',
  invalid_response: '上游响应格式异常',
  ssrf_blocked: '目标地址不安全',
};

export function publicErrorMessage(errorCode: string | null): string | null {
  if (!errorCode) return null;
  return PUBLIC_ERROR_LABEL[errorCode as ProbeErrorCode] ?? '未知错误';
}
