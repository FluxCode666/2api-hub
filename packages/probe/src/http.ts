/*
 * 安全 HTTP 层：undici Agent + DNS 锁定，防止 SSRF TOCTOU。
 *
 * 分层防御（对动态渠道 URL 的结构性控制）：
 * 1. safeFetch 在发起请求**之前**调用 assertSafeUrlImpl 对 URL 做入口校验
 *    （scheme 白名单 http/https + DNS 解析后逐 IP 检查私网/保留地址），
 *    未通过校验的 URL 抛 SsrfBlockError，请求不会发出；
 * 2. undici Agent 的 connect 回调对每个候选 IP 再次 isPrivateIp 检查，
 *    即使 DNS 在校验后短时间变化（TOCTOU），也无法建立到私网的连接，
 *    且 TCP 连接锁定到已校验 IP（TLS SNI/Host 头保持域名）；
 * 3. 重定向不自动跟随（redirect: 'manual'），由上层校验后再发起；
 * 4. 响应体上限 2MB。
 */
import { Agent, fetch as undiciFetch, type RequestInit as undiciRequestInit, type Response as UndiciResponse } from 'undici';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { assertSafeUrlImpl, isPrivateIp } from './ssrf.js';

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 请求 URL；safeFetch 内部强制做 SSRF 校验，未通过则请求不会发出 */
  url: string;
  /** 允许私网（开发环境 mock，等价 ALLOW_PRIVATE_PROBE=true） */
  allowPrivate?: boolean;
}

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB

export class SsrfBlockError extends Error {
  readonly code = 'ssrf_blocked';
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockError';
  }
}

/** undici fetch 扩展：RequestInit.dispatcher 指定连接层（Node 22 类型内建） */

interface DnsCacheEntry {
  ips: string[];
  at: number;
}

/** DNS 解析缓存（5s TTL：worker 每分钟探测同一批上游，避免重复解析；同时缩小 TOCTOU 窗口） */
const dnsCache = new Map<string, DnsCacheEntry>();
const DNS_TTL_MS = 5_000;

async function resolveWithCache(hostname: string): Promise<string[]> {
  const hit = dnsCache.get(hostname);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.ips;
  let ips: string[];
  if (isIP(hostname)) {
    ips = [hostname];
  } else {
    try {
      const records = await lookup(hostname, { all: true, verbatim: true });
      ips = records.map((r) => r.address);
    } catch {
      ips = [];
    }
  }
  dnsCache.set(hostname, { ips, at: Date.now() });
  return ips;
}

/**
 * 创建"只连接已校验 IP"的 undici Agent。
 * connect 回调里对每个候选 IP 做 isPrivateIp 检查（allowPrivate 除外）。
 */
export function createSafeAgent(allowPrivate: boolean): Agent {
  return new Agent({
    connect: async (opts, callback) => {
      const hostname = String(opts.hostname ?? '');
      const port = typeof opts.port === 'string' ? Number.parseInt(opts.port, 10) : (opts.port ?? 80);
      try {
        const ips = await resolveWithCache(hostname);
        if (ips.length === 0) {
          callback(new Error(`DNS 解析失败: ${hostname}`), null);
          return;
        }
        if (!allowPrivate) {
          const bad = ips.find((ip) => isPrivateIp(ip));
          if (bad) {
            callback(new SsrfBlockError(`目标解析到私网/保留地址 ${bad}`), null);
            return;
          }
        }
        // 锁定到首个已校验 IP 建立 TCP 连接（TLS SNI/Host 头仍用域名）
        const net = await import('node:net');
        const socket = net.connect({ host: ips[0] ?? hostname, port: port as number });
        callback(null, socket as never);
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)), null);
      }
    },
    headersTimeout: 60_000,
    bodyTimeout: 60_000,
  });
}

const activeAgents = new Map<string, Agent>();

/** 获取（或创建）按 allowPrivate 分组的复用 Agent，避免每次探测新建连接池 */
export function getAgent(allowPrivate: boolean): Agent {
  const key = allowPrivate ? 'private' : 'public';
  let agent = activeAgents.get(key);
  if (!agent) {
    agent = createSafeAgent(allowPrivate);
    activeAgents.set(key, agent);
  }
  return agent;
}

/**
 * 安全 fetch：入口处强制 SSRF 校验（scheme + DNS 解析后 IP 检查），
 * 连接层再复核（防 TOCTOU），重定向不自动跟随。
 * URL 来源为渠道登记的 base_url（外部输入），必须经由本函数的双重校验后才能发出请求。
 */
export async function safeFetch(opts: SafeFetchOptions): Promise<UndiciResponse> {
  const allowPrivate = opts.allowPrivate ?? process.env.ALLOW_PRIVATE_PROBE === 'true';
  // 第一层：入口校验——未通过的 URL 直接抛 SsrfBlockError，fetch 不会执行
  await assertSafeUrlImpl(opts.url, allowPrivate);
  // 已通过 SSRF 校验的 URL（scheme 白名单 + DNS 解析后非私网地址）
  const url = opts.url;
  const agent = getAgent(allowPrivate);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
  const init: undiciRequestInit = {
    method: (opts.method ?? 'GET').toUpperCase(),
    headers: opts.headers,
    body: opts.body,
    signal,
    redirect: 'manual',
  };
  try {
    // 用 undici 自带的 fetch（支持 init.dispatcher 扩展字段）：Node 全局 fetch 内置的
    // undici 与 npm undici 8 跨版本传 Agent 会报 invalid onRequestStart method。
    // SAFETY: dispatcher 是 undici fetch 的非标准扩展（lib.dom RequestInit 不含），
    // 运行时由 undici 读取；Agent 本身即 Dispatcher 实现。
    return await undiciFetch(url, { ...init, dispatcher: agent });
  } catch (err) {
    if (err instanceof Error && /私网|保留地址/.test(err.message)) {
      throw new SsrfBlockError(err.message);
    }
    throw err;
  }
}

/** 读取响应体（限 MAX_RESPONSE_BYTES，超限截断并标记） */
export async function readBodyLimited(res: UndiciResponse): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        truncated = true;
        chunks.push(value.slice(0, Math.max(0, MAX_RESPONSE_BYTES - (total - value.byteLength))));
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(merged), truncated };
}

/** 进程退出时清理连接池 */
export async function closeSafeAgents(): Promise<void> {
  for (const agent of activeAgents.values()) {
    try {
      await agent.close();
    } catch {
      // ignore
    }
  }
  activeAgents.clear();
}
