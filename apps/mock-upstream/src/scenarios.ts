/*
 * scenario 定义与判定：mock-upstream 的 8 种行为模式。
 * 每个 scenario 决定 usage 计数方式、推理题正确性、协议特征完整性等。
 */

export const SCENARIOS = [
  'genuine',
  'fast',
  'slow',
  'flaky',
  'ratelimited',
  'downgraded',
  'fake',
  'dead',
] as const;

export type Scenario = (typeof SCENARIOS)[number];

export const DEFAULT_SCENARIO: Scenario = 'genuine';

/** 判定路径第一段是否为合法 scenario */
export function isScenario(s: string): s is Scenario {
  return (SCENARIOS as readonly string[]).includes(s);
}

/** 协议类型（与 probe 引擎的 ChannelProtocol 对齐） */
export type Protocol = 'openai_chat' | 'openai_responses' | 'anthropic' | 'gemini';

export interface ScenarioBehavior {
  /** usage 计数模式：genuine=按厂商分词器系数；downgraded=全部按 o200k+8；fake=无 usage */
  usageMode: 'vendor' | 'openai_flat' | 'fake';
  /** 推理题答题模式 */
  reasoning: 'correct' | 'alternate' | 'always_wrong';
  /** 协议特征是否完整（id 前缀、事件序列、usage 结构） */
  shapeOk: boolean;
  /** thinking signature：genuine=生成随机串；downgraded=空串；其他=null（不适用） */
  thinkingSignature: 'generated' | 'empty' | null;
  /** 模型名回显是否被改写 */
  rewriteModel: boolean;
  /** 流式 chunk 间隔与 TTFT */
  timing: { ttftMs: number; chunkIntervalMs: number };
  /** 错误注入：每次请求按概率返回状态码（先于其他处理） */
  errorRate: { status: number; probability: number } | null;
  /** 固定错误状态码（dead） */
  alwaysError: number | null;
}

const GENUINE_TIMING = { ttftMs: 50, chunkIntervalMs: 10 };

/** 各 scenario 的行为定义 */
export const SCENARIO_BEHAVIORS: Record<Scenario, ScenarioBehavior> = {
  genuine: {
    usageMode: 'vendor',
    reasoning: 'correct',
    shapeOk: true,
    thinkingSignature: 'generated',
    rewriteModel: false,
    timing: { ttftMs: 40, chunkIntervalMs: 10 },
    errorRate: null,
    alwaysError: null,
  },
  fast: {
    usageMode: 'vendor',
    reasoning: 'correct',
    shapeOk: true,
    thinkingSignature: 'generated',
    rewriteModel: false,
    timing: { ttftMs: 5, chunkIntervalMs: 1 },
    errorRate: null,
    alwaysError: null,
  },
  slow: {
    usageMode: 'vendor',
    reasoning: 'correct',
    shapeOk: true,
    thinkingSignature: 'generated',
    rewriteModel: false,
    // TTFT 6-12 秒随机，见 randomTtftMs()
    timing: { ttftMs: -1, chunkIntervalMs: 5 },
    errorRate: null,
    alwaysError: null,
  },
  flaky: {
    usageMode: 'vendor',
    reasoning: 'correct',
    shapeOk: true,
    thinkingSignature: 'generated',
    rewriteModel: false,
    timing: GENUINE_TIMING,
    errorRate: { status: 502, probability: 0.3 },
    alwaysError: null,
  },
  ratelimited: {
    usageMode: 'vendor',
    reasoning: 'correct',
    shapeOk: true,
    thinkingSignature: 'generated',
    rewriteModel: false,
    timing: GENUINE_TIMING,
    errorRate: { status: 429, probability: 0.5 },
    alwaysError: null,
  },
  downgraded: {
    usageMode: 'openai_flat',
    reasoning: 'alternate',
    shapeOk: true,
    thinkingSignature: 'empty',
    rewriteModel: false,
    timing: GENUINE_TIMING,
    errorRate: null,
    alwaysError: null,
  },
  fake: {
    usageMode: 'fake',
    reasoning: 'always_wrong',
    shapeOk: false,
    thinkingSignature: null,
    rewriteModel: true,
    timing: GENUINE_TIMING,
    errorRate: null,
    alwaysError: null,
  },
  dead: {
    usageMode: 'fake',
    reasoning: 'always_wrong',
    shapeOk: false,
    thinkingSignature: null,
    rewriteModel: true,
    timing: GENUINE_TIMING,
    errorRate: null,
    alwaysError: 503,
  },
};

/** 计算 TTFT：slow 场景 6-12 秒随机，其他用固定值加少量抖动 */
export function ttftMs(scenario: Scenario): number {
  const b = SCENARIO_BEHAVIORS[scenario];
  if (b.timing.ttftMs < 0) {
    return 6000 + Math.floor(Math.random() * 6000); // 6-12s
  }
  return Math.max(1, Math.round(b.timing.ttftMs * (0.8 + Math.random() * 0.4)));
}
