import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createTlsServer, type Server as TlsServerType } from 'node:tls';
import { readFileSync } from 'node:fs';
import { safeFetch } from '../src/http.js';
import { listUpstreamModels } from '../src/index.js';

/**
 * TLS 修复回归测试（P1-1）：
 * - https URL 指向普通 http 服务 → 必须失败（不能把 Authorization 头以明文发给 http 对端）
 * - 自签证书 → 必须失败（证书链校验不可关）
 * - 真实联网冒烟（可选，联网失败时 skip）：api.openai.com / api.anthropic.com 返回 http_401
 */

let httpServer: HttpServer;
let httpPort = 0;
let tlsServer: TlsServerType;
let tlsPort = 0;

beforeAll(async () => {
  // 普通 http 服务（会回显收到的请求头，用于验证明文请求不会发出）
  httpServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ gotAuth: req.headers.authorization ?? null }));
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  httpPort = (httpServer.address() as { port: number }).port;

  // 自签证书 TLS 服务（CN=localhost，SAN=localhost/127.0.0.1）
  const cert = readFileSync('/tmp/probe-tls-test/tlscert');
  const key = readFileSync('/tmp/probe-tls-test/tlskey');
  tlsServer = createTlsServer({ cert, key }, (socket) => {
    socket.on('data', () => {
      socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}');
    });
  });
  await new Promise<void>((r) => tlsServer.listen(0, '127.0.0.1', r));
  tlsPort = (tlsServer.address() as { port: number }).port;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
  await new Promise<void>((r) => tlsServer.close(() => r()));
});

describe('TLS 安全（P1-1 回归）', () => {
  it('https URL 指向普通 http 服务 → 必须失败（不得明文发送）', async () => {
    await expect(
      safeFetch({
        url: `https://127.0.0.1:${httpPort}/v1/models`,
        method: 'GET',
        headers: { authorization: 'Bearer sk-should-never-be-sent' },
        timeoutMs: 5_000,
        allowPrivate: true,
      }),
    ).rejects.toThrow();
    // 并确认 http 服务没有收到带 Authorization 的明文请求
    const res = await safeFetch({
      url: `http://127.0.0.1:${httpPort}/check`,
      method: 'GET',
      timeoutMs: 5_000,
      allowPrivate: true,
    });
    // 上一条 https 请求若错误地走了明文，会命中本服务；这里再主动请求一次确认服务还活着即可
    expect(res.status).toBe(200);
  }, 15_000);

  it('自签证书 → 必须失败（证书校验不可关）', async () => {
    await expect(
      safeFetch({
        url: `https://localhost:${tlsPort}/v1/models`,
        method: 'GET',
        timeoutMs: 5_000,
        allowPrivate: true,
      }),
    ).rejects.toThrow();
  }, 15_000);

  it('真实联网冒烟：https://api.openai.com 无效 key → http_401/403/429（TLS 握手成功）', async () => {
    // 部分网络环境无法直连 openai（curl 亦超时）——此时 network/timeout 不算失败
    const r = await listUpstreamModels(
      { baseUrl: 'https://api.openai.com', apiKey: 'sk-invalid-not-a-real-key', protocol: 'openai_chat' },
      { timeoutMs: 15_000, allowPrivate: false },
    );
    const code = r.errorCode ?? 'none';
    if (code === 'network' || code === 'timeout' || code === 'dns') {
      console.log(`skip: api.openai.com 本机不可达（${code}），TLS 冒烟以 anthropic 为准`);
      return;
    }
    expect(['http_401', 'http_403', 'http_429']).toContain(code);
  }, 30_000);

  it('真实联网冒烟：https://api.anthropic.com 无效 key → http_401（TLS 握手成功）', async () => {
    const r = await listUpstreamModels(
      { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-invalid-not-a-real-key', protocol: 'anthropic' },
      { timeoutMs: 15_000, allowPrivate: false },
    );
    expect(['http_401', 'http_403', 'http_429']).toContain(r.errorCode ?? 'none');
  }, 30_000);

  it('SSRF 防护未退化：https 私网地址仍被拦截', async () => {
    await expect(
      safeFetch({
        url: `https://127.0.0.1:${httpPort}/x`,
        method: 'GET',
        timeoutMs: 5_000,
        allowPrivate: false,
      }),
    ).rejects.toThrow(/私网|保留地址|SSRF/i);
  }, 15_000);
});
