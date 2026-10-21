import { describe, expect, it } from 'vitest';
import { matchCatalogModelImpl, modelEchoMatches, normalizeModelName } from '../src/match.js';
import { checkTokenCount, checkTokenCountDiff, expectedPureTokens, expectedTokenRange, O200K_BENCHMARK_TOKENS } from '../src/calibration.js';
import { AUTH_CHECKS, verdictFromScore } from '@hub/shared';

const catalog = [
  { id: 1, slug: 'claude-opus-5-5', aliases: ['claude-opus-5.5', 'opus-5.5'] },
  { id: 2, slug: 'gpt-6-astra', aliases: ['gpt-6-astra'] },
  { id: 3, slug: 'gemini-3.8-flash', aliases: ['gemini-3-8-flash'] },
  { id: 4, slug: 'deepseek-v4-pro', aliases: ['deepseek-v4-pro-0813', 'deepseek-chat'] },
];

describe('normalizeModelName', () => {
  it('小写化', () => {
    expect(normalizeModelName('Claude-Opus-5-5')).toBe('claude-opus-5-5');
  });
  it('去厂商前缀', () => {
    expect(normalizeModelName('anthropic/claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(normalizeModelName('openai/gpt-6-astra')).toBe('gpt-6-astra');
  });
  it('去日期后缀（8 位与 4 位）', () => {
    expect(normalizeModelName('deepseek-v4-pro-20250813')).toBe('deepseek-v4-pro');
    expect(normalizeModelName('deepseek-v4-pro-0813')).toBe('deepseek-v4-pro');
  });
  it('不影响含数字的模型名', () => {
    expect(normalizeModelName('gpt-6-astra')).toBe('gpt-6-astra');
    expect(normalizeModelName('gemini-3.8-flash')).toBe('gemini-3.8-flash');
  });
});

describe('matchCatalogModelImpl', () => {
  it('精确 slug 匹配', () => {
    expect(matchCatalogModelImpl('claude-opus-5-5', catalog)).toBe(1);
  });
  it('忽略大小写', () => {
    expect(matchCatalogModelImpl('Claude-Opus-5-5', catalog)).toBe(1);
  });
  it('alias 匹配（含点号变体）', () => {
    expect(matchCatalogModelImpl('claude-opus-5.5', catalog)).toBe(1);
    expect(matchCatalogModelImpl('opus-5.5', catalog)).toBe(1);
  });
  it('厂商前缀剥离', () => {
    expect(matchCatalogModelImpl('anthropic/claude-opus-5-5', catalog)).toBe(1);
  });
  it('日期后缀剥离', () => {
    expect(matchCatalogModelImpl('deepseek-v4-pro-20250813', catalog)).toBe(4);
  });
  it('点号/横线宽松互转', () => {
    expect(matchCatalogModelImpl('gemini-3.8-flash', catalog)).toBe(3);
    expect(matchCatalogModelImpl('gemini-3-8-flash', catalog)).toBe(3);
  });
  it('未知模型返回 null', () => {
    expect(matchCatalogModelImpl('gpt-9-turbo', catalog)).toBeNull();
    expect(matchCatalogModelImpl('', catalog)).toBeNull();
  });
  it('空目录返回 null', () => {
    expect(matchCatalogModelImpl('claude-opus-5-5', [])).toBeNull();
  });
});

describe('modelEchoMatches', () => {
  it('完全相同', () => {
    expect(modelEchoMatches('claude-opus-5-5', 'claude-opus-5-5')).toBe(true);
  });
  it('大小写不同', () => {
    expect(modelEchoMatches('claude-opus-5-5', 'Claude-Opus-5-5')).toBe(true);
  });
  it('带日期后缀变体', () => {
    expect(modelEchoMatches('deepseek-v4-pro', 'deepseek-v4-pro-20250813')).toBe(true);
  });
  it('点号变体', () => {
    expect(modelEchoMatches('claude-opus-5-5', 'claude-opus-5.5')).toBe(true);
  });
  it('完全不同的模型 → false（换皮信号）', () => {
    expect(modelEchoMatches('claude-opus-5-5', 'gpt-4o-mini')).toBe(false);
  });
  it('回显缺失 → false', () => {
    expect(modelEchoMatches('claude-opus-5-5', null)).toBe(false);
    expect(modelEchoMatches('claude-opus-5-5', undefined)).toBe(false);
    expect(modelEchoMatches('claude-opus-5-5', '')).toBe(false);
  });
});

describe('calibration', () => {
  it('o200k 基准 token 数在合理范围（防止基准文本意外变更）', () => {
    expect(O200K_BENCHMARK_TOKENS).toBeGreaterThan(100);
    expect(O200K_BENCHMARK_TOKENS).toBeLessThan(250);
  });

  it('OpenAI 家族区间：期望值 = 精确 o200k 计数 + 协议开销', () => {
    const r = expectedTokenRange('openai', 'openai_chat');
    const overhead = 8;
    expect(r.expected).toBe(O200K_BENCHMARK_TOKENS * 1.0 + overhead);
  });

  it('Anthropic 期望值高于 OpenAI（分词器差异）', () => {
    const oa = expectedTokenRange('openai', 'anthropic');
    const anthropic = expectedTokenRange('anthropic', 'anthropic');
    expect(anthropic.expected).toBeGreaterThan(oa.expected);
  });

  it('换皮检测：Anthropic 渠道回显 OpenAI 分词计数 → 判 false', () => {
    // 真实场景：请求 claude，实际后端是 gpt → input_tokens ≈ o200k 计数
    const openaiCount = Math.round(O200K_BENCHMARK_TOKENS * 1.0 + 8); // openai_chat 协议开销
    const r = checkTokenCount('anthropic', 'anthropic', openaiCount);
    // anthropic 期望区间下限 ≈ 178*0.9=160，OpenAI 计数 150 → 落在区间外
    expect(r.passed).toBe(false);
  });

  it('真实 Anthropic 计数落在区间内 → 判 true', () => {
    const anthropicCount = Math.round(O200K_BENCHMARK_TOKENS * 1.2 + 8);
    const r = checkTokenCount('anthropic', 'anthropic', anthropicCount);
    expect(r.passed).toBe(true);
  });

  it('无 usage 数据 → null', () => {
    expect(checkTokenCount('anthropic', 'anthropic', null).passed).toBeNull();
    expect(checkTokenCount('anthropic', 'anthropic', 0).passed).toBeNull();
  });
});

describe('calibration 差分法（checkTokenCountDiff）', () => {
  it('纯文本期望值：expectedPureTokens 不含协议开销', () => {
    const r = expectedPureTokens('anthropic');
    expect(r.expected).toBe(Math.round(O200K_BENCHMARK_TOKENS * 1.2));
    // 区间 ±8%
    expect(r.range[0]).toBe(Math.floor(r.expected * 0.92));
    expect(r.range[1]).toBe(Math.ceil(r.expected * 1.08));
  });

  it('真实 Anthropic 差分（1×=178, 2×=348 → diff=170）→ 判 true', () => {
    // mock 实测值：usage1=186（含系统提示），usage2=356 → diff=170
    const r = checkTokenCountDiff('anthropic', 186, 356);
    expect(r.diff).toBe(170);
    expect(r.passed).toBe(true);
  });

  it('换皮检测：声称 anthropic 实为 openai（diff=142）→ 判 false', () => {
    // 实际后端按 o200k 计数：usage1=150, usage2=292 → diff=142
    const r = checkTokenCountDiff('anthropic', 150, 292);
    expect(r.diff).toBe(142);
    // anthropic 纯文本期望 170 ±8% = [156, 184]，142 落在区间外
    expect(r.passed).toBe(false);
  });

  it('差分法比单次法更严：deepseek 冒充 openai 也可检测', () => {
    // 声称 openai（期望纯文本 142±8%=[130,154]），实为 deepseek（×1.1 → 156.2）
    // 单次法 ±10% 下 1.09 比值不可检测；差分法 ±8% 下 156 > 154 可检测
    const usage1 = Math.round(O200K_BENCHMARK_TOKENS * 1.1 + 8); // deepseek 后端
    const usage2 = Math.round(O200K_BENCHMARK_TOKENS * 2.2 + 8);
    const r = checkTokenCountDiff('openai', usage1, usage2);
    expect(r.passed).toBe(false);
  });

  it('2× 计数不增长（伪造常量 usage）→ 判 false', () => {
    const r = checkTokenCountDiff('anthropic', 150, 150);
    expect(r.passed).toBe(false);
  });

  it('无 usage → null（不参与计分）', () => {
    expect(checkTokenCountDiff('anthropic', null, 356).passed).toBeNull();
    expect(checkTokenCountDiff('anthropic', 186, null).passed).toBeNull();
    expect(checkTokenCountDiff('anthropic', 0, 356).passed).toBeNull();
  });

  it('诚实声明：openai/xai/bytedance 簇内不可区分（token_count 对此无效）', () => {
    // 声称 xai 实为 openai：比值 1.00，任何容差都无法区分 → passed=true（不误报）
    const usage1 = O200K_BENCHMARK_TOKENS + 8;
    const usage2 = O200K_BENCHMARK_TOKENS * 2 + 8;
    const r = checkTokenCountDiff('xai', usage1, usage2);
    expect(r.passed).toBe(true); // 无法检测，但不给出错误的 fake 信号
  });
});

describe('评分与判定（verdictFromScore 一致性）', () => {
  it('检查项 id / 权重与 AUTH_CHECKS 一致（8 项，总权重 100）', () => {
    expect(AUTH_CHECKS).toHaveLength(8);
    const total = AUTH_CHECKS.reduce((s, c) => s + c.weight, 0);
    expect(total).toBe(100);
    const ids = AUTH_CHECKS.map((c) => c.id);
    expect(ids).toEqual(['connectivity', 'model_echo', 'response_shape', 'token_count', 'knowledge', 'reasoning', 'capability', 'speed']);
  });

  it('判定边界：≥80 genuine / 50–79 suspect / <50 fake / 权重不足 unknown', () => {
    expect(verdictFromScore(80, 100)).toBe('genuine');
    expect(verdictFromScore(100, 100)).toBe('genuine');
    expect(verdictFromScore(79, 100)).toBe('suspect');
    expect(verdictFromScore(50, 100)).toBe('suspect');
    expect(verdictFromScore(49, 100)).toBe('fake');
    expect(verdictFromScore(0, 100)).toBe('fake');
    expect(verdictFromScore(90, 29)).toBe('unknown'); // 已执行权重 < 30
    expect(verdictFromScore(null, 100)).toBe('unknown');
  });
});
