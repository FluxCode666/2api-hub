/*
 * 校准表：各厂商家族对固定基准文本的期望 token 计数区间（SPEC §5.3 token_count 检查）。
 *
 * ============================ 区间与可区分性 ============================
 * 实际区间：[expected × (1 − tol), expected × (1 + tol)]，tol = TOLERANCE + MARGIN。
 * - 旧「单次法」（v1）：tol = 0.10（±10%）。见下方矩阵，56 个冒充组合仅 14 个可检测；
 *   openai/xai/bytedance（ratio 1.0）三者彼此完全不可区分，google/zhipu（1.05）同理。
 * - 新「差分法」（v2，默认）：对基准文本发 1× 和 2× 两个请求，用 usage 差值得到
 *   纯文本 token 数（协议开销在两次请求中相同，相减消除），区间收窄到 ±8%
 *   （TOLERANCE，不再需要 MARGIN）。可检测组合 26/56。
 * 两个方向的已知盲区（诚实声明）：
 * - openai ↔ xai ↔ bytedance ↔ google ↔ zhipu 家族彼此比值 ≤1.05，任何容差都不可区分
 *   （它们的分词器对基准文本计数本就几乎相同）。token_count 对这些组合无效，
 *   由 reasoning/knowledge/capability 等其他检查补位。
 * - anthropic（1.20）冒充任何其他厂商、或被任何其他厂商冒充，均可检测（差分法全 ✓）。
 *
 * ============================ 方法论 ============================
 * 1. OpenAI 系（gpt 家族，o200k_base 编码）用 gpt-tokenizer 精确计算基准文本 token 数。
 * 2. 其他厂商没有公开可本地运行的分词器，用公开资料的经验比例推算：
 *    - Anthropic ×1.20：官方文档 "tiktoken undercounts Claude by ~15-20% on typical text,
 *      more on code/non-English"（platform.claude.com token-counting）。
 *    - Google ×1.05：官方 1 token≈4 chars；实测英文 ×1.01、中文 ×0.85、代码 ×1.23
 *      （getllmcalc.com 50 样本实测）。
 *    - DeepSeek ×1.10：官方 1 英文字符≈0.3 token、1 中文字符≈0.6 token。
 *    - xAI ×1.00：Grok 分词器与 tiktoken 接近。
 *    - 智谱 ×1.05 / Moonshot ×0.95 / 字节 ×1.00：自研 BPE，公开评测与 o200k 差距 ±10% 内。
 * 3. 运营方应定期用官方 Key 跑 calibrate CLI（scripts/calibrate.ts）回归实测值，
 *    固化各厂商区间（见 docs/handoff/probe.md「真实环境校准指南」）。
 */

import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

/**
 * 固定基准文本：中英混合 + 代码，用于 token 计数一致性检查。
 * 特点：词汇多样、含代码缩进/符号/中文标点，能放大家族间分词器差异。
 */
export const BENCHMARK_TEXT = `你是 2API Hub 的检测引擎。Please translate the following into Chinese and keep the code unchanged.

Task: given a list of prices, compute the total and apply a 8.5% discount.

\`\`\`python
def total_with_discount(prices, rate=0.085):
    subtotal = sum(prices)
    return round(subtotal * (1 - rate), 2)
\`\`\`

输入数据（JSON）：{"prices": [12.5, 30, 199.99], "currency": "CNY"}
要求：输出总金额、折扣后金额（保留两位小数），以及一句中文总结。注意：不要遗漏任何字段！`;

/** OpenAI o200k_base 对基准文本（纯文本部分）的精确 token 数 */
export const O200K_BENCHMARK_TOKENS: number = countTokens(BENCHMARK_TEXT);

/**
 * 各协议包装的固定开销（tokens）：system/user/assistant 角色标记 + 消息结尾符。
 * 单次法需要；差分法通过两次请求相减自动消除，无需精确。
 * openai_chat: 每条消息约 4 tokens（role + 特殊标记 + end），2 条消息 ≈ 8
 * openai_responses: input 数组有类型标记，约 6 tokens
 * anthropic: 每条消息约 4 tokens + 顶层若干（对齐官方 count_tokens 实测）
 * gemini: contents/parts 结构开销小，约 4 tokens
 */
export const PROTOCOL_OVERHEAD: Record<string, number> = {
  openai_chat: 8,
  openai_responses: 6,
  anthropic: 8,
  gemini: 4,
};

export interface VendorCalibration {
  /** 相对 o200k_base 计数的乘数（经验值） */
  ratio: number;
  /** 来源说明 */
  source: string;
}

/** 按厂商 slug 的分词器相对系数（见文件头方法论） */
export const VENDOR_CALIBRATION: Record<string, VendorCalibration> = {
  openai: { ratio: 1.0, source: 'o200k_base 精确计算 (gpt-tokenizer)' },
  anthropic: { ratio: 1.2, source: '官方文档：tiktoken 少计 15-20%，中文/代码差距更大' },
  google: { ratio: 1.05, source: '官方 1 token≈4 chars；实测英文 ×1.01、中文 ×0.85、代码 ×1.23' },
  deepseek: { ratio: 1.1, source: '官方：1 英文字符≈0.3 token、1 中文字符≈0.6 token' },
  xai: { ratio: 1.0, source: 'Grok 分词器与 tiktoken 接近' },
  zhipu: { ratio: 1.05, source: 'GLM 自研 BPE，中英混合与 o200k 差距 ±10%' },
  moonshot: { ratio: 0.95, source: 'Kimi 中文分词效率略优' },
  bytedance: { ratio: 1.0, source: '豆包未公开分词器，按中文优化惯例' },
};

/** 默认系数（未知厂商） */
export const DEFAULT_CALIBRATION: VendorCalibration = { ratio: 1.1, source: '未知厂商，默认中庸区间' };

/** token_count 检查的容差：SPEC 规定 ±8% */
export const TOKEN_COUNT_TOLERANCE = 0.08;
/**
 * 单次法额外放宽（吸收中转站 prepend 系统提示、协议包装误差）。
 * 差分法不需要 MARGIN（开销被消除，中转站 prepend 也随差值抵消）。
 */
export const TOKEN_COUNT_MARGIN = 0.02;

/**
 * 计算「纯文本」期望 token 数（差分法）：o200k × ratio，不含协议开销。
 */
export function expectedPureTokens(vendorSlug: string): { expected: number; range: [number, number]; source: string } {
  const cal = VENDOR_CALIBRATION[vendorSlug] ?? DEFAULT_CALIBRATION;
  const expected = Math.round(O200K_BENCHMARK_TOKENS * cal.ratio);
  return {
    expected,
    range: [Math.floor(expected * (1 - TOKEN_COUNT_TOLERANCE)), Math.ceil(expected * (1 + TOKEN_COUNT_TOLERANCE))],
    source: cal.source,
  };
}

/**
 * 计算某厂商某协议下「单次请求」的期望 input token 区间（单次法，兼容保留）。
 * @returns min/expected/max；vendorSlug 未收录时用默认系数
 */
export function expectedTokenRange(vendorSlug: string, protocol: string): { min: number; expected: number; max: number; source: string } {
  const cal = VENDOR_CALIBRATION[vendorSlug] ?? DEFAULT_CALIBRATION;
  const defaultOverhead = PROTOCOL_OVERHEAD['openai_chat'] ?? 8;
  const overhead = PROTOCOL_OVERHEAD[protocol] ?? defaultOverhead;
  const expected = Math.round(O200K_BENCHMARK_TOKENS * cal.ratio + overhead);
  const tol = TOKEN_COUNT_TOLERANCE + TOKEN_COUNT_MARGIN; // 0.10
  return {
    min: Math.floor(expected * (1 - tol)),
    expected,
    max: Math.ceil(expected * (1 + tol)),
    source: cal.source,
  };
}

/**
 * 差分法判定（推荐）：用 usage(2×文本) − usage(1×文本) 的差值（= 纯文本 token）
 * 与厂商纯文本期望区间比较。
 * @param usage1 1× 基准文本请求的 input_tokens
 * @param usage2 2× 基准文本请求的 input_tokens
 */
export function checkTokenCountDiff(
  vendorSlug: string,
  usage1: number | null,
  usage2: number | null,
): {
  passed: boolean | null;
  expected: number;
  range: [number, number];
  source: string;
  /** 差值（纯文本 token 数），无数据时为 null */
  diff: number | null;
} {
  const { expected, range, source } = expectedPureTokens(vendorSlug);
  if (usage1 === null || usage2 === null || usage1 <= 0 || usage2 <= 0) {
    return { passed: null, expected, range, source, diff: null };
  }
  const diff = usage2 - usage1;
  if (diff <= 0) {
    // 差值非正：2× 请求计数不增 → usage 可疑（假数据）
    return { passed: false, expected, range, source, diff };
  }
  const passed = diff >= range[0] && diff <= range[1];
  return { passed, expected, range, source, diff };
}

/**
 * 判定实际 input tokens 是否落在期望区间（单次法，兼容保留）。
 * @returns null=无 usage 数据；true/false=通过与否
 */
export function checkTokenCount(vendorSlug: string, protocol: string, actualInputTokens: number | null): {
  passed: boolean | null;
  expected: number;
  range: [number, number];
  source: string;
} {
  const { min, expected, max, source } = expectedTokenRange(vendorSlug, protocol);
  if (actualInputTokens === null || actualInputTokens <= 0) {
    return { passed: null, expected, range: [min, max], source };
  }
  const passed = actualInputTokens >= min && actualInputTokens <= max;
  return { passed, expected, range: [min, max], source };
}
