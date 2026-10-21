import { describe, expect, it } from 'vitest';
import {
  anthropicAdapter,
  emptyCapture,
  geminiAdapter,
  getAdapter,
  openaiChatAdapter,
  openaiResponsesAdapter,
} from '../src/adapters.js';
import { parseSse } from '../src/sse.js';

const firstSeen = () => ({ atMs: null as number | null });

describe('openai_chat adapter', () => {
  it('build：/v1 拼接正确（base 不带 /v1 时补上）', () => {
    const req = openaiChatAdapter.build('https://api.example.com', 'sk-test', { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] }, true);
    expect(req.url).toBe('https://api.example.com/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-test');
    expect(JSON.parse(req.body).stream).toBe(true);
  });

  it('build：base 已以 /v1 结尾则不重复拼接', () => {
    const req = openaiChatAdapter.build('https://api.example.com/v1/', 'sk-test', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, true);
    expect(req.url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('feedEvent：聚合 delta 文本、usage、模型回显、id', () => {
    const capture = emptyCapture();
    const seen = firstSeen();
    const sse = [
      'data: {"id":"chatcmpl-abc123","model":"gpt-5.6-sol","choices":[{"delta":{"content":"你好"}}]}',
      '',
      'data: {"id":"chatcmpl-abc123","model":"gpt-5.6-sol","choices":[{"delta":{"content":"世界"},"finish_reason":"stop"}]}',
      '',
      'data: {"id":"chatcmpl-abc123","choices":[],"usage":{"prompt_tokens":142,"completion_tokens":5}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    for (const ev of parseSse(sse)) {
      openaiChatAdapter.feedEvent(capture, ev, seen);
    }
    expect(capture.text).toBe('你好世界');
    expect(capture.responseId).toBe('chatcmpl-abc123');
    expect(capture.modelEcho).toBe('gpt-5.6-sol');
    expect(capture.inputTokens).toBe(142);
    expect(capture.outputTokens).toBe(5);
    expect(capture.stopReason).toBe('stop');
    expect(seen.atMs).not.toBeNull();
  });

  it('parseFull：非流式响应解析', () => {
    const capture = emptyCapture();
    openaiChatAdapter.parseFull(capture, JSON.stringify({
      id: 'chatcmpl-x',
      model: 'gpt-5.6-sol',
      choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    }));
    expect(capture.text).toBe('pong');
    expect(capture.inputTokens).toBe(10);
    expect(capture.stopReason).toBe('stop');
  });
});

describe('openai_responses adapter', () => {
  it('build：URL 为 /v1/responses，input 数组结构', () => {
    const req = openaiResponsesAdapter.build('https://api.example.com', 'sk-test', { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] }, true);
    expect(req.url).toBe('https://api.example.com/v1/responses');
    const body = JSON.parse(req.body) as { input: { role: string; content: string }[]; stream: boolean };
    expect(body.input[0]?.role).toBe('user');
    expect(body.stream).toBe(true);
  });

  it('feedEvent：response.created → output_text.delta → completed 事件流', () => {
    const capture = emptyCapture();
    const seen = firstSeen();
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_123","model":"gpt-6-astra"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"He"}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"llo"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-6-astra","usage":{"input_tokens":100,"output_tokens":2},"output":[{"type":"message"}]}}',
      '',
    ].join('\n');
    for (const ev of parseSse(sse)) {
      openaiResponsesAdapter.feedEvent(capture, ev, seen);
    }
    expect(capture.text).toBe('Hello');
    expect(capture.responseId).toBe('resp_123');
    expect(capture.modelEcho).toBe('gpt-6-astra');
    expect(capture.inputTokens).toBe(100);
    expect(capture.outputTokens).toBe(2);
    expect(capture.eventSequence).toContain('response.completed');
    expect(seen.atMs).not.toBeNull();
  });
});

describe('anthropic adapter', () => {
  it('build：header 含 x-api-key + anthropic-version + Bearer；system 抽出', () => {
    const req = anthropicAdapter.build('https://api.example.com', 'sk-ant', {
      model: 'claude-opus-5-5',
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hi' },
      ],
    }, true);
    expect(req.url).toBe('https://api.example.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-ant');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers.authorization).toBe('Bearer sk-ant');
    const body = JSON.parse(req.body) as { system: string; messages: { role: string }[] };
    expect(body.system).toBe('be nice');
    expect(body.messages).toHaveLength(1);
  });

  it('build：base 已带 /v1 不重复', () => {
    const req = anthropicAdapter.build('https://x.com/v1', 'k', { model: 'm', messages: [{ role: 'user', content: 'x' }] }, false);
    expect(req.url).toBe('https://x.com/v1/messages');
  });

  it('feedEvent：message_start → thinking 签名 → text delta → message_delta usage', () => {
    const capture = emptyCapture();
    const seen = firstSeen();
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_01XYZ","model":"claude-opus-5-5","usage":{"input_tokens":25,"output_tokens":1}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me think"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBCkgIBxgBIiQ..."}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答案是42"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    for (const ev of parseSse(sse)) {
      anthropicAdapter.feedEvent(capture, ev, seen);
    }
    expect(capture.text).toBe('答案是42');
    expect(capture.thinkingText).toBe('let me think');
    expect(capture.thinkingSignature).toBe('EqQBCkgIBxgBIiQ...');
    expect(capture.responseId).toBe('msg_01XYZ');
    expect(capture.inputTokens).toBe(25);
    expect(capture.outputTokens).toBe(12);
    expect(capture.stopReason).toBe('end_turn');
    expect(capture.eventSequence).toContain('message_start');
    expect(capture.eventSequence).toContain('message_stop');
    expect(seen.atMs).not.toBeNull();
  });

  it('feedEvent：tool_use 块被捕获', () => {
    const capture = emptyCapture();
    const seen = firstSeen();
    const sse = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
      '',
    ].join('\n');
    for (const ev of parseSse(sse)) {
      anthropicAdapter.feedEvent(capture, ev, seen);
    }
    expect(capture.toolCalls).not.toBeNull();
    expect(capture.toolCalls?.length).toBeGreaterThanOrEqual(2);
  });

  it('parseFull：非流式含 cache 字段 usage', () => {
    const capture = emptyCapture();
    anthropicAdapter.parseFull(capture, JSON.stringify({
      id: 'msg_01A',
      type: 'message',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 9, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }));
    expect(capture.text).toBe('hi');
    expect(capture.responseId).toBe('msg_01A');
    expect(capture.eventSequence).toContain('message');
  });
});

describe('gemini adapter', () => {
  it('build：streamGenerateContent?alt=sse + x-goog-api-key', () => {
    const req = geminiAdapter.build('https://api.example.com', 'AIza-test', { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] }, true);
    expect(req.url).toContain('/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
    expect(req.headers['x-goog-api-key']).toBe('AIza-test');
  });

  it('build：base 已带 /v1beta 不重复；systemInstruction 抽出', () => {
    const req = geminiAdapter.build('https://x.com/v1beta', 'k', {
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u' },
      ],
    }, false);
    expect(req.url).toBe('https://x.com/v1beta/models/m:generateContent');
    const body = JSON.parse(req.body) as { systemInstruction: { parts: { text: string }[] }; contents: { role: string }[] };
    expect(body.systemInstruction.parts[0]?.text).toBe('sys');
    expect(body.contents[0]?.role).toBe('user');
  });

  it('feedEvent：candidates parts 文本 + thought + usageMetadata + functionCall', () => {
    const capture = emptyCapture();
    const seen = firstSeen();
    const sse = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"思考中","thought":true},{"text":"答案"}]}}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":2},"modelVersion":"gemini-3.8-flash"}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Beijing"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":5}}',
      '',
    ].join('\n');
    for (const ev of parseSse(sse)) {
      geminiAdapter.feedEvent(capture, ev, seen);
    }
    expect(capture.text).toBe('答案');
    expect(capture.thinkingText).toBe('思考中');
    expect(capture.inputTokens).toBe(50);
    expect(capture.outputTokens).toBe(5);
    expect(capture.stopReason).toBe('STOP');
    expect(capture.toolCalls).toHaveLength(1);
    expect(seen.atMs).not.toBeNull();
  });
});

describe('getAdapter 工厂', () => {
  it('四种协议各返回对应 adapter', () => {
    expect(getAdapter('openai_chat')).toBe(openaiChatAdapter);
    expect(getAdapter('openai_responses')).toBe(openaiResponsesAdapter);
    expect(getAdapter('anthropic')).toBe(anthropicAdapter);
    expect(getAdapter('gemini')).toBe(geminiAdapter);
  });
});
