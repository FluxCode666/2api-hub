import { describe, expect, it } from 'vitest';
import { extractAnswer, judgeQuestion, pickQuestions, QUESTIONS } from '../src/questions.js';

describe('题库完整性', () => {
  it('至少 10 道题', () => {
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(10);
  });
  it('每道题有 id/prompt/expected/check', () => {
    for (const q of QUESTIONS) {
      expect(q.id).toBeTruthy();
      expect(q.prompt).toContain('Answer:');
      expect(typeof q.check).toBe('function');
    }
  });
  it('id 无重复', () => {
    const ids = new Set(QUESTIONS.map((q) => q.id));
    expect(ids.size).toBe(QUESTIONS.length);
  });
});

describe('extractAnswer', () => {
  it('优先 [answer: ...] 标记', () => {
    expect(extractAnswer('思考中... [answer: 410]')).toBe('410');
  });
  it('其次 Answer: 后内容', () => {
    expect(extractAnswer('我来算一下\nAnswer: 410')).toBe('410');
    expect(extractAnswer('答案：5月1日')).toBe('5月1日');
  });
  it('兜底返回原文', () => {
    expect(extractAnswer('410')).toBe('410');
  });
});

describe('judgeQuestion 判定（模型答对）', () => {
  it('数字题：带解释但末尾给答案', () => {
    const q = QUESTIONS.find((x) => x.id === 'arith-chain');
    expect(q).toBeDefined();
    expect(judgeQuestion(q!, '先算 17×23=391，然后 391-24+55=422。Answer: 422')).toBe(true);
    expect(judgeQuestion(q!, 'Answer: 410')).toBe(false);
  });

  it('百分比题', () => {
    const q = QUESTIONS.find((x) => x.id === 'percent');
    expect(q).toBeDefined();
    expect(judgeQuestion(q!, 'Answer: 261.45')).toBe(true);
    expect(judgeQuestion(q!, 'Answer: 348.6')).toBe(false);
  });

  it('字符串反转题', () => {
    const q = QUESTIONS.find((x) => x.id === 'string-reverse');
    expect(q).toBeDefined();
    expect(judgeQuestion(q!, 'Answer: "BUH-IPA2-2026"')).toBe(true);
    expect(judgeQuestion(q!, 'Answer: HUB-2API-2026')).toBe(false);
  });

  it('日期题：5月1日', () => {
    const q = QUESTIONS.find((x) => x.id === 'date-arithmetic');
    expect(q).toBeDefined();
    expect(judgeQuestion(q!, 'Answer: 5月1日')).toBe(true);
    expect(judgeQuestion(q!, 'Answer: 4月30日')).toBe(false);
  });

  it('全部题目：期望答案都能判对', () => {
    for (const q of QUESTIONS) {
      const ok = judgeQuestion(q, `Answer: ${q.expected}`);
      expect(ok, `题 ${q.id} 期望答案 "${q.expected}" 未被判对`).toBe(true);
    }
  });
});

describe('pickQuestions', () => {
  it('抽取不重复的 n 道', () => {
    const picked = pickQuestions(3);
    expect(picked).toHaveLength(3);
    const ids = new Set(picked.map((q) => q.id));
    expect(ids.size).toBe(3);
  });
  it('n 超过题库大小时返回全部', () => {
    const picked = pickQuestions(QUESTIONS.length + 5);
    expect(picked).toHaveLength(QUESTIONS.length);
  });
});
