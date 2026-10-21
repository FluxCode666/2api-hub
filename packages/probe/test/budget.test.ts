import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { probeAuthenticity, probeAvailability } from '../src/index.ts';

/**
 * P1#6 总预算回归：审查复现——上游每个请求 13s 后返回有效 SSE，
 * quick:true, timeoutMs:30000 旧实现实测 65s（5 个子请求各自 30s 上限）。
 * 修复后：quick 总预算强制 60s，断言总耗时 ≤ 60s + 容差。
 */

let slowServer: Server;
let slowPort = 0;

beforeAll(async () => {
  // 每个请求 delay 13s 后返回一个最小的合法 openai SSE 流
  slowServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"chatcmpl-x","model":"gpt-5.6-sol","choices":[{"delta":{"content":"pong"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write('data: {"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 13_000);
    });
  });
  await new Promise<void>((r) => slowServer.listen(0, '127.0.0.1', r));
  slowPort = (slowServer.address() as { port: number }).port;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => slowServer.close(() => r()));
});

describe('P1#6 总预算（quick 60s 强制上限）', () => {
  it('每个请求 13s：quick 真伪检测总耗时 ≤ 60s + 2s 容差', async () => {
    const t0 = Date.now();
    const report = await probeAuthenticity(
      { baseUrl: `http://127.0.0.1:${slowPort}`, apiKey: 'sk-budget-test', protocol: 'openai_chat', model: 'gpt-5.6-sol' },
      { slug: 'gpt-5.6-sol', vendorSlug: 'openai', tier: 'standard', knowledgeCutoff: '2025-10', expectedTps: 90 },
      { allowPrivate: true, timeoutMs: 30_000, quick: true },
    );
    const elapsed = Date.now() - t0;
    // 修复前实测 65,031ms（> 60s 上限）；修复后预算 deadline 触发 AbortSignal
    expect(elapsed).toBeLessThanOrEqual(62_000);
    // 预算耗尽后剩余检查必须是 passed:null（未执行），不能是失败
    const nullChecks = report.checks.filter((c) => c.passed === null);
    expect(nullChecks.length).toBeGreaterThan(0);
    for (const c of nullChecks) {
      expect(c.detail).toMatch(/预算耗尽|临时错误|未执行|跳过/);
    }
  }, 70_000);

  it('probeAvailability 单请求超时归类 timeout', async () => {
    const t0 = Date.now();
    const r = await probeAvailability(
      { baseUrl: `http://127.0.0.1:${slowPort}`, apiKey: 'k', protocol: 'openai_chat', model: 'gpt-5.6-sol' },
      { allowPrivate: true, timeoutMs: 3_000 },
    );
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(6_000);
  }, 15_000);
});
