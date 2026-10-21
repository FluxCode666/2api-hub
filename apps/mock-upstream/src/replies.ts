/*
 * 回复内容生成：根据请求文本特征匹配生成回复，配合 probe 引擎的各项检查。
 *
 * 识别的模式（按优先级）：
 * 1. "Reply with exactly: pong" → 可用性探测
 * 2. 自我介绍 + 知识截止（knowledge 检查）
 * 3. 推理题（含 "Answer:" 指令，reasoning 检查）
 * 4. BENCHMARK 文本（token_count 检查）
 * 5. 工具调用请求（由 index.ts 判定 body 是否带 tools，本文件只给文本）
 * 6. 兜底通用回复
 */

import type { Scenario } from './scenarios.js';

export interface ReplyDecision {
  /** 回复文本（可能包含思考过程 + 最终 "Answer: xxx" 行） */
  text: string;
  /** 是否为推理题（决定 scenario 差异化行为） */
  isReasoning: boolean;
}

// ---------------- 推理题题面特征 → 答案 ----------------

interface ReasoningPattern {
  /** 题面文本特征 */
  match: RegExp;
  /** 期望答案 */
  expected: string;
  /** 一两句简短计算过程（可省略） */
  work?: string;
}

/** 与 packages/probe/src/questions.ts 的 QUESTIONS 对齐（按题面特征匹配） */
const REASONING_PATTERNS: ReasoningPattern[] = [
  {
    match: /17\s*[×x]\s*23/,
    expected: '422',
    work: '17×23=391，144÷6=24，391−24+55=422。',
  },
  {
    match: /249\s*元|涨价\s*40%/,
    expected: '261.45',
    work: '249×1.4=348.6，348.6×0.75=261.45。',
  },
  {
    match: /HUB-2API-2026/,
    expected: 'BUH-IPA2-2026',
  },
  {
    match: /A\s*[∪u]\s*B|能被\s*3\s*整除/,
    expected: '4',
    work: 'A∪B={2,3,4,6,8,9,10,12,15}，其中 3,6,9,12 共 4 个。',
  },
  {
    match: /十六进制|2026\s*转换/,
    expected: '0x7EA',
    work: '2026 = 7×256 + 14×16 + 10 = 7EA。',
  },
  {
    match: /lazy dog|单词\s*"the"|'the'\s*出现了多少次/,
    expected: '3',
  },
  {
    match: /47\s*天/,
    expected: '5月1日',
    work: '3月15日 + 16天到 3月31日，再 +30 天到 4月30日，再 +1 天。',
  },
  {
    match: /\(?7\^5\)?\s*mod|7\s*的\s*5\s*次方/,
    expected: '11',
    work: '7^5=16807，16807 = 13×1292 + 11。',
  },
  {
    match: /3\.5,\s*7,\s*11\.25|数列\s*\[3\.5/,
    expected: '6.4',
    work: '(3.5+7+11.25+2.25+8)÷5 = 32÷5 = 6.4。',
  },
  {
    match: /probe-engine-v9/,
    expected: '-',
    work: '字符串 "probe-engine-v9" 的第 6 个字符是 "-"。',
  },
  {
    match: /3x\s*\+\s*12\s*=\s*5x\s*-\s*4/,
    expected: '8',
    work: '2x=16，x=8。',
  },
  {
    match: /从\s*1\s*加到\s*37/,
    expected: '703',
    work: '37×38÷2=703。',
  },
];

/** 推理题答错的通用回复（fake：全错；downgraded：答错的那些题） */
function wrongReasoningReply(): string {
  return 'Answer: 42';
}

/** downgraded 交替答对答错：按请求内题目序号（奇数次对、偶数次错） */
const downgradedCounter = { n: 0 };

// ---------------- 身份回复 ----------------

/** 按模型名回厂商身份（knowledge 检查） */
function identityReply(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('claude')) {
    return '我是 Claude，由 Anthropic 开发。我的知识截止时间约为 2026 年 6 月。';
  }
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) {
    return '我是 GPT，由 OpenAI 开发。我的知识截止时间约为 2026 年 4 月。';
  }
  if (m.includes('gemini')) {
    return '我是 Gemini，由 Google 开发。我的知识截止时间约为 2026 年 3 月。';
  }
  if (m.includes('deepseek')) {
    return '我是 DeepSeek，由深度求索开发。我的知识截止时间约为 2026 年 5 月。';
  }
  if (m.includes('grok')) {
    return '我是 Grok，由 xAI 开发。我的知识截止时间约为 2026 年 5 月。';
  }
  if (m.includes('glm')) {
    return '我是 GLM，由智谱开发。我的知识截止时间约为 2026 年 6 月。';
  }
  if (m.includes('kimi')) {
    return '我是 Kimi，由月之暗面开发。我的知识截止时间约为 2026 年 5 月。';
  }
  if (m.includes('doubao') || m.includes('seedance')) {
    return '我是豆包，由字节跳动开发。我的知识截止时间约为 2026 年 3 月。';
  }
  return '我是一个大语言模型助手。';
}

/** BENCHMARK 文本（token_count 检查）：翻译+计算总结 */
function benchmarkReply(): string {
  return '翻译：你是 2API Hub 的检测引擎。计算：小计 242.49，按 8.5% 折扣后总金额为 221.87 元（保留两位小数）。中文总结：折扣前合计 242.49 CNY，折后 221.87 CNY。';
}

/**
 * 生成回复。
 * @param inputText 请求中全部文本（system + user）
 * @param model 请求模型名
 * @param scenario 当前 scenario
 */
export function generateReply(inputText: string, model: string, scenario: Scenario): ReplyDecision {
  const text = inputText;

  // 1. 可用性探测
  if (/Reply with exactly:\s*pong/i.test(text)) {
    return { text: 'pong', isReasoning: false };
  }

  // 3. 推理题（优先于身份/BENCHMARK，题面均含 "Answer:" 指令）
  const hasAnswerInstruction = /Answer:\s*<结果>|以\s*"Answer:/i.test(text);
  if (hasAnswerInstruction) {
    const pat = REASONING_PATTERNS.find((p) => p.match.test(text));
    if (scenario === 'fake') {
      return { text: wrongReasoningReply(), isReasoning: true };
    }
    if (scenario === 'downgraded') {
      // 交替：奇数次请求（第 1、3、5…题）答对，偶数答错 —— 3 题中约对 1-2 题
      downgradedCounter.n += 1;
      const correct = downgradedCounter.n % 2 === 1;
      if (!correct || !pat) {
        return { text: wrongReasoningReply(), isReasoning: true };
      }
    }
    if (!pat) {
      // 未收录的题：genuine 也按答错处理（不应发生）
      return { text: wrongReasoningReply(), isReasoning: true };
    }
    const work = pat.work ? `${pat.work}\n` : '';
    return { text: `${work}Answer: ${pat.expected}`, isReasoning: true };
  }

  // 2. 身份介绍
  if (text.includes('介绍') && text.includes('知识截止')) {
    return { text: identityReply(model), isReasoning: false };
  }

  // 4. BENCHMARK（token_count 检查）
  if (text.includes('2API Hub 的检测引擎')) {
    return { text: benchmarkReply(), isReasoning: false };
  }

  // 6. 兜底
  return { text: `收到。这是一条来自 mock-upstream 的回复。`, isReasoning: false };
}

/** thinking 文本（anthropic thinking 请求 / openai reasoning 场景用） */
export const THINKING_TEXT = 'The user wants weather information for Beijing. I should call the get_weather tool.';

/** 生成 thinking signature：88 字符 base64 风格随机串 */
export function makeSignature(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = '';
  for (let i = 0; i < 88; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s + '==';
}
