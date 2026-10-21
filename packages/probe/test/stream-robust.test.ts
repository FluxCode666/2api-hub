import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { probeAvailability } from '../src/index.ts';
import { parseSse, emptyCapture, getAdapter } from '../src/index.ts';

/**
 * P2#12 流解析健壮性回归（审查复现场景逐一覆盖）：
 * 1. 四协议先 pong 再发流内错误事件 → 必须 success:false + invalid_response（旧实现 success:true）
 * 2. 只返回空 tool_calls 数组（无文本）→ 必须失败
 * 3. 非字符串 model/id/usage 字段 → 不抛 TypeError，按缺失处理
 */

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = req.url ?? '';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (url.includes('err-openai')) {
        res.write('data: {"id":"chatcmpl-x","model":"gpt-5.6-sol","choices":[{"delta":{"content":"pong"}}]}\n\n');
        res.write('data: {"error":{"message":"rate limit exceeded","type":"server_error"}}\n\n');
      } else if (url.includes('err-responses')) {
        res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_x"}}\n\n');
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"pong"}\n\n');
        res.write('event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"model overloaded"}}}\n\n');
      } else if (url.includes('err-anthropic')) {
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x"}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}\n\n');
        res.write('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n');
      } else if (url.includes('err-gemini')) {
        res.write('data: {"candidates":[{"content":{"parts":[{"text":"pong"}]}}]}\n\n');
        res.write('data: {"error":{"code":503,"message":"model is at capacity"}}\n\n');
      } else if (url.includes('empty-tools')) {
        res.write('data: {"id":"chatcmpl-x","model":"gpt-5.6-sol","choices":[{"delta":{"tool_calls":[]}}]}\n\n');
        res.write('data: [DONE]\n\n');
      } else if (url.includes('bad-types')) {
        res.write('data: {"id":42,"model":42,"choices":[{"delta":{"content":"pong"}}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n');
        res.write('data: [DONE]\n\n');
      } else if (url.includes('nan-tokens')) {
        // JSON 无法表达 Infinity；负数 token 是合法 JSON 但非法语义
        res.write('data: {"id":"chatcmpl-x","model":"gpt-5.6-sol","choices":[{"delta":{"content":"pong"}}],"usage":{"prompt_tokens":-5,"completion_tokens":-3}}\n\n');
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const base = (path: string, protocol: 'openai_chat' | 'openai_responses' | 'anthropic' | 'gemini') =>
  probeAvailability(
    { baseUrl: `http://127.0.0.1:${port}/${path}`, apiKey: 'sk-test', protocol, model: 'gpt-5.6-sol' },
    { allowPrivate: true, timeoutMs: 5_000 },
  );

describe('P2#12 流内失败终态（旧实现全部 success:true，审查复现）', () => {
  it('openai_chat：pong 后 error 事件 → invalid_response', async () => {
    const r = await base('err-openai', 'openai_chat');
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('invalid_response');
    expect(r.errorMessage).toContain('rate limit exceeded');
  });

  it('openai_responses：pong 后 response.failed → invalid_response', async () => {
    const r = await base('err-responses', 'openai_responses');
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('invalid_response');
    expect(r.errorMessage).toContain('model overloaded');
  });

  it('anthropic：pong 后 error 事件 → invalid_response', async () => {
    const r = await base('err-anthropic', 'anthropic');
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('invalid_response');
    expect(r.errorMessage).toContain('Overloaded');
  });

  it('gemini：pong 后 error → invalid_response', async () => {
    const r = await base('err-gemini', 'gemini');
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('invalid_response');
    expect(r.errorMessage).toContain('capacity');
  });
});

describe('P2#12 成功判定收紧', () => {
  it('空 tool_calls 数组（无文本）→ 失败（旧实现成功）', async () => {
    const r = await base('empty-tools', 'openai_chat');
    expect(r.success).toBe(false);
  });

  it('非字符串 model/id（42）→ 不抛 TypeError，按缺失处理', async () => {
    // 旧实现：checkResponseShape 内 name.trim 抛 TypeError；现在类型校验按缺失
    const r = await base('bad-types', 'openai_chat');
    expect(r.success).toBe(true); // 文本 pong 有效
    expect(r.sample).toBe('pong');
  });

  it('负数 token 计数 → 按缺失处理（null）', async () => {
    const r = await base('nan-tokens', 'openai_chat');
    expect(r.success).toBe(true);
    expect(r.inputTokens).toBeNull();
    expect(r.outputTokens).toBeNull();
  });
});

describe('P2#12 adapter 级：非字符串字段不进入 capture', () => {
  it('openai_chat：model=42 不写入 modelEcho', () => {
    const capture = emptyCapture();
    const adapter = getAdapter('openai_chat');
    for (const ev of parseSse('data: {"id":42,"model":42,"choices":[{"delta":{"content":"x"}}]}\n\n')) {
      adapter.feedEvent(capture, ev, { atMs: null });
    }
    expect(capture.modelEcho).toBeNull();
    expect(capture.responseId).toBeNull();
    expect(capture.text).toBe('x');
  });
});
