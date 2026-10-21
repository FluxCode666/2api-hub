/*
 * URL 安全校验（SSRF 防护）+ HTTP 客户端辅助。
 * 只允许 http/https；DNS 解析后拒绝私网/回环/链路本地/保留地址（IPv4 + IPv6）。
 * ALLOW_PRIVATE_PROBE=true 时放行（开发环境，mock-upstream 在 127.0.0.1）。
 */
import { lookup } from 'node:dns/promises';
import { connect, isIP } from 'node:net';

export class UnsafeUrlError extends Error {
  readonly code = 'ssrf_blocked';
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/** 判断单个 IP 是否为私网/回环/链路本地/保留/组播/未指定地址（IPv4 + IPv6） */
export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  // 不是合法 IP（如域名），由调用方先解析
  return true;
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = [parts[0] ?? 0, parts[1] ?? 0];
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10/8, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true; // 组播 + 保留
  return false;
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true; // 未指定 + loopback
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 链路本地
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
  if (lower.startsWith('ff')) return true; // 组播
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped：取内嵌 IPv4 再判
    const v4 = lower.split(':').pop();
    return v4 ? isPrivateV4(v4) : true;
  }
  if (lower.startsWith('64:ff9b:')) return true; // NAT64 well-known prefix（含 ::ffff:0:0/96 映射）
  if (lower.startsWith('100::')) return true; // discard-only
  if (lower.startsWith('2001:db8')) return true; // 文档保留
  if (lower.startsWith('2001:')) {
    // 2001:0::/32 TEREDO 等，2001:2::/48 benchmark——统一视为保留
    const second = Number.parseInt(lower.slice(5, 6) || '0', 16);
    if (second === 0 || second === 2) return true;
  }
  return false;
}

export interface ResolvedUrl {
  url: URL;
  hostname: string;
  resolvedIps: string[];
  /** DNS 解析出的所有地址均安全 */
  safe: boolean;
}

/** 校验 URL scheme + 解析 DNS 并检查所有解析结果；不安全时抛 UnsafeUrlError(code='ssrf_blocked') */
export async function assertSafeUrlImpl(url: string, allowPrivate?: boolean): Promise<ResolvedUrl> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError('无效的 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(`不支持的协议: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // URL 自动去掉 []，保险再处理
  const allow = allowPrivate ?? process.env.ALLOW_PRIVATE_PROBE === 'true';
  if (allow) {
    // 放行但仍返回解析信息
    let ips: string[] = [];
    if (isIP(hostname)) ips = [hostname];
    else {
      try {
        ips = (await lookup(hostname, { all: true, verbatim: true })).map((r) => r.address);
      } catch {
        ips = [];
      }
    }
    return { url: parsed, hostname, resolvedIps: ips, safe: true };
  }
  // hostname 是字面 IP 时直接判
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new UnsafeUrlError(`目标地址 ${hostname} 是私网/保留地址`);
    return { url: parsed, hostname, resolvedIps: [hostname], safe: true };
  }
  // 域名：DNS 解析后逐个检查
  let results: { address: string }[];
  try {
    results = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError('DNS 解析失败');
  }
  const bad = results.find((r) => isPrivateIp(r.address));
  if (bad) {
    throw new UnsafeUrlError(`目标域名解析到私网/保留地址 ${bad.address}`);
  }
  return { url: parsed, hostname, resolvedIps: results.map((r) => r.address), safe: true };
}

/**
 * 通过 socket 连接锁定的 IP（Host 头仍用域名），避免 fetch 自行 DNS 解析导致的 TOCTOU。
 * 实际请求由 undici Agent 的 connect 回调处理；这里提供判定函数。
 */
export function makeSafeIpLister(): (hostname: string) => Promise<string[]> {
  const cache = new Map<string, string[]>();
  return async (hostname: string) => {
    const cached = cache.get(hostname);
    if (cached) return cached;
    if (isIP(hostname)) {
      cache.set(hostname, [hostname]);
      return [hostname];
    }
    const results = await lookup(hostname, { all: true, verbatim: true });
    const ips = results.map((r) => r.address);
    cache.set(hostname, ips);
    return ips;
  };
}

/** TCP 预连接探测（用于区分 dns/network/tls 错误） */
export async function tcpProbe(hostname: string, port: number, timeoutMs: number): Promise<'ok' | 'refused' | 'timeout'> {
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('timeout');
    }, timeoutMs);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('ok');
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(err.code === 'ETIMEDOUT' ? 'timeout' : 'refused');
    });
  });
}

// （文件尾部无额外导出）