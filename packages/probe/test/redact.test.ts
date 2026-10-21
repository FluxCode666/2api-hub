import { describe, expect, it } from 'vitest';
import { redact, redactDeep, redactThenTruncate, redactWithKey } from '../src/types.js';

/**
 * P1-2 回归：按真实 Key 精确脱敏。
 * 自定义格式 Key（如 review_custom_token_xxx）被上游回显时必须被替换；
 * 无真实 Key 时兜底格式匹配仍生效。
 */

const CUSTOM_KEY = 'review_custom_token_a1b2c3d4e5f6g7h8';

describe('redactWithKey（按真实 Key 精确脱敏）', () => {
  it('自定义格式 Key 原样出现 → 被替换', () => {
    const msg = `上游返回错误：Invalid API key ${CUSTOM_KEY} provided`;
    const out = redactWithKey(msg, CUSTOM_KEY);
    expect(out).not.toContain(CUSTOM_KEY);
    expect(out).toContain('[REDACTED]');
  });

  it('Key 在 Bearer 头中出现 → 被替换', () => {
    const msg = `request failed for Bearer ${CUSTOM_KEY}`;
    const out = redactWithKey(msg, CUSTOM_KEY);
    expect(out).not.toContain(CUSTOM_KEY);
  });

  it('URL 编码变体 → 被替换', () => {
    const encoded = encodeURIComponent(CUSTOM_KEY); // review_custom_token_... 无特殊字符时同原样
    // 构造一个真实会被编码的 Key 变体场景
    const keyWithSpecial = 'my/key?with=query&chars=1';
    const msg = `error echoing ${encodeURIComponent(keyWithSpecial)}`;
    const out = redactWithKey(msg, keyWithSpecial);
    expect(out).not.toContain(encodeURIComponent(keyWithSpecial));
    expect(out).toContain('[REDACTED]');
    expect(encoded).toBeTruthy();
  });

  it('base64 变体 → 被替换', () => {
    const b64 = Buffer.from(CUSTOM_KEY, 'utf8').toString('base64');
    const msg = `upstream said: key ${b64} is invalid`;
    const out = redactWithKey(msg, CUSTOM_KEY);
    expect(out).not.toContain(b64);
  });

  it('多次出现全部替换', () => {
    const msg = `${CUSTOM_KEY} and ${CUSTOM_KEY} again`;
    const out = redactWithKey(msg, CUSTOM_KEY);
    expect(out?.match(/\[REDACTED\]/g)?.length).toBe(2);
    expect(out).not.toContain(CUSTOM_KEY);
  });

  it('Key 过短（<8 字符）→ 不做替换（避免误伤普通词）', () => {
    const out = redactWithKey('the quick abc fox', 'abc');
    expect(out).toBe('the quick abc fox');
  });

  it('无 Key（null/undefined）→ 兜底格式脱敏仍生效', () => {
    // sk- 前缀规则先命中（sk-****），Bearer 规则随后不再匹配——断言两种可接受形式
    const bearerOut = redactWithKey('Bearer sk-abcdefghijklmnop1234', null);
    expect(['Bearer sk-****', 'Bearer ****']).toContain(bearerOut);
    expect(bearerOut).not.toContain('sk-abcdefghijklmnop1234');
    expect(redactWithKey('key AIzaSyD-1234567890abcdef', undefined)).toBe('key AIza****');
    // 自定义 Key 无真实值时兜底也无法识别 → 保持原样（这正是 P1 要求传真实 Key 的原因）
    expect(redactWithKey(`Invalid key ${CUSTOM_KEY}`, null)).toContain(CUSTOM_KEY);
  });

  it('正则特殊字符的 Key 也能替换（字面量替换）', () => {
    const weirdKey = 'k.e+y*(x)[a]?b|c$d^e{f}g';
    const msg = `bad key ${weirdKey}!`;
    const out = redactWithKey(msg, weirdKey);
    expect(out).not.toContain(weirdKey);
    expect(out).toContain('[REDACTED]');
  });
});

describe('redactDeep（深度脱敏 evidence 嵌套结构）', () => {
  it('对象中的字符串（含 Key）全部替换，结构不变', () => {
    const obj = {
      requested: 'claude-opus-5-5',
      echoed: `gpt-4o-mini (key ${CUSTOM_KEY} leaked)`,
      range: [160, 196] as [number, number],
      nested: { detail: `upstream error: ${CUSTOM_KEY}` },
    };
    const out = redactDeep(obj, CUSTOM_KEY);
    expect(out.echoed).not.toContain(CUSTOM_KEY);
    expect(out.nested.detail).not.toContain(CUSTOM_KEY);
    expect(out.requested).toBe('claude-opus-5-5');
    expect(out.range).toEqual([160, 196]);
  });

  it('数组与 null/数字不受影响', () => {
    const arr = ['ok', `err ${CUSTOM_KEY}`, null, 42];
    const out = redactDeep(arr, CUSTOM_KEY);
    expect(out[0]).toBe('ok');
    expect(out[1]).not.toContain(CUSTOM_KEY);
    expect(out[2]).toBeNull();
    expect(out[3]).toBe(42);
  });

  it('AuthenticityCheck 形状的数组（checks 字段）', () => {
    const checks = [
      { id: 'connectivity', name: '连通性', passed: false, weight: 10, detail: `连接被拒：${CUSTOM_KEY}`, evidence: { raw: `Authorization: Bearer ${CUSTOM_KEY}` } },
    ];
    const out = redactDeep(checks, CUSTOM_KEY);
    expect(out[0]?.detail).not.toContain(CUSTOM_KEY);
    expect(JSON.stringify(out)).not.toContain(CUSTOM_KEY);
  });
});

describe('redact（旧格式脱敏仍可用，作为兜底）', () => {
  it('sk- 前缀', () => {
    expect(redact('error with sk-abcdef1234567890')).toBe('error with sk-****');
  });
  it('null/空串透传', () => {
    expect(redact(null)).toBeNull();
    expect(redact('')).toBe('');
  });
});

describe('P1#1 修复：先脱敏再截断（redactThenTruncate）', () => {
  it('审查复现用例：x.repeat(290)+LONGDUMMYSECRET... 截断边界不泄露前缀', () => {
    // 审查报告复现：正文 290 个 x + 完整 Key，旧实现「先截断后脱敏」在 300 处截断后
    // Key 剩 LONGDUMMYS 前缀泄露；新实现先脱敏再截断
    const KEY = 'LONGDUMMYSECRET1234567890';
    const body = 'x'.repeat(290) + KEY;
    const out = redactThenTruncate(body, KEY, 300);
    expect(out).not.toBeNull();
    expect(out).not.toContain('LONGDUMMYS'); // 旧实现的泄露形态
    expect(out).toContain('[REDACTED]');
    expect(out!.length).toBeLessThanOrEqual(300);
  });

  it('脱敏占位符 [REDACTED] 不会被截断撕裂', () => {
    const KEY = 'secret-key-abcdef123456';
    const body = `error: ${KEY} and more text here to push length beyond limit 1234567890`;
    const out = redactThenTruncate(body, KEY, 40);
    expect(out!.length).toBeLessThanOrEqual(40);
    expect(out).not.toContain(KEY);
  });

  it('长度 ≥4 的短 Key 也精确替换（<8 不再跳过）', () => {
    expect(redactThenTruncate('rejected custom key xyz12', 'xyz12', 200)).toBe('rejected custom key [REDACTED]');
    expect(redactThenTruncate('bad abc key', 'abc', 200)).toBe('bad abc key'); // <4 不替换
  });

  it('null 透传', () => {
    expect(redactThenTruncate(null, 'some-key-1234', 100)).toBeNull();
  });

  it('截断后的输出仍过兜底格式脱敏', () => {
    const out = redactThenTruncate('Bearer sk-abcdefghijklmnop1234 done', null, 100);
    expect(out).not.toContain('sk-abcdefghijklmnop1234');
  });
});
