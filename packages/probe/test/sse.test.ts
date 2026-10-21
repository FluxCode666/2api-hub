import { describe, expect, it } from 'vitest';
import { parseSse, SseParser } from '../src/sse.js';

describe('SseParser', () => {
  it('解析标准 openai 风格 data: 行', () => {
    const text = [
      'data: {"choices":[{"delta":{"content":"He"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"llo"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const events = parseSse(text);
    expect(events).toHaveLength(2);
    expect(events[0]?.data).toContain('He');
    expect(events[1]?.data).toContain('llo');
  });

  it('解析带 event: 行的 anthropic 风格事件', () => {
    const text = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_01","usage":{"input_tokens":10}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const events = parseSse(text);
    expect(events).toHaveLength(3);
    expect(events[0]?.event).toBe('message_start');
    expect(events[1]?.data).toContain('text_delta');
    expect(events[2]?.event).toBe('message_stop');
  });

  it('跨 chunk 分隔的事件能正确拼接（增量 feed）', () => {
    const parser = new SseParser();
    const ev1 = parser.feed('data: {"a":');
    expect(ev1).toHaveLength(0);
    const ev2 = parser.feed('1}\n\n');
    expect(ev2).toHaveLength(1);
    expect(ev2[0]?.data).toBe('{"a":1}');
  });

  it('多行 data 用换行聚合', () => {
    const events = parseSse('data: line1\ndata: line2\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('line1\nline2');
  });

  it('忽略注释行（: heartbeat）与未知字段', () => {
    const events = parseSse(': keep-alive\nid: 42\ndata: {"ok":true}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('{"ok":true}');
  });

  it('CRLF 换行支持', () => {
    const events = parseSse('data: {"x":1}\r\n\r\ndata: [DONE]\r\n\r\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('{"x":1}');
  });

  it('flush 冲刷未以空行结尾的最后一个事件', () => {
    const parser = new SseParser();
    parser.feed('data: {"tail":true}\n');
    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.data).toBe('{"tail":true}');
  });

  it('[DONE] 后不再产出事件', () => {
    const parser = new SseParser();
    parser.feed('data: [DONE]\n\n');
    expect(parser.isDone).toBe(true);
    const more = parser.feed('data: {"late":1}\n\n');
    expect(more).toHaveLength(0);
  });
});
