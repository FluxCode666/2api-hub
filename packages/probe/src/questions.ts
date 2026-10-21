/*
 * 确定性推理题库（SPEC §5.3 reasoning 检查 / 降智检测）。
 *
 * 原则：
 * - 答案确定且可程序化判定（数字计算 / 字符串变换 / 简单逻辑），不依赖模型世界知识。
 * - 每题带 expected（精确答案）和 check（从模型回复文本中提取并判定）。
 * - 提取规则宽松：允许模型输出思考过程，只要最终答案能被「答案标记」或末尾数字模式捕获。
 */

export interface ReasoningQuestion {
  id: string;
  /** 发给模型的问题（指令要求以固定格式作答，便于解析） */
  prompt: string;
  /** 期望答案（用于显示） */
  expected: string;
  /** 从回复文本中判定是否答对 */
  check: (answer: string) => boolean;
}

/** 从回复中提取最终答案：优先 [answer] 标记，其次 "Answer:" 后内容，其次末尾数字 */
export function extractAnswer(text: string): string {
  const tag = /\[answer:\s*([^\]]+)\]/i.exec(text);
  if (tag?.[1]) return tag[1].trim();
  const ans = /(?:answer|答案)\s*[:：]\s*(.+)$/im.exec(text);
  if (ans?.[1]) return ans[1].trim();
  return text.trim();
}

/** 数字题判定：提取最后一个数字（或带小数）比较 */
function numEq(expected: number): (answer: string) => boolean {
  return (answer: string) => {
    const nums = answer.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length === 0) return false;
    const lastNum = nums.at(-1);
    if (lastNum === undefined) return false;
    const last = Number.parseFloat(lastNum);
    return Math.abs(last - expected) < 0.01;
  };
}

/** 字符串题判定：忽略大小写与空白 */
function strEq(expected: string): (answer: string) => boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s'"]/g, '');
  return (answer: string) => norm(answer).includes(norm(expected));
}

const INSTRUCTION = '请直接计算并在最后单独一行以 "Answer: <结果>" 的格式给出最终答案，不要解释。';

export const QUESTIONS: ReasoningQuestion[] = [
  {
    id: 'arith-chain',
    prompt: `计算：(17 × 23) − (144 ÷ 6) + 55 = ?\n${INSTRUCTION}`,
    expected: '422',
    check: numEq((17 * 23) - (144 / 6) + 55),
  },
  {
    id: 'percent',
    prompt: `一件商品原价 249 元，先涨价 40%，再打 75 折，最终价格是多少元？\n${INSTRUCTION}`,
    expected: '261.45',
    check: numEq(249 * 1.4 * 0.75),
  },
  {
    id: 'string-reverse',
    prompt: `将字符串 "HUB-2API-2026" 中的字母反转（数字和横线保持原位，仅反转字母），结果是什么？\n${INSTRUCTION}`,
    expected: 'BUH-IPA2-2026',
    check: strEq('BUH-IPA2-2026'),
  },
  {
    id: 'logic-set',
    prompt: `集合 A = {2,4,6,8,10,12}，B = {3,6,9,12,15}。A ∪ B 中有多少个数能被 3 整除？\n${INSTRUCTION}`,
    expected: '4',
    check: numEq(4),
  },
  {
    id: 'base-convert',
    prompt: `十进制数 2026 转换为十六进制是多少？\n${INSTRUCTION}`,
    expected: '0x7EA',
    check: strEq('7EA'),
  },
  {
    id: 'word-count',
    prompt: `句子 "the quick brown fox jumps over the lazy dog again and again" 中，单词 "the" 出现了多少次？\n${INSTRUCTION}`,
    expected: '3',
    check: numEq(3),
  },
  {
    id: 'date-arithmetic',
    prompt: `2026 年 3 月 15 日再过 47 天是几月几日？（格式：M月D日）\n${INSTRUCTION}`,
    expected: '5月1日',
    check: (answer) => {
      const m = /(\d+)\s*月\s*(\d+)\s*日/.exec(answer);
      if (!m) return false;
      const mm = Number.parseInt(m[1] ?? '0', 10);
      const dd = Number.parseInt(m[2] ?? '0', 10);
      return mm === 5 && dd === 1;
    },
  },
  {
    id: 'modulo',
    prompt: `(7^5) mod 13 = ?（7 的 5 次方除以 13 的余数）\n${INSTRUCTION}`,
    expected: '11',
    check: numEq(Math.pow(7, 5) % 13),
  },
  {
    id: 'average',
    prompt: `数列 [3.5, 7, 11.25, 2.25, 8] 的平均值是多少？\n${INSTRUCTION}`,
    expected: '6.4',
    check: numEq(6.4),
  },
  {
    id: 'char-index',
    prompt: `字符串 "probe-engine-v9" 中第 6 个字符（从 1 开始计数）是什么？\n${INSTRUCTION}`,
    expected: '-',
    check: (answer) => {
      const s = answer.replace(/["'`]/g, '');
      return /-'/.test(s) || /[^a-z0-9]-/.test(s) || s.trim() === '-';
    },
  },
  {
    id: 'simple-algebra',
    prompt: `若 3x + 12 = 5x - 4，则 x = ?\n${INSTRUCTION}`,
    expected: '8',
    check: numEq(8),
  },
  {
    id: 'sum-series',
    prompt: `从 1 加到 37（1+2+3+...+37）等于多少？\n${INSTRUCTION}`,
    expected: '703',
    check: numEq((37 * 38) / 2),
  },
];

/** 随机抽取 n 道不重复的题 */
export function pickQuestions(n: number): ReasoningQuestion[] {
  const pool = [...QUESTIONS];
  const picked: ReasoningQuestion[] = [];
  while (picked.length < n && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    const q = pool.splice(i, 1)[0];
    if (q) picked.push(q);
  }
  return picked;
}

/** 判定一道题的回答是否正确（先提取答案再 check） */
export function judgeQuestion(q: ReasoningQuestion, replyText: string): boolean {
  return q.check(extractAnswer(replyText));
}
