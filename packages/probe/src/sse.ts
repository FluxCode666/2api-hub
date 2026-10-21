/*
 * SSE 流解析器：按行切分 data: 前缀，聚合多行事件，处理 [DONE]。
 * 输出完整的 JSON 事件（已解析为对象），供各协议 adapter 消费。
 */

export interface RawSseEvent {
  /** event: 行的值（无则为 undefined） */
  event: string | undefined;
  /** data: 行聚合后的完整字符串 */
  data: string;
}

/** 增量式 SSE 解析器：feed 返回当前缓冲区中解析出的完整事件 */
export class SseParser {
  private buffer = '';
  private pendingEvent: string | undefined;
  private pendingData: string[] = [];
  private done = false;

  /** 喂入一段文本，返回其中包含的所有完整事件 */
  feed(chunk: string): RawSseEvent[] {
    if (this.done) return [];
    this.buffer += chunk;
    const events: RawSseEvent[] = [];
    let idx: number;
    // 支持 LF 与 CRLF
    while ((idx = this.findLineEnd()) !== -1) {
      let line = this.buffer.slice(0, idx);
      // 去 CR：CRLF 时 line 末尾会残留 \r
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.buffer = this.buffer.slice(idx + 1);
      this.handleLine(line, events);
    }
    return events;
  }

  /** 流结束时调用，冲刷最后一个未以空行结束的事件 */
  flush(): RawSseEvent[] {
    const events: RawSseEvent[] = [];
    if (this.buffer !== '') {
      let last = this.buffer;
      if (last.endsWith('\r')) last = last.slice(0, -1);
      this.handleLine(last, events);
      this.buffer = '';
    }
    if (this.pendingData.length > 0 || this.pendingEvent !== undefined) {
      const ev: RawSseEvent = { event: this.pendingEvent, data: this.pendingData.join('\n') };
      this.pendingEvent = undefined;
      this.pendingData = [];
      if (ev.data !== '[DONE]') events.push(ev);
    }
    this.done = true;
    return events;
  }

  get isDone(): boolean {
    return this.done;
  }

  private findLineEnd(): number {
    const lf = this.buffer.indexOf('\n');
    if (lf === -1) return -1;
    return lf;
  }

  private handleLine(line: string, out: RawSseEvent[]): void {
    if (line === '') {
      // 空行 = 事件结束
      if (this.pendingData.length > 0 || this.pendingEvent !== undefined) {
        const ev: RawSseEvent = { event: this.pendingEvent, data: this.pendingData.join('\n') };
        this.pendingEvent = undefined;
        this.pendingData = [];
        if (ev.data === '[DONE]') {
          this.done = true;
        } else {
          out.push(ev);
        }
      }
      return;
    }
    if (line.startsWith(':')) return; // 注释/心跳
    if (line.startsWith('data:')) {
      this.pendingData.push(line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5));
    } else if (line.startsWith('event:')) {
      this.pendingEvent = line.slice(6).startsWith(' ') ? line.slice(7) : line.slice(6);
    }
    // 其他字段（id:/retry:）忽略
  }
}

/** 便捷函数：一次性解析完整 SSE 文本 */
export function parseSse(text: string): RawSseEvent[] {
  const parser = new SseParser();
  const events = parser.feed(text);
  return events.concat(parser.flush());
}

/** 解析 data 为 JSON；失败返回 null */
export function parseJsonData<T = unknown>(ev: RawSseEvent): T | null {
  try {
    return JSON.parse(ev.data) as T;
  } catch {
    return null;
  }
}
