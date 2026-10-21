/*
 * token 计数：与 packages/probe/src/calibration.ts 的校准方法对齐。
 *
 * - genuine：用 gpt-tokenizer o200k_base 精确计数请求文本，再按厂商系数换算
 *   （anthropic ×1.2、gemini ×1.05、openai ×1.0，deepseek/xai/zhipu/moonshot/bytedance
 *   按 VENDOR_CALIBRATION 同款系数），加协议固定开销。
 * - downgraded：全部协议统一 o200k + 8（「换皮」信号：anthropic 请求也返回 o200k 计数）。
 * - fake：不返回 usage（见 protocols.ts，不走本文件计数）。
 */

import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

/** 厂商分词器相对 o200k_base 的系数（与 probe 的 VENDOR_CALIBRATION 保持一致） */
const VENDOR_RATIO: Record<string, number> = {
  openai: 1.0,
  anthropic: 1.2,
  google: 1.05,
  deepseek: 1.1,
  xai: 1.0,
  zhipu: 1.05,
  moonshot: 0.95,
  bytedance: 1.0,
};

/** 各协议固定开销（与 probe 的 PROTOCOL_OVERHEAD 保持一致） */
export const PROTOCOL_OVERHEAD: Record<string, number> = {
  openai_chat: 8,
  openai_responses: 6,
  anthropic: 8,
  gemini: 4,
};

/** 根据模型名推断厂商 slug（宽松匹配，未识别返回 openai 作为兜底） */
export function vendorOfModel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 'openai';
  if (m.includes('gemini')) return 'google';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('grok')) return 'xai';
  if (m.includes('glm') || m.includes('chatglm')) return 'zhipu';
  if (m.includes('kimi') || m.includes('moonshot')) return 'moonshot';
  if (m.includes('doubao') || m.includes('seedance')) return 'bytedance';
  return 'openai';
}

export type UsageMode = 'vendor' | 'openai_flat';

/**
 * 计算 input/output token 计数。
 * @param mode vendor=按厂商系数（genuine）；openai_flat=统一 o200k+8（downgraded）
 * @param model 请求中的模型名（决定厂商系数）
 * @param protocol 协议（决定固定开销）
 * @param inputText 请求中全部文本（system + user 消息拼接）
 * @param outputText 回复文本
 */
export function computeUsage(
  mode: UsageMode,
  model: string,
  protocol: string,
  inputText: string,
  outputText: string,
): { inputTokens: number; outputTokens: number } {
  const inputO200k = countTokens(inputText);
  const outputO200k = countTokens(outputText);
  if (mode === 'openai_flat') {
    return { inputTokens: inputO200k + 8, outputTokens: outputO200k };
  }
  const ratio = VENDOR_RATIO[vendorOfModel(model)] ?? 1.0;
  const overhead = PROTOCOL_OVERHEAD[protocol] ?? 8;
  return {
    inputTokens: Math.round(inputO200k * ratio) + overhead,
    outputTokens: Math.round(outputO200k * ratio),
  };
}
