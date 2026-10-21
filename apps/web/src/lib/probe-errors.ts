import type { ProbeErrorCode } from '@hub/shared';

const labels: Record<ProbeErrorCode, string> = {
  timeout: '请求超时', network: '网络连接失败', dns: '域名解析失败', tls: 'TLS 连接失败',
  http_401: '认证失败', http_403: '访问被拒绝', http_404: '接口不存在',
  http_429: '请求频率受限', http_4xx: '请求被拒绝', http_5xx: '上游服务异常',
  empty_response: '响应内容为空', invalid_response: '响应格式异常', ssrf_blocked: '目标地址不允许访问',
};

export function probeErrorLabel(code: string | null): string {
  return code ? Object.hasOwn(labels, code) ? labels[code as ProbeErrorCode] : '探测失败' : '正常响应';
}
