import type {
  AuthenticityCheckId,
  ChannelProtocol,
  ChannelSort,
  ModelModality,
  ModelTier,
  ScoringWeights,
  SettingsMap,
  SiteStatus,
  SiteType,
  TrustVerdict,
} from './contract';

// ---------- labels ----------
export const PROTOCOL_LABELS: Record<ChannelProtocol, string> = {
  openai_chat: 'OpenAI Chat',
  openai_responses: 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
  gemini: 'Gemini',
};

export const SITE_TYPE_LABELS: Record<SiteType, string> = {
  new_api: 'New API',
  sub2api: 'Sub2API',
  one_api: 'One API',
  custom: '自研',
};

export const SITE_STATUS_LABELS: Record<SiteStatus, string> = {
  draft: '草稿',
  pending: '审核中',
  approved: '已上线',
  rejected: '已驳回',
  suspended: '已下架',
};

export const VERDICT_LABELS: Record<TrustVerdict, string> = {
  genuine: '真模型',
  suspect: '存疑',
  fake: '疑似假模型',
  unknown: '未检测',
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  alipay: '支付宝',
  wechat: '微信支付',
  usdt: 'USDT',
  card: '银行卡',
};

// ---------- authenticity checks (SPEC §5.3) ----------
export const AUTH_CHECKS: { id: AuthenticityCheckId; name: string; weight: number; description: string }[] = [
  { id: 'connectivity', name: '连通性', weight: 10, description: '接口能否正常返回' },
  { id: 'model_echo', name: '模型名回显', weight: 10, description: '响应中的 model 字段是否与请求一致' },
  { id: 'response_shape', name: '协议特征', weight: 15, description: '响应 id 前缀、usage 结构等是否符合官方协议' },
  { id: 'token_count', name: 'Token 计数一致性', weight: 20, description: '输入 token 计数是否符合该厂商分词器' },
  { id: 'knowledge', name: '知识与身份', weight: 10, description: '自我身份与知识截止时间是否吻合' },
  { id: 'reasoning', name: '推理能力', weight: 20, description: '确定性推理题正确率（降智检测）' },
  { id: 'capability', name: '能力特征', weight: 10, description: 'thinking / tool calling 等厂商特有能力' },
  { id: 'speed', name: '输出速度', weight: 5, description: '输出 tokens/s 是否在合理区间' },
];

export const AUTH_CHECK_NAME: Record<AuthenticityCheckId, string> = Object.fromEntries(
  AUTH_CHECKS.map((c) => [c.id, c.name]),
) as Record<AuthenticityCheckId, string>;

export function verdictFromScore(score: number | null, executedWeight: number): TrustVerdict {
  if (score === null || executedWeight < 30) return 'unknown';
  if (score >= 80) return 'genuine';
  if (score >= 50) return 'suspect';
  return 'fake';
}

// ---------- pricing ----------
/** 实际倍率 = 分组倍率 / 充值倍率 */
export function actualRatio(groupRatio: number, rechargeRatio: number): number {
  if (!rechargeRatio || rechargeRatio <= 0) return groupRatio;
  return Math.round((groupRatio / rechargeRatio) * 10000) / 10000;
}

/** ¥/M 单价 = 官方 $/M 单价 × 实际倍率 */
export function priceCny(officialUsdPerM: number | null | undefined, ratio: number): number | null {
  if (officialUsdPerM === null || officialUsdPerM === undefined) return null;
  return Math.round(officialUsdPerM * ratio * 1000) / 1000;
}

// ---------- scoring (SPEC §5.5) ----------
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = { uptime: 0.45, latency: 0.2, trust: 0.25, stability: 0.1 };
export const MIN_SAMPLES_FOR_SCORE = 6;

export function computeRecommendScore(input: {
  uptime24h: number | null;
  latencyP50: number | null;
  trustScore: number | null;
  consecutiveFailures: number;
  samples24h: number;
  weights?: ScoringWeights;
}): number | null {
  if (input.samples24h < MIN_SAMPLES_FOR_SCORE || input.uptime24h === null) return null;
  const w = input.weights ?? DEFAULT_SCORING_WEIGHTS;
  const uptimePart = input.uptime24h * 100;
  const latencyPart = input.latencyP50 === null ? 0 : clamp(100 - (input.latencyP50 - 1500) / 150, 0, 100);
  const trustPart = input.trustScore ?? 60;
  const stablePart = 100 - Math.min(input.consecutiveFailures * 20, 100);
  const total = w.uptime + w.latency + w.trust + w.stability;
  const score = (uptimePart * w.uptime + latencyPart * w.latency + trustPart * w.trust + stablePart * w.stability) / total;
  return Math.round(score * 10) / 10;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

/** 「只看稳定」判定：24h 可用率 ≥ 0.95 且样本 ≥ 12 */
export const STABLE_MIN_UPTIME = 0.95;
export const STABLE_MIN_SAMPLES = 12;

// ---------- list presets ----------
export const SORT_PRESETS: { id: string; label: string; sort: ChannelSort; order: 'asc' | 'desc' }[] = [
  { id: 'recommend', label: '综合推荐', sort: 'recommend', order: 'desc' },
  { id: 'price', label: '价格优先', sort: 'price', order: 'asc' },
  { id: 'stable', label: '稳定优先', sort: 'uptime', order: 'desc' },
  { id: 'fast', label: '响应优先', sort: 'latency', order: 'asc' },
  { id: 'trust', label: '可信优先', sort: 'trust', order: 'desc' },
];

export const DEFAULT_SORT_ORDER: Record<ChannelSort, 'asc' | 'desc'> = {
  recommend: 'desc',
  price: 'asc',
  ratio: 'asc',
  uptime: 'desc',
  latency: 'asc',
  trust: 'desc',
  updated: 'desc',
};

// ---------- settings ----------
export const DEFAULT_SETTINGS: SettingsMap = {
  'probe.defaultIntervalSec': 600,
  'probe.concurrency': 8,
  'probe.perSiteConcurrency': 2,
  'probe.timeoutMs': 30000,
  'authenticity.intervalHours': 24,
  'authenticity.merchantDailyLimit': 3,
  'scoring.weights': DEFAULT_SCORING_WEIGHTS,
  'verify.hourlyLimitPerIp': 10,
  'site.allowRegistration': true,
  'site.announcementBar': '',
};

export const SESSION_COOKIE = 'hub_session';

// ---------- seed catalog（演示数据，价格可在管理后台调整） ----------
export interface SeedVendor {
  slug: string;
  name: string;
  nameZh: string | null;
  color: string;
  website: string;
  sortOrder: number;
}

export const SEED_VENDORS: SeedVendor[] = [
  { slug: 'anthropic', name: 'Anthropic', nameZh: null, color: '#D97757', website: 'https://www.anthropic.com', sortOrder: 1 },
  { slug: 'openai', name: 'OpenAI', nameZh: null, color: '#10A37F', website: 'https://openai.com', sortOrder: 2 },
  { slug: 'google', name: 'Google', nameZh: '谷歌', color: '#4285F4', website: 'https://ai.google.dev', sortOrder: 3 },
  { slug: 'deepseek', name: 'DeepSeek', nameZh: '深度求索', color: '#4D6BFE', website: 'https://www.deepseek.com', sortOrder: 4 },
  { slug: 'xai', name: 'xAI', nameZh: null, color: '#E5E5E5', website: 'https://x.ai', sortOrder: 5 },
  { slug: 'zhipu', name: 'Zhipu', nameZh: '智谱', color: '#3859FF', website: 'https://www.zhipuai.cn', sortOrder: 6 },
  { slug: 'moonshot', name: 'Moonshot', nameZh: '月之暗面', color: '#8B5CF6', website: 'https://www.moonshot.cn', sortOrder: 7 },
  { slug: 'bytedance', name: 'ByteDance', nameZh: '字节跳动', color: '#FE2C55', website: 'https://www.volcengine.com', sortOrder: 8 },
];

export interface SeedModel {
  slug: string;
  displayName: string;
  vendor: string;
  family: string;
  modality: ModelModality;
  tier: ModelTier;
  aliases: string[];
  defaultProtocol: ChannelProtocol;
  input: number | null;
  output: number | null;
  contextWindow: number | null;
  knowledgeCutoff: string | null;
  expectedTps: number | null;
  featured: boolean;
}

export const SEED_MODELS: SeedModel[] = [
  { slug: 'claude-fable-5-1', displayName: 'Fable 5.1', vendor: 'anthropic', family: 'claude', modality: 'text', tier: 'flagship', aliases: ['claude-fable-5-1', 'claude-fable-5.1', 'fable-5.1'], defaultProtocol: 'anthropic', input: 30, output: 150, contextWindow: 1000000, knowledgeCutoff: '2026-06', expectedTps: 50, featured: true },
  { slug: 'claude-opus-5-5', displayName: 'Opus 5.5', vendor: 'anthropic', family: 'claude', modality: 'text', tier: 'flagship', aliases: ['claude-opus-5-5', 'claude-opus-5.5', 'opus-5.5'], defaultProtocol: 'anthropic', input: 15, output: 75, contextWindow: 1000000, knowledgeCutoff: '2026-06', expectedTps: 60, featured: true },
  { slug: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', vendor: 'anthropic', family: 'claude', modality: 'text', tier: 'standard', aliases: ['claude-sonnet-5-5', 'claude-sonnet-5.5', 'sonnet-5.5'], defaultProtocol: 'anthropic', input: 3, output: 15, contextWindow: 1000000, knowledgeCutoff: '2026-06', expectedTps: 80, featured: true },
  { slug: 'claude-haiku-5-5', displayName: 'Haiku 5.5', vendor: 'anthropic', family: 'claude', modality: 'text', tier: 'lite', aliases: ['claude-haiku-5-5', 'claude-haiku-5.5', 'haiku-5.5'], defaultProtocol: 'anthropic', input: 1, output: 5, contextWindow: 200000, knowledgeCutoff: '2026-06', expectedTps: 150, featured: false },
  { slug: 'gpt-6-astra', displayName: 'GPT 6 Astra', vendor: 'openai', family: 'gpt', modality: 'text', tier: 'flagship', aliases: ['gpt-6-astra'], defaultProtocol: 'openai_responses', input: 10, output: 40, contextWindow: 1000000, knowledgeCutoff: '2026-04', expectedTps: 70, featured: true },
  { slug: 'gpt-6.1-sol', displayName: 'GPT 6.1 Sol', vendor: 'openai', family: 'gpt', modality: 'text', tier: 'standard', aliases: ['gpt-6.1-sol', 'gpt-6-1-sol'], defaultProtocol: 'openai_responses', input: 1.25, output: 10, contextWindow: 400000, knowledgeCutoff: '2026-04', expectedTps: 90, featured: true },
  { slug: 'gpt-6-sol', displayName: 'GPT 6 Sol', vendor: 'openai', family: 'gpt', modality: 'text', tier: 'standard', aliases: ['gpt-6-sol'], defaultProtocol: 'openai_responses', input: 1.25, output: 10, contextWindow: 400000, knowledgeCutoff: '2026-01', expectedTps: 90, featured: false },
  { slug: 'gpt-5.6-sol', displayName: 'GPT 5.6 Sol', vendor: 'openai', family: 'gpt', modality: 'text', tier: 'standard', aliases: ['gpt-5.6-sol', 'gpt-5-6-sol'], defaultProtocol: 'openai_chat', input: 2.5, output: 10, contextWindow: 400000, knowledgeCutoff: '2025-10', expectedTps: 90, featured: false },
  { slug: 'gpt-image-2', displayName: 'GPT Image 2', vendor: 'openai', family: 'gpt-image', modality: 'image', tier: 'standard', aliases: ['gpt-image-2'], defaultProtocol: 'openai_chat', input: 5, output: 40, contextWindow: null, knowledgeCutoff: null, expectedTps: null, featured: false },
  { slug: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', vendor: 'google', family: 'gemini', modality: 'text', tier: 'standard', aliases: ['gemini-3.8-flash', 'gemini-3-8-flash'], defaultProtocol: 'gemini', input: 0.3, output: 2.5, contextWindow: 1000000, knowledgeCutoff: '2026-03', expectedTps: 180, featured: true },
  { slug: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', vendor: 'deepseek', family: 'deepseek', modality: 'text', tier: 'flagship', aliases: ['deepseek-v4-pro', 'deepseek-v4-pro-0813'], defaultProtocol: 'openai_chat', input: 0.55, output: 2.2, contextWindow: 256000, knowledgeCutoff: '2026-05', expectedTps: 50, featured: false },
  { slug: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash', vendor: 'deepseek', family: 'deepseek', modality: 'text', tier: 'lite', aliases: ['deepseek-v4.1-flash', 'deepseek-chat'], defaultProtocol: 'openai_chat', input: 0.14, output: 0.56, contextWindow: 256000, knowledgeCutoff: '2026-05', expectedTps: 120, featured: true },
  { slug: 'grok-4.7', displayName: 'Grok 4.7', vendor: 'xai', family: 'grok', modality: 'text', tier: 'flagship', aliases: ['grok-4.7', 'grok-4-7'], defaultProtocol: 'openai_chat', input: 3, output: 15, contextWindow: 512000, knowledgeCutoff: '2026-05', expectedTps: 80, featured: true },
  { slug: 'grok-4.6', displayName: 'Grok 4.6', vendor: 'xai', family: 'grok', modality: 'text', tier: 'standard', aliases: ['grok-4.6', 'grok-4-6'], defaultProtocol: 'openai_chat', input: 2, output: 10, contextWindow: 256000, knowledgeCutoff: '2026-02', expectedTps: 90, featured: false },
  { slug: 'glm-5.3', displayName: 'GLM 5.3', vendor: 'zhipu', family: 'glm', modality: 'text', tier: 'flagship', aliases: ['glm-5.3', 'glm-5-3'], defaultProtocol: 'openai_chat', input: 0.8, output: 2.8, contextWindow: 256000, knowledgeCutoff: '2026-06', expectedTps: 60, featured: true },
  { slug: 'glm-5.2', displayName: 'GLM 5.2', vendor: 'zhipu', family: 'glm', modality: 'text', tier: 'standard', aliases: ['glm-5.2', 'glm-5-2'], defaultProtocol: 'openai_chat', input: 0.6, output: 2.2, contextWindow: 200000, knowledgeCutoff: '2026-02', expectedTps: 70, featured: false },
  { slug: 'kimi-k3', displayName: 'Kimi K3', vendor: 'moonshot', family: 'kimi', modality: 'text', tier: 'flagship', aliases: ['kimi-k3'], defaultProtocol: 'openai_chat', input: 0.8, output: 3.2, contextWindow: 256000, knowledgeCutoff: '2026-05', expectedTps: 60, featured: true },
  { slug: 'kimi-k2.7-code', displayName: 'Kimi K2.7 Code', vendor: 'moonshot', family: 'kimi', modality: 'text', tier: 'standard', aliases: ['kimi-k2.7-code', 'kimi-k2-7-code'], defaultProtocol: 'openai_chat', input: 0.6, output: 2.5, contextWindow: 256000, knowledgeCutoff: '2026-01', expectedTps: 80, featured: false },
  { slug: 'seedance-2.5', displayName: 'Seedance 2.5', vendor: 'bytedance', family: 'seedance', modality: 'video', tier: 'standard', aliases: ['seedance-2.5', 'doubao-seedance-2-5'], defaultProtocol: 'openai_chat', input: null, output: null, contextWindow: null, knowledgeCutoff: null, expectedTps: null, featured: false },
];
