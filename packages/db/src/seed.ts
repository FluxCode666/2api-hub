/*
 * 幂等种子脚本：pnpm --filter @hub/db seed
 * 先 TRUNCATE 全部业务表（RESTART IDENTITY CASCADE），再插入演示数据。
 * 不写 channel_stats / site_stats（由 worker 聚合）。
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import {
  AUTH_CHECKS,
  DEFAULT_SETTINGS,
  SEED_MODELS,
  SEED_VENDORS,
  actualRatio,
} from '@hub/shared';
import type { AuthenticityCheck, ChannelProtocol, TrustVerdict } from '@hub/shared';
import { createDb } from './client';
import { encryptSecret, maskSecret } from './crypto';
import {
  announcements,
  authenticityReports,
  channelModels,
  channels,
  favorites,
  feedback,
  models,
  probeRuns,
  reviews,
  settings,
  sites,
  users,
  vendors,
} from './schema';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

// ---------- 随机工具 ----------
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));
const chance = (p: number) => Math.random() < p;
const pick = <T>(arr: T[]) => arr[randInt(0, arr.length - 1)]!;
const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000);
const randomToken = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);

// ---------- mock-upstream scenario 画像（SPEC §10） ----------
type Scenario = 'genuine' | 'fast' | 'slow' | 'flaky' | 'ratelimited' | 'downgraded' | 'fake' | 'dead';
interface ScenarioProfile {
  successRate: number;
  latency: [number, number] | null; // null = 永远失败无延迟
  ttft: (latency: number) => number | null;
  failStatus: number;
  failCode: string;
  failMsg: string;
}
const SCENARIO_PROFILES: Record<Scenario, ScenarioProfile> = {
  genuine: {
    successRate: 0.99, latency: [800, 2500],
    ttft: (l) => Math.round(l * rand(0.3, 0.6)),
    failStatus: 502, failCode: 'http_5xx', failMsg: '上游返回 502，网关错误',
  },
  fast: {
    successRate: 0.995, latency: [150, 600],
    ttft: (l) => Math.round(l * rand(0.3, 0.6)),
    failStatus: 502, failCode: 'http_5xx', failMsg: '上游偶发 502',
  },
  slow: {
    successRate: 0.98, latency: [6000, 14000],
    ttft: (l) => Math.min(Math.round(rand(6000, 12000)), l),
    failStatus: 504, failCode: 'timeout', failMsg: '上游响应超时（30s）',
  },
  flaky: {
    successRate: 0.7, latency: [800, 2500],
    ttft: (l) => Math.round(l * rand(0.3, 0.6)),
    failStatus: 502, failCode: 'http_5xx', failMsg: '上游不稳定，间歇性 502',
  },
  ratelimited: {
    successRate: 0.6, latency: [500, 1800],
    ttft: (l) => Math.round(l * rand(0.3, 0.6)),
    failStatus: 429, failCode: 'http_429', failMsg: '触发上游限流（429）',
  },
  downgraded: {
    successRate: 0.97, latency: [1000, 3000],
    ttft: (l) => Math.round(l * rand(0.4, 0.7)),
    failStatus: 502, failCode: 'http_5xx', failMsg: '上游返回 502',
  },
  fake: {
    successRate: 0.95, latency: [500, 1500],
    ttft: (l) => Math.round(l * rand(0.3, 0.6)),
    failStatus: 502, failCode: 'http_5xx', failMsg: '上游返回 502',
  },
  dead: {
    successRate: 0, latency: null,
    ttft: () => null,
    failStatus: 503, failCode: 'http_5xx', failMsg: '上游服务不可用（503）',
  },
};

// ---------- 站点定义 ----------
interface SiteDef {
  slug: string; name: string; domain: string; type: 'new_api' | 'sub2api' | 'one_api' | 'custom';
  rechargeRatio: number; description: string;
  contact: { qq?: string; telegram?: string; email?: string; group?: string };
  tags: string[]; paymentMethods: string[];
  pending?: boolean; verified?: boolean; featured?: boolean; sortWeight?: number;
}
const SITE_DEFS: SiteDef[] = [
  { slug: 'xinghe-api', name: '星河API', domain: 'xingheapi.com', type: 'new_api', rechargeRatio: 1, description: '老牌中转站，主营 Claude / GPT 官方渠道，稳定运营两年。', contact: { qq: '88112233', telegram: '@xinghe_api' }, tags: ['稳定', '官转', '老牌'], paymentMethods: ['alipay', 'wechat'], verified: true, featured: true, sortWeight: 100 },
  { slug: 'mitao-api', name: '蜜桃API', domain: 'mitaoapi.cn', type: 'sub2api', rechargeRatio: 0.5, description: '高性价比中转，Claude 镜像低价量大，适合个人开发者。', contact: { telegram: '@mitaoapi', group: 'https://t.me/mitaoapi' }, tags: ['低价', '镜像'], paymentMethods: ['alipay', 'usdt'], featured: true, sortWeight: 80 },
  { slug: 'xingyun-relay', name: '星云中转', domain: 'xingyun.dev', type: 'new_api', rechargeRatio: 0.7, description: '国产模型与 GPT-6 专线聚合，企业级 SLA。', contact: { email: 'hi@xingyun.dev', qq: '44556677' }, tags: ['企业', '国产模型'], paymentMethods: ['alipay', 'wechat', 'card'], verified: true },
  { slug: 'opengate', name: 'OpenGate', domain: 'opengate.ai', type: 'custom', rechargeRatio: 1, description: '自研网关，主打 Claude Code 专线与 GPT-6 Astra 官转。', contact: { telegram: '@opengate' }, tags: ['自研', 'Claude Code'], paymentMethods: ['usdt', 'card'], featured: true, sortWeight: 90 },
  { slug: 'jifeng-api', name: '疾风API', domain: 'jifengapi.com', type: 'one_api', rechargeRatio: 0.142857, description: '¥7 = $1 额度，白菜价走量站。', contact: { qq: '99001122' }, tags: ['白菜价', '走量'], paymentMethods: ['alipay', 'wechat'] },
  { slug: 'qingyun-hub', name: '青云中转', domain: 'qingyunhub.top', type: 'new_api', rechargeRatio: 0.5, description: '逆向与官方混合线路，Gemini 速度快。', contact: { telegram: '@qingyunhub' }, tags: ['混合线路'], paymentMethods: ['alipay', 'usdt'] },
  { slug: 'jiguang-api', name: '极光API', domain: 'jiguangapi.net', type: 'sub2api', rechargeRatio: 0.8, description: '全模型高速通道，晚高峰不掉速。', contact: { qq: '11223344', telegram: '@jiguangapi' }, tags: ['高速', '全模型'], paymentMethods: ['alipay', 'wechat', 'usdt'] },
  { slug: 'bailu-gw', name: '白鹭网关', domain: 'bailugw.com', type: 'custom', rechargeRatio: 0.6, description: '经济型网关，GLM 专线业内最低倍率。', contact: { email: 'support@bailugw.com' }, tags: ['经济', 'GLM'], paymentMethods: ['alipay'] },
  { slug: 'huanhe-api', name: '幻核API', domain: 'huanheapi.xyz', type: 'new_api', rechargeRatio: 0.3, description: '超低价 Claude，价格美丽但请留意真伪检测结果。', contact: { telegram: '@huanhe' }, tags: ['超低价'], paymentMethods: ['usdt'] },
  { slug: 'lanjing-relay', name: '蓝鲸中转', domain: 'lanjing.io', type: 'one_api', rechargeRatio: 0.4, description: '企业线路与备用线路双轨，Grok 低价。', contact: { qq: '55667788', group: 'https://t.me/lanjing' }, tags: ['企业', '备用线'], paymentMethods: ['alipay', 'wechat', 'card'] },
  { slug: 'xiguang-api', name: '曦光API', domain: 'xiguangapi.com', type: 'new_api', rechargeRatio: 0.9, description: '官方渠道原价附近，胜在稳定与售后。', contact: { email: 'hello@xiguangapi.com' }, tags: ['官转', '售后好'], paymentMethods: ['alipay', 'wechat'] },
  { slug: 'duanya-data', name: '断崖数据', domain: 'duanya.top', type: 'custom', rechargeRatio: 0.25, description: '骨折价站点，部分线路已失联，谨慎充值。', contact: { telegram: '@duanya' }, tags: ['骨折价', '风险'], paymentMethods: ['usdt'] },
  // 待审核入驻申请
  { slug: 'chenxi-api', name: '晨曦API', domain: 'chenxiapi.com', type: 'new_api', rechargeRatio: 0.5, description: '新站入驻申请：主营 Kimi 长文本。', contact: { qq: '66778899' }, tags: ['新站'], paymentMethods: ['alipay'], pending: true },
  { slug: 'wuyu-api', name: '雾屿API', domain: 'wuyuapi.cn', type: 'sub2api', rechargeRatio: 1, description: '新站入驻申请：Claude 官转，刚开张。', contact: { telegram: '@wuyuapi' }, tags: ['新站', '官转'], paymentMethods: ['alipay', 'usdt'], pending: true },
];

// ---------- 渠道定义 ----------
interface ChannelDef {
  site: number; // SITE_DEFS 下标
  name: string; vendor: string; protocol: ChannelProtocol; scenario: Scenario; groupRatio: number;
  priceOverride?: { input: number; output: number };
}
const CHANNEL_DEFS: ChannelDef[] = [
  { site: 0, name: 'Claude 官转', vendor: 'anthropic', protocol: 'anthropic', scenario: 'genuine', groupRatio: 1 },
  { site: 0, name: 'GPT 官方渠道', vendor: 'openai', protocol: 'openai_responses', scenario: 'genuine', groupRatio: 1 },
  { site: 0, name: 'DeepSeek 特惠', vendor: 'deepseek', protocol: 'openai_chat', scenario: 'fast', groupRatio: 0.5 },
  { site: 1, name: 'Claude 镜像', vendor: 'anthropic', protocol: 'anthropic', scenario: 'fast', groupRatio: 0.3 },
  { site: 1, name: 'GPT 低价', vendor: 'openai', protocol: 'openai_chat', scenario: 'genuine', groupRatio: 0.25, priceOverride: { input: 1.2, output: 4.8 } },
  { site: 1, name: 'Gemini 专区', vendor: 'google', protocol: 'gemini', scenario: 'genuine', groupRatio: 0.2 },
  { site: 2, name: 'GPT-6 专线', vendor: 'openai', protocol: 'openai_responses', scenario: 'genuine', groupRatio: 0.7 },
  { site: 2, name: '国产模型合集', vendor: 'zhipu', protocol: 'openai_chat', scenario: 'genuine', groupRatio: 0.35 },
  { site: 2, name: 'Grok 专区', vendor: 'xai', protocol: 'openai_chat', scenario: 'flaky', groupRatio: 0.7 },
  { site: 3, name: 'Claude Code 专线', vendor: 'anthropic', protocol: 'anthropic', scenario: 'genuine', groupRatio: 1 },
  { site: 3, name: 'GPT-6 Astra 官转', vendor: 'openai', protocol: 'openai_responses', scenario: 'fast', groupRatio: 0.8 },
  { site: 3, name: 'Kimi 长文本', vendor: 'moonshot', protocol: 'openai_chat', scenario: 'slow', groupRatio: 0.5 },
  { site: 4, name: 'Claude 低价', vendor: 'anthropic', protocol: 'anthropic', scenario: 'genuine', groupRatio: 0.1 },
  { site: 4, name: 'GPT 白菜价', vendor: 'openai', protocol: 'openai_chat', scenario: 'downgraded', groupRatio: 0.07 },
  { site: 5, name: 'Claude 逆向', vendor: 'anthropic', protocol: 'anthropic', scenario: 'downgraded', groupRatio: 0.2 },
  { site: 5, name: 'GPT 官方', vendor: 'openai', protocol: 'openai_responses', scenario: 'genuine', groupRatio: 0.5 },
  { site: 5, name: 'Gemini 快速', vendor: 'google', protocol: 'gemini', scenario: 'fast', groupRatio: 0.15 },
  { site: 6, name: '全模型高速', vendor: 'openai', protocol: 'openai_chat', scenario: 'fast', groupRatio: 0.4 },
  { site: 6, name: 'Claude 精品', vendor: 'anthropic', protocol: 'anthropic', scenario: 'genuine', groupRatio: 0.8 },
  { site: 7, name: 'GPT 经济型', vendor: 'openai', protocol: 'openai_chat', scenario: 'genuine', groupRatio: 0.3, priceOverride: { input: 0.8, output: 3.2 } },
  { site: 7, name: 'Claude 稳定线', vendor: 'anthropic', protocol: 'anthropic', scenario: 'ratelimited', groupRatio: 0.6 },
  { site: 7, name: 'GLM 专线', vendor: 'zhipu', protocol: 'openai_chat', scenario: 'genuine', groupRatio: 0.06 },
  { site: 8, name: 'Claude 超低价', vendor: 'anthropic', protocol: 'anthropic', scenario: 'fake', groupRatio: 0.05 },
  { site: 8, name: 'GPT 特惠', vendor: 'openai', protocol: 'openai_responses', scenario: 'flaky', groupRatio: 0.3 },
  { site: 8, name: 'DeepSeek 直连', vendor: 'deepseek', protocol: 'openai_chat', scenario: 'genuine', groupRatio: 0.1 },
  { site: 9, name: 'Claude 企业线', vendor: 'anthropic', protocol: 'anthropic', scenario: 'slow', groupRatio: 0.4 },
  { site: 9, name: 'GPT 备用线', vendor: 'openai', protocol: 'openai_chat', scenario: 'ratelimited', groupRatio: 0.2 },
  { site: 9, name: 'Grok 低价', vendor: 'xai', protocol: 'openai_chat', scenario: 'genuine', groupRatio: 0.12 },
  { site: 10, name: 'GPT 官转', vendor: 'openai', protocol: 'openai_responses', scenario: 'genuine', groupRatio: 0.9 },
  { site: 10, name: 'Claude 官转', vendor: 'anthropic', protocol: 'anthropic', scenario: 'fast', groupRatio: 0.45 },
  { site: 11, name: 'Claude 骨折价', vendor: 'anthropic', protocol: 'anthropic', scenario: 'dead', groupRatio: 0.1 },
  { site: 11, name: '全模型失效线', vendor: 'openai', protocol: 'openai_chat', scenario: 'fake', groupRatio: 0.08 },
  { site: 12, name: 'Kimi 新站', vendor: 'moonshot', protocol: 'openai_chat', scenario: 'genuine', groupRatio: 0.5 },
  { site: 13, name: 'Claude 新站', vendor: 'anthropic', protocol: 'anthropic', scenario: 'downgraded', groupRatio: 0.3 },
];

// ---------- 真伪检测 checks 构造 ----------
type CheckClass = 'genuine' | 'downgraded' | 'fake' | 'dead';
function checkClassOf(s: Scenario): CheckClass {
  if (s === 'downgraded') return 'downgraded';
  if (s === 'fake') return 'fake';
  if (s === 'dead') return 'dead';
  return 'genuine';
}

function buildChecks(cls: CheckClass): AuthenticityCheck[] {
  return AUTH_CHECKS.map((c) => {
    const base = { id: c.id, name: c.name, weight: c.weight };
    if (cls === 'dead') {
      return c.id === 'connectivity'
        ? { ...base, passed: false, detail: '连接失败，上游持续返回 503' }
        : { ...base, passed: null, detail: '连通性未通过，该项未执行' };
    }
    if (cls === 'fake') {
      switch (c.id) {
        case 'model_echo': return { ...base, passed: false, detail: '请求 Claude 模型，响应回显为 gpt-4o-mini' };
        case 'response_shape': return { ...base, passed: false, detail: '响应缺少官方协议特征字段（id 前缀 / usage 结构不符）' };
        case 'token_count': return { ...base, passed: false, score: 0.2, detail: 'token 计数与官方分词器偏差超过 40%' };
        case 'reasoning': return { ...base, passed: false, score: 0.1, detail: '确定性推理题基本全部答错' };
        default: return { ...base, passed: true, detail: `${c.name}检查通过` };
      }
    }
    if (cls === 'downgraded') {
      switch (c.id) {
        case 'token_count': return { ...base, passed: false, score: 0.5, detail: 'token 计数疑似使用 OpenAI 分词器，与厂商官方不符' };
        case 'knowledge': return { ...base, passed: true, score: 0.5, detail: '身份自述正确，但知识细节有偏差' };
        case 'reasoning': return { ...base, passed: false, score: 0.5, detail: '确定性推理题答错约一半，疑似降智' };
        default: return { ...base, passed: true, detail: `${c.name}检查通过` };
      }
    }
    return { ...base, passed: true, detail: `${c.name}检查通过` };
  });
}

const VERDICT_OF: Record<CheckClass, { score: () => number | null; verdict: TrustVerdict }> = {
  genuine: { score: () => randInt(90, 100), verdict: 'genuine' },
  downgraded: { score: () => randInt(50, 70), verdict: 'suspect' },
  fake: { score: () => randInt(10, 35), verdict: 'fake' },
  dead: { score: () => null, verdict: 'unknown' },
};

// ---------- 主流程 ----------
const { db, sql } = createDb(process.env.DATABASE_URL, { max: 4 });
const summary: [string, number][] = [];

try {
  // 1. 清空业务表（CASCADE 覆盖 channel_stats / site_stats 等子表）
  await sql.unsafe(
    `TRUNCATE users, vendors, models, sites, channels, channel_models, probe_runs, probe_tasks,
     authenticity_reports, reviews, favorites, feedback, notifications, announcements, settings,
     audit_logs, verify_requests RESTART IDENTITY CASCADE`,
  );

  // 2. 账号
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@2api.hub';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'admin123456';
  const [admin, merchant, normalUser] = await db.insert(users).values([
    { email: adminEmail, passwordHash: bcrypt.hashSync(adminPassword, 10), nickname: '平台管理员', role: 'admin' as const },
    { email: 'merchant@2api.hub', passwordHash: bcrypt.hashSync('merchant123456', 10), nickname: '演示站长', role: 'merchant' as const },
    { email: 'user@2api.hub', passwordHash: bcrypt.hashSync('user123456', 10), nickname: '演示用户', role: 'user' as const },
  ]).returning();
  summary.push(['users', 3]);

  // 3. 厂商
  const vendorRows = await db.insert(vendors).values(
    SEED_VENDORS.map((v) => ({
      slug: v.slug, name: v.name, nameZh: v.nameZh, color: v.color, website: v.website, sortOrder: v.sortOrder,
    })),
  ).returning();
  const vendorIdBySlug = new Map(vendorRows.map((v) => [v.slug, v.id]));
  summary.push(['vendors', vendorRows.length]);

  // 4. 模型目录
  const modelRows = await db.insert(models).values(
    SEED_MODELS.map((m) => ({
      slug: m.slug,
      displayName: m.displayName,
      vendorId: vendorIdBySlug.get(m.vendor)!,
      family: m.family,
      modality: m.modality,
      tier: m.tier,
      aliases: m.aliases,
      defaultProtocol: m.defaultProtocol,
      officialInputPrice: m.input,
      officialOutputPrice: m.output,
      contextWindow: m.contextWindow,
      knowledgeCutoff: m.knowledgeCutoff,
      expectedTps: m.expectedTps,
      isFeatured: m.featured,
    })),
  ).returning();
  // alias（小写）→ 目录模型 id
  const modelIdByAlias = new Map<string, number>();
  for (const m of SEED_MODELS) {
    const id = modelRows.find((r) => r.slug === m.slug)!.id;
    for (const a of m.aliases) modelIdByAlias.set(a.toLowerCase(), id);
  }
  const modelsByVendor = new Map<string, typeof SEED_MODELS>();
  for (const m of SEED_MODELS) {
    const list = modelsByVendor.get(m.vendor) ?? [];
    list.push(m);
    modelsByVendor.set(m.vendor, list);
  }
  summary.push(['models', modelRows.length]);

  // 5. 系统设置（key 冲突时 update）
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.insert(settings).values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
  }
  summary.push(['settings', Object.keys(DEFAULT_SETTINGS).length]);

  // 6. 站点
  const siteRows = await db.insert(sites).values(
    SITE_DEFS.map((s, i) => ({
      ownerId: s.pending ? normalUser!.id : merchant!.id,
      slug: s.slug,
      name: s.name,
      homepageUrl: `https://www.${s.domain}`,
      inviteUrl: `https://www.${s.domain}/register?aff=2apihub`,
      description: s.description,
      type: s.type,
      rechargeRatio: s.rechargeRatio,
      contact: s.contact,
      tags: s.tags,
      paymentMethods: s.paymentMethods,
      status: (s.pending ? 'pending' : 'approved') as 'pending' | 'approved',
      submittedAt: daysAgo(s.pending ? randInt(1, 2) : randInt(20, 35)),
      approvedAt: s.pending ? null : daysAgo(randInt(10, 18)),
      reviewedBy: s.pending ? null : admin!.id,
      isVerified: s.verified ?? false,
      isFeatured: s.featured ?? false,
      sortWeight: s.sortWeight ?? 0,
      clickCount: s.pending ? 0 : randInt(50, 3000),
      createdAt: daysAgo(s.pending ? randInt(1, 3) : randInt(30, 60) + i * 0),
    })),
  ).returning();
  summary.push(['sites', siteRows.length]);

  // 7. 渠道 + 渠道模型
  interface SeededChannel {
    id: number; def: ChannelDef; rechargeRatio: number;
    primaryModel: string; cmIds: { id: number; upstreamName: string }[];
    lastOkLatency: number | null;
  }
  const seededChannels: SeededChannel[] = [];
  let cmCount = 0;
  for (const def of CHANNEL_DEFS) {
    const site = siteRows[def.site]!;
    const pool = modelsByVendor.get(def.vendor) ?? [];
    // 每渠道 2–6 个模型：优先同厂商，缺别名变体补足（如 google 只有一个模型）
    const upstreamNames: { name: string; modelId: number | null }[] = [];
    for (const m of pool.slice(0, randInt(2, Math.min(4, pool.length)))) {
      upstreamNames.push({ name: m.aliases[0]!, modelId: modelIdByAlias.get(m.aliases[0]!.toLowerCase()) ?? null });
    }
    if (upstreamNames.length < 2 && pool.length > 0) {
      const m = pool[0]!;
      for (const alias of m.aliases.slice(1)) {
        if (upstreamNames.length >= 2) break;
        upstreamNames.push({ name: alias, modelId: modelIdByAlias.get(alias.toLowerCase()) ?? null });
      }
    }
    const primaryModel = upstreamNames[0]!.name;
    const apiKeyPlain = `sk-demo-${randomToken()}`;
    const actual = actualRatio(def.groupRatio, site.rechargeRatio);
    const [ch] = await db.insert(channels).values({
      siteId: site.id,
      name: def.name,
      description: `${site.name} 的 ${def.name} 分组（实际倍率 ${actual}）`,
      vendorId: vendorIdBySlug.get(def.vendor) ?? null,
      protocol: def.protocol,
      baseUrl: `http://127.0.0.1:8712/${def.scenario}`,
      apiKeyEnc: encryptSecret(apiKeyPlain),
      apiKeyMask: maskSecret(apiKeyPlain),
      groupRatio: def.groupRatio,
      primaryModel,
      backupModel: upstreamNames[1]?.name ?? null,
      status: 'active' as const,
      lastTestOk: def.scenario !== 'dead',
      lastTestAt: daysAgo(rand(0, 1)),
      clickCount: randInt(10, 800),
      createdAt: site.createdAt,
    }).returning();

    const cmRows = await db.insert(channelModels).values(
      upstreamNames.map((u, idx) => ({
        channelId: ch!.id,
        upstreamName: u.name,
        modelId: u.modelId,
        priceOverrideInput: idx === 0 && def.priceOverride ? def.priceOverride.input : null,
        priceOverrideOutput: idx === 0 && def.priceOverride ? def.priceOverride.output : null,
      })),
    ).returning();
    cmCount += cmRows.length;
    seededChannels.push({
      id: ch!.id, def, rechargeRatio: site.rechargeRatio, primaryModel,
      cmIds: cmRows.map((r) => ({ id: r.id, upstreamName: r.upstreamName })),
      lastOkLatency: null,
    });
  }
  summary.push(['channels', seededChannels.length]);
  summary.push(['channel_models', cmCount]);

  // 8. 过去 7 天 probe_runs（每渠道每 10 分钟一条，批量插入）
  const SAMPLES = 7 * 24 * 6; // 1008
  const startMs = Date.now() - 7 * 86400_000;
  let runCount = 0;
  for (const sc of seededChannels) {
    const prof = SCENARIO_PROFILES[sc.def.scenario];
    const rows: (typeof probeRuns.$inferInsert)[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const createdAt = new Date(startMs + i * 600_000);
      const success = chance(prof.successRate);
      if (success) {
        const latency = randInt(prof.latency![0], prof.latency![1]);
        const outputTokens = randInt(5, 30);
        rows.push({
          channelId: sc.id,
          model: sc.primaryModel,
          protocol: sc.def.protocol,
          kind: 'availability' as const,
          trigger: 'schedule' as const,
          success: true,
          httpStatus: 200,
          latencyMs: latency,
          ttftMs: prof.ttft(latency),
          inputTokens: randInt(10, 20),
          outputTokens,
          tokensPerSec: Math.round((outputTokens / latency) * 1000 * 10) / 10,
          createdAt,
        });
        sc.lastOkLatency = latency;
      } else {
        rows.push({
          channelId: sc.id,
          model: sc.primaryModel,
          protocol: sc.def.protocol,
          kind: 'availability' as const,
          trigger: 'schedule' as const,
          success: false,
          httpStatus: prof.failStatus,
          errorCode: prof.failCode,
          errorMessage: prof.failMsg,
          latencyMs: sc.def.scenario === 'dead' ? null : randInt(100, 2000),
          createdAt,
        });
      }
    }
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(probeRuns).values(rows.slice(i, i + 500));
    }
    runCount += rows.length;
  }
  summary.push(['probe_runs', runCount]);

  // 9. authenticity_reports + 回写 channel_models
  let reportCount = 0;
  for (const sc of seededChannels) {
    const cls = checkClassOf(sc.def.scenario);
    const meta = VERDICT_OF[cls];
    const reportN = randInt(1, 3);
    let latest: { score: number | null; verdict: TrustVerdict; at: Date } | null = null;
    const primaryCm = sc.cmIds.find((c) => c.upstreamName === sc.primaryModel)!;
    for (let i = 0; i < reportN; i++) {
      const score = meta.score();
      const createdAt = new Date(Date.now() - rand(0, 3) * 86400_000);
      await db.insert(authenticityReports).values({
        channelId: sc.id,
        channelModelId: primaryCm.id,
        model: sc.primaryModel,
        protocol: sc.def.protocol,
        score,
        verdict: meta.verdict,
        checks: buildChecks(cls),
        durationMs: randInt(8000, 45000),
        trigger: (i === 0 ? 'onboarding' : 'schedule') as 'onboarding' | 'schedule',
        createdAt,
      });
      reportCount++;
      if (!latest || createdAt > latest.at) latest = { score, verdict: meta.verdict, at: createdAt };
    }
    // 回写 channel_models
    const testedAt = latest!.at;
    for (const cm of sc.cmIds) {
      let lastStatus: 'pass' | 'fail' = 'pass';
      let lastError: string | null = null;
      if (sc.def.scenario === 'dead') {
        lastStatus = 'fail';
        lastError = '连接失败，上游返回 503';
      } else if (sc.def.scenario === 'flaky' && cm.upstreamName === sc.primaryModel) {
        lastStatus = 'fail';
        lastError = '上游不稳定，间歇性 502';
      }
      await db.update(channelModels).set({
        lastStatus,
        lastError,
        lastLatencyMs: lastStatus === 'pass' ? sc.lastOkLatency : null,
        lastTestedAt: testedAt,
        trustScore: latest!.score,
        trustVerdict: latest!.verdict,
        trustCheckedAt: testedAt,
      }).where(eq(channelModels.id, cm.id));
    }
  }
  summary.push(['authenticity_reports', reportCount]);

  // 10. 评价（演示用户评价已上线站点）
  const approvedSites = siteRows.filter((_, i) => !SITE_DEFS[i]!.pending);
  const REVIEW_DEFS: { siteIdx: number; rating: number; content: string }[] = [
    { siteIdx: 0, rating: 5, content: '用了半年多，Claude 官转很稳，客服响应也快，充值到账秒到。' },
    { siteIdx: 1, rating: 4, content: '价格确实便宜，镜像线路偶尔抖动，但日常写代码够用。' },
    { siteIdx: 3, rating: 5, content: 'Claude Code 专线体验很好，thinking 块完整，确认是真模型。' },
    { siteIdx: 4, rating: 3, content: '白菜价是真的，但 GPT 那条线检测显示降智，复杂任务别用。' },
    { siteIdx: 6, rating: 4, content: '速度快，晚高峰也没明显掉速，就是倍率不算最低。' },
    { siteIdx: 8, rating: 3, content: '超低价那条 Claude 线被平台鉴定为疑似假模型，大家擦亮眼睛，DeepSeek 直连还行。' },
  ];
  await db.insert(reviews).values(
    REVIEW_DEFS.map((r) => ({
      siteId: approvedSites[r.siteIdx]!.id,
      userId: normalUser!.id,
      rating: r.rating,
      content: r.content,
      createdAt: daysAgo(rand(0.5, 6)),
    })),
  );
  summary.push(['reviews', REVIEW_DEFS.length]);

  // 11. 收藏（演示用户收藏 5 个渠道）
  const favoriteChannels = [0, 3, 9, 12, 24].map((i) => seededChannels[i]!).filter(Boolean);
  await db.insert(favorites).values(
    favoriteChannels.map((c) => ({ userId: normalUser!.id, channelId: c.id, createdAt: daysAgo(rand(0.5, 5)) })),
  );
  summary.push(['favorites', favoriteChannels.length]);

  // 12. 反馈
  await db.insert(feedback).values([
    {
      userId: normalUser!.id,
      type: 'recommend_site' as const,
      siteName: '旋风API',
      siteUrl: 'https://www.xuanfengapi.com',
      contact: '@xuanfeng_api',
      content: '推荐收录旋风API，主营 GPT 和 Gemini，用了两个月很稳定。',
    },
    {
      userId: normalUser!.id,
      type: 'suggestion' as const,
      content: '希望榜单增加按厂商筛选和实际倍率区间过滤，找低价渠道更方便。',
    },
  ]);
  summary.push(['feedback', 2]);

  // 13. 公告
  await db.insert(announcements).values([
    {
      title: '2API Hub 平台正式上线',
      contentMd: '## 欢迎\n\n2API Hub 是 AI 中转站聚合导航平台：按模型/厂商比价、查看可用率与模型真伪可信分。\n\n- 站长可免费入驻，提交渠道后平台自动检测\n- 散户可按实际倍率与推荐分挑选渠道',
      pinned: true,
      createdAt: daysAgo(15),
    },
    {
      title: '模型真伪检测规则说明',
      contentMd: '## 检测项\n\n平台对每个渠道执行 8 项检测：连通性、模型名回显、协议特征、Token 计数一致性、知识与身份、推理能力、能力特征、输出速度。\n\n得分 ≥80 判定为**真模型**，50–79 为**存疑**，<50 为**疑似假模型**。站长可在后台查看完整报告。',
      pinned: false,
      createdAt: daysAgo(10),
    },
  ]);
  summary.push(['announcements', 2]);

  // 汇总
  console.log('[db] 种子数据完成：');
  for (const [table, count] of summary) console.log(`  ${table}: ${count}`);
} finally {
  await sql.end();
}
