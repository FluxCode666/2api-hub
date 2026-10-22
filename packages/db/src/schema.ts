import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  AuthenticityCheck,
  ChannelProtocol,
  ProbeTaskPayload,
  SparkPoint,
} from '@hub/shared';

/*
 * 2API Hub 数据库 schema（契约，见 docs/SPEC.md §6）
 * 修改本文件需经编排者同意。
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

// ---------- enums ----------
export const userRole = pgEnum('user_role', ['user', 'merchant', 'admin']);
export const userStatus = pgEnum('user_status', ['active', 'banned']);
export const siteType = pgEnum('site_type', ['new_api', 'sub2api', 'one_api', 'custom']);
export const siteStatus = pgEnum('site_status', ['draft', 'pending', 'approved', 'rejected', 'suspended']);
export const channelProtocol = pgEnum('channel_protocol', ['openai_chat', 'openai_responses', 'anthropic', 'gemini']);
export const channelStatus = pgEnum('channel_status', ['active', 'paused', 'invalid']);
export const billingType = pgEnum('billing_type', ['per_token', 'per_request', 'subscription']);
export const modelModality = pgEnum('model_modality', ['text', 'image', 'video', 'audio', 'embedding']);
export const modelTier = pgEnum('model_tier', ['flagship', 'standard', 'lite']);
export const testStatus = pgEnum('test_status', ['pass', 'fail', 'untested']);
export const trustVerdict = pgEnum('trust_verdict', ['genuine', 'suspect', 'fake', 'unknown']);
export const probeKind = pgEnum('probe_kind', ['availability', 'authenticity', 'discovery']);
export const probeTrigger = pgEnum('probe_trigger', ['schedule', 'merchant', 'admin', 'onboarding', 'public']);
export const taskStatus = pgEnum('task_status', ['queued', 'running', 'done', 'failed', 'canceled']);
export const reviewStatus = pgEnum('review_status', ['visible', 'hidden']);
export const feedbackType = pgEnum('feedback_type', ['recommend_site', 'suggestion', 'complaint', 'bug']);
export const feedbackStatus = pgEnum('feedback_status', ['new', 'read', 'handled']);

// ---------- users ----------
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  nickname: text('nickname').notNull(),
  avatarUrl: text('avatar_url'),
  role: userRole('role').notNull().default('user'),
  status: userStatus('status').notNull().default('active'),
  lastLoginAt: ts('last_login_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('users_email_uq').on(t.email)]);

// ---------- catalog ----------
export const vendors = pgTable('vendors', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),                  // openai / anthropic / google ...
  name: text('name').notNull(),                  // OpenAI
  nameZh: text('name_zh'),                       // 智谱
  color: text('color').notNull().default('#888888'),
  iconUrl: text('icon_url'),
  website: text('website'),
  description: text('description'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('vendors_slug_uq').on(t.slug)]);

export const models = pgTable('models', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),                  // claude-opus-5-5（目录标准 id）
  displayName: text('display_name').notNull(),   // Opus 5.5
  vendorId: integer('vendor_id').notNull().references(() => vendors.id),
  family: text('family'),                        // claude / gpt / gemini ...
  modality: modelModality('modality').notNull().default('text'),
  tier: modelTier('tier').notNull().default('standard'),
  // 上游常见模型名别名，用于把渠道的 upstream 模型名映射到目录（小写比较）
  aliases: text('aliases').array().notNull().default([]),
  defaultProtocol: channelProtocol('default_protocol').notNull().default('openai_chat'),
  // 官方美元单价（每百万 token）
  officialInputPrice: doublePrecision('official_input_price'),
  officialOutputPrice: doublePrecision('official_output_price'),
  contextWindow: integer('context_window'),
  knowledgeCutoff: text('knowledge_cutoff'),     // 'YYYY-MM'
  expectedTps: integer('expected_tps'),          // 期望输出速度 tokens/s（宽松参考）
  releasedAt: text('released_at'),               // 'YYYY-MM-DD'
  description: text('description'),
  isFeatured: boolean('is_featured').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('models_slug_uq').on(t.slug),
  index('models_vendor_idx').on(t.vendorId),
]);

// ---------- sites & channels ----------
export const sites = pgTable('sites', {
  id: serial('id').primaryKey(),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  homepageUrl: text('homepage_url').notNull(),
  inviteUrl: text('invite_url'),                 // 带 aff 的邀请链接，/go 跳转优先使用
  logoUrl: text('logo_url'),
  description: text('description'),
  type: siteType('type').notNull().default('new_api'),
  rechargeRatio: doublePrecision('recharge_ratio').notNull().default(1), // 每 ¥1 获得多少 $ 额度
  contact: jsonb('contact').$type<{ qq?: string; wechat?: string; telegram?: string; email?: string; group?: string }>().notNull().default({}),
  tags: text('tags').array().notNull().default([]),
  paymentMethods: text('payment_methods').array().notNull().default([]), // alipay / wechat / usdt / card
  status: siteStatus('status').notNull().default('draft'),
  reviewNote: text('review_note'),               // 驳回/封禁原因
  submittedAt: ts('submitted_at'),
  approvedAt: ts('approved_at'),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  isVerified: boolean('is_verified').notNull().default(false), // 官方认证标识
  isFeatured: boolean('is_featured').notNull().default(false),
  sortWeight: integer('sort_weight').notNull().default(0),     // 管理员置顶权重
  clickCount: integer('click_count').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('sites_slug_uq').on(t.slug),
  index('sites_owner_idx').on(t.ownerId),
  index('sites_status_idx').on(t.status),
]);

export const channels = pgTable('channels', {
  id: serial('id').primaryKey(),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),                  // 分组名
  description: text('description'),
  vendorId: integer('vendor_id').references(() => vendors.id), // 主平台/品牌
  protocol: channelProtocol('protocol').notNull().default('openai_chat'),
  baseUrl: text('base_url').notNull(),
  apiKeyEnc: text('api_key_enc').notNull(),      // AES-256-GCM 密文
  apiKeyMask: text('api_key_mask').notNull(),    // sk-****abcd
  groupRatio: doublePrecision('group_ratio').notNull().default(1),
  billingType: billingType('billing_type').notNull().default('per_token'),
  primaryModel: text('primary_model').notNull(), // 主测模型（上游模型名）
  backupModel: text('backup_model'),
  rpmLimit: integer('rpm_limit'),
  status: channelStatus('status').notNull().default('active'),
  probeEnabled: boolean('probe_enabled').notNull().default(true),
  probeIntervalSec: integer('probe_interval_sec').notNull().default(600),
  nextProbeAt: ts('next_probe_at').notNull().defaultNow(),
  lastProbeAt: ts('last_probe_at'),
  lastTestOk: boolean('last_test_ok'),            // 最近一次（任意触发）连接测试结果，提交审核时校验
  lastTestAt: ts('last_test_at'),
  sortOrder: integer('sort_order').notNull().default(0),
  clickCount: integer('click_count').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('channels_site_idx').on(t.siteId),
  index('channels_due_idx').on(t.nextProbeAt),
  index('channels_vendor_idx').on(t.vendorId),
]);

export const channelModels = pgTable('channel_models', {
  id: serial('id').primaryKey(),
  channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  upstreamName: text('upstream_name').notNull(), // 站点上的模型名
  modelId: integer('model_id').references(() => models.id), // 映射到目录（可空 = 未识别）
  priceOverrideInput: doublePrecision('price_override_input'),   // ¥/M，站长手填覆盖
  priceOverrideOutput: doublePrecision('price_override_output'),
  lastStatus: testStatus('last_status').notNull().default('untested'),
  lastLatencyMs: integer('last_latency_ms'),
  lastTestedAt: ts('last_tested_at'),
  lastError: text('last_error'),
  trustScore: integer('trust_score'),
  trustVerdict: trustVerdict('trust_verdict').notNull().default('unknown'),
  trustCheckedAt: ts('trust_checked_at'),
  // 以该模型自身可信分计算的推荐分（worker 聚合写入；按模型筛选榜单时使用）
  recommendScore: doublePrecision('recommend_score'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('channel_models_uq').on(t.channelId, t.upstreamName),
  index('channel_models_model_idx').on(t.modelId),
]);

// ---------- probing ----------
export const probeRuns = pgTable('probe_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  channelModelId: integer('channel_model_id').references(() => channelModels.id, { onDelete: 'set null' }),
  model: text('model').notNull(),
  protocol: channelProtocol('protocol').notNull(),
  kind: probeKind('kind').notNull(),
  trigger: probeTrigger('trigger').notNull(),
  success: boolean('success').notNull(),
  httpStatus: integer('http_status'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  latencyMs: integer('latency_ms'),
  ttftMs: integer('ttft_ms'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  tokensPerSec: doublePrecision('tokens_per_sec'),
  createdAt: createdAt(),
}, (t) => [
  index('probe_runs_channel_time_idx').on(t.channelId, t.createdAt),
  index('probe_runs_time_idx').on(t.createdAt),
]);

export const probeTasks = pgTable('probe_tasks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  kind: probeKind('kind').notNull(),
  trigger: probeTrigger('trigger').notNull(),
  payload: jsonb('payload').$type<ProbeTaskPayload>().notNull().default({}),
  status: taskStatus('status').notNull().default('queued'),
  requestedBy: uuid('requested_by').references(() => users.id),
  attempts: integer('attempts').notNull().default(0),
  result: jsonb('result').$type<unknown>(),
  error: text('error'),
  // 任务 lease（审查 #3）：当前持有者实例 id、领取令牌（每次领取新生成）、心跳时间。
  // 副作用写入必须带 lease_token 校验；回收只处理心跳过期的任务。
  lockedBy: text('locked_by'),
  leaseToken: uuid('lease_token'),
  heartbeatAt: ts('heartbeat_at'),
  createdAt: createdAt(),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
}, (t) => [
  index('probe_tasks_status_idx').on(t.status, t.createdAt),
  index('probe_tasks_channel_idx').on(t.channelId),
]);

export const authenticityReports = pgTable('authenticity_reports', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  channelModelId: integer('channel_model_id').references(() => channelModels.id, { onDelete: 'set null' }),
  taskId: integer('task_id'),
  model: text('model').notNull(),
  protocol: channelProtocol('protocol').notNull(),
  score: integer('score'),                        // null = unknown
  verdict: trustVerdict('verdict').notNull(),
  checks: jsonb('checks').$type<AuthenticityCheck[]>().notNull(),
  durationMs: integer('duration_ms'),
  trigger: probeTrigger('trigger').notNull(),
  createdAt: createdAt(),
}, (t) => [index('auth_reports_channel_idx').on(t.channelId, t.createdAt)]);

// ---------- aggregated stats (worker 写，api 读) ----------
export const channelStats = pgTable('channel_stats', {
  channelId: integer('channel_id').primaryKey().references(() => channels.id, { onDelete: 'cascade' }),
  uptime1h: doublePrecision('uptime_1h'),
  uptime24h: doublePrecision('uptime_24h'),
  uptime7d: doublePrecision('uptime_7d'),
  samples24h: integer('samples_24h').notNull().default(0),
  latencyP50_24h: integer('latency_p50_24h'),
  latencyP95_24h: integer('latency_p95_24h'),
  ttftAvg24h: integer('ttft_avg_24h'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastSuccessAt: ts('last_success_at'),
  lastFailureAt: ts('last_failure_at'),
  lastProbeAt: ts('last_probe_at'),
  trustScore: integer('trust_score'),
  trustVerdict: trustVerdict('trust_verdict').notNull().default('unknown'),
  recommendScore: doublePrecision('recommend_score'),
  sparkline: jsonb('sparkline').$type<SparkPoint[]>().notNull().default([]),
  updatedAt: updatedAt(),
});

export const siteStats = pgTable('site_stats', {
  siteId: integer('site_id').primaryKey().references(() => sites.id, { onDelete: 'cascade' }),
  channelCount: integer('channel_count').notNull().default(0),
  modelCount: integer('model_count').notNull().default(0),
  avgUptime24h: doublePrecision('avg_uptime_24h'),
  bestRecommendScore: doublePrecision('best_recommend_score'),
  minActualRatio: doublePrecision('min_actual_ratio'),
  vendorSlugs: text('vendor_slugs').array().notNull().default([]),
  reviewCount: integer('review_count').notNull().default(0),
  avgRating: doublePrecision('avg_rating'),
  updatedAt: updatedAt(),
});

// ---------- community ----------
export const reviews = pgTable('reviews', {
  id: serial('id').primaryKey(),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  rating: integer('rating').notNull(),           // 1-5
  content: text('content').notNull(),
  status: reviewStatus('status').notNull().default('visible'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('reviews_site_user_uq').on(t.siteId, t.userId)]);

export const favorites = pgTable('favorites', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.userId, t.channelId] })]);

export const feedback = pgTable('feedback', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  type: feedbackType('type').notNull(),
  siteName: text('site_name'),
  siteUrl: text('site_url'),
  contact: text('contact'),
  content: text('content').notNull(),
  ipHash: text('ip_hash'),
  status: feedbackStatus('status').notNull().default('new'),
  createdAt: createdAt(),
});

export const notifications = pgTable('notifications', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),                  // site_approved / site_rejected / channel_invalid / channel_recovered / task_done
  title: text('title').notNull(),
  body: text('body'),
  link: text('link'),
  readAt: ts('read_at'),
  createdAt: createdAt(),
}, (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)]);

export const announcements = pgTable('announcements', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  contentMd: text('content_md').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  pinned: boolean('pinned').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------- system ----------
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),                 // 见 @hub/shared SettingsMap
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: updatedAt(),
});

export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),              // site.approve / channel.update / ...
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  ip: text('ip'),
  createdAt: createdAt(),
}, (t) => [index('audit_logs_time_idx').on(t.createdAt)]);

export const verifyRequests = pgTable('verify_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ipHash: text('ip_hash').notNull(),
  host: text('host').notNull(),
  model: text('model').notNull(),
  protocol: channelProtocol('protocol').notNull(),
  score: integer('score'),
  verdict: trustVerdict('verdict').notNull(),
  createdAt: createdAt(),
}, (t) => [index('verify_requests_ip_idx').on(t.ipHash, t.createdAt)]);

export type ChannelProtocolEnum = ChannelProtocol;
