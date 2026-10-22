/*
 * API 契约类型（docs/SPEC.md §7）。前后端必须使用这些类型。
 * 修改本文件需经编排者同意。
 */

// ---------- enums ----------
export type Role = 'user' | 'merchant' | 'admin';
export type UserStatus = 'active' | 'banned';
export type SiteType = 'new_api' | 'sub2api' | 'one_api' | 'custom';
export type SiteStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'suspended';
export type ChannelProtocol = 'openai_chat' | 'openai_responses' | 'anthropic' | 'gemini';
export type ChannelStatus = 'active' | 'paused' | 'invalid';
export type BillingType = 'per_token' | 'per_request' | 'subscription';
export type ModelModality = 'text' | 'image' | 'video' | 'audio' | 'embedding';
export type ModelTier = 'flagship' | 'standard' | 'lite';
export type TestStatus = 'pass' | 'fail' | 'untested';
export type TrustVerdict = 'genuine' | 'suspect' | 'fake' | 'unknown';
export type ProbeKind = 'availability' | 'authenticity' | 'discovery';
export type ProbeTrigger = 'schedule' | 'merchant' | 'admin' | 'onboarding' | 'public';
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';
export type FeedbackType = 'recommend_site' | 'suggestion' | 'complaint' | 'bug';
export type FeedbackStatus = 'new' | 'read' | 'handled';
export type ReviewStatus = 'visible' | 'hidden';
export type ProbeErrorCode =
  | 'timeout' | 'network' | 'dns' | 'tls'
  | 'http_401' | 'http_403' | 'http_404' | 'http_429' | 'http_4xx' | 'http_5xx'
  | 'empty_response' | 'invalid_response' | 'ssrf_blocked';

export type ChannelSort = 'recommend' | 'price' | 'ratio' | 'uptime' | 'latency' | 'trust' | 'updated';
export type HistoryWindow = '1h' | '24h' | '7d' | '30d';

// ---------- common ----------
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface VendorRef {
  slug: string;
  name: string;
  nameZh: string | null;
  color: string;
  iconUrl: string | null;
}

// ---------- auth ----------
export interface SessionUser {
  id: string;
  email: string;
  nickname: string;
  avatarUrl: string | null;
  role: Role;
  createdAt: string;
}
export interface RegisterInput { email: string; password: string; nickname?: string }
export interface LoginInput { email: string; password: string }

// ---------- catalog ----------
export interface VendorSummary extends VendorRef {
  id: number;
  modelCount: number;
  channelCount: number;
}
export interface VendorDetail extends VendorSummary {
  website: string | null;
  description: string | null;
  models: ModelSummary[];
}

export interface ModelSummary {
  id: number;
  slug: string;
  displayName: string;
  vendor: VendorRef;
  family: string | null;
  modality: ModelModality;
  tier: ModelTier;
  officialInputPrice: number | null;   // $/M
  officialOutputPrice: number | null;  // $/M
  contextWindow: number | null;
  isFeatured: boolean;
  channelCount: number;                // 已上线且声明该模型的渠道数
  minInputPriceCny: number | null;     // ¥/M，所有渠道中最低输入价
  bestUptime24h: number | null;        // 0-1
}
export interface ModelDetail extends ModelSummary {
  aliases: string[];
  defaultProtocol: ChannelProtocol;
  knowledgeCutoff: string | null;
  releasedAt: string | null;
  description: string | null;
  expectedTps: number | null;
}

// ---------- stats ----------
export interface SparkPoint { t: string; ok: boolean; ms: number | null }

export interface ChannelStatsView {
  uptime1h: number | null;
  uptime24h: number | null;
  uptime7d: number | null;
  samples24h: number;
  latencyP50: number | null;   // ms
  latencyP95: number | null;   // ms
  ttftAvg: number | null;      // ms
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastProbeAt: string | null;
  trustScore: number | null;
  trustVerdict: TrustVerdict;
  recommendScore: number | null;
  sparkline: SparkPoint[];     // 最近 60 次
}

// ---------- channels (public) ----------
export interface SiteRef {
  id: number;
  slug: string;
  name: string;
  logoUrl: string | null;
  homepageUrl: string;
  type: SiteType;
  isVerified: boolean;
}

export interface ChannelModelBrief {
  upstreamName: string;
  modelSlug: string | null;
  displayName: string | null;
  vendorSlug: string | null;
  lastStatus: TestStatus;
  trustScore: number | null;
  trustVerdict: TrustVerdict;
}

export interface ChannelPrice {
  modelSlug: string;
  upstreamName: string;
  inputCny: number | null;   // ¥/M
  outputCny: number | null;  // ¥/M
  isOverride: boolean;       // 是否为站长手填价
}

/** 列表中可信分悬浮卡片使用的检测摘要（不含说明文字，完整报告见渠道详情） */
export interface TrustCheckBrief {
  id: AuthenticityCheckId;
  passed: boolean | null;      // null = 未执行/未计分
  score?: number;              // 0-1 部分得分（如推理题 2/3）
}
export interface TrustReportBrief {
  id: number;
  model: string;               // 检测的上游模型名（主测模型）
  score: number | null;
  verdict: TrustVerdict;
  checkedAt: string;
  checks: TrustCheckBrief[];
}

export interface ChannelListItem {
  id: number;
  rank: number;                  // 当前排序下的名次（从 1 开始，跨分页连续）
  name: string;
  description: string | null;
  protocol: ChannelProtocol;
  billingType: BillingType;
  status: ChannelStatus;
  site: SiteRef;
  vendor: VendorRef | null;
  groupRatio: number;
  rechargeRatio: number;
  actualRatio: number;
  price: ChannelPrice | null;    // 请求带 model 时返回该模型价格；否则为主测模型价格（可空）
  modelCount: number;
  models: ChannelModelBrief[];
  stats: ChannelStatsView;
  trustReport: TrustReportBrief | null; // 主测模型最近一次真伪检测摘要（与 stats.trustScore 同源）
  isFavorite: boolean;           // 未登录恒为 false
}

export interface ChannelModelView extends ChannelModelBrief {
  id: number;
  lastLatencyMs: number | null;
  lastTestedAt: string | null;
  lastError: string | null;
  inputPriceCny: number | null;
  outputPriceCny: number | null;
}

export interface ChannelDetail extends Omit<ChannelListItem, 'models'> {
  primaryModel: string;
  backupModel: string | null;
  models: ChannelModelView[];
  latestReport: AuthenticityReport | null;
  createdAt: string;
}

export interface ChannelHistoryPoint {
  t: string;                 // 桶起始时间
  total: number;
  ok: number;
  latencyP50: number | null;
  ttftAvg: number | null;
}
export interface ChannelHistory {
  window: HistoryWindow;
  bucketSec: number;         // 1h→60, 24h→1800, 7d→10800, 30d→43200
  points: ChannelHistoryPoint[];
  recentRuns: ProbeRun[];    // 最近 50 条（公开接口中 errorMessage 做脱敏）
}

export interface ChannelQuery {
  model?: string;
  vendor?: string;
  q?: string;
  siteId?: number;
  maxRatio?: number;
  minUptime?: number;
  minTrust?: number;
  stableOnly?: boolean;
  protocol?: ChannelProtocol;
  sort?: ChannelSort;
  order?: 'asc' | 'desc';
  ids?: number[];
  page?: number;
  pageSize?: number;
}

// ---------- authenticity ----------
export type AuthenticityCheckId =
  | 'connectivity' | 'model_echo' | 'response_shape' | 'token_count'
  | 'knowledge' | 'reasoning' | 'capability' | 'speed';

export interface AuthenticityCheck {
  id: AuthenticityCheckId;
  name: string;                // 中文名
  passed: boolean | null;      // null = 不适用/未执行
  weight: number;
  score?: number;              // 0-1 部分得分（如推理题 2/3）
  detail: string;              // 中文说明
  evidence?: Record<string, unknown>;
}

export interface AuthenticityReport {
  id: number | null;           // 公开鉴定工具结果为 null
  channelId: number | null;
  model: string;
  protocol: ChannelProtocol;
  score: number | null;
  verdict: TrustVerdict;
  checks: AuthenticityCheck[];
  durationMs: number;
  trigger: ProbeTrigger;
  createdAt: string;
}

export interface VerifyRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: ChannelProtocol;
}

// ---------- probe ----------
export interface ProbeResult {
  success: boolean;
  model: string;
  protocol: ChannelProtocol;
  httpStatus: number | null;
  errorCode: ProbeErrorCode | null;
  errorMessage: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensPerSec: number | null;
  sample: string | null;       // 回复前 200 字符
  at: string;
}

export interface ProbeRun {
  id: number;
  channelId: number;
  model: string;
  protocol: ChannelProtocol;
  kind: ProbeKind;
  trigger: ProbeTrigger;
  success: boolean;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
  outputTokens: number | null;
  tokensPerSec: number | null;
  createdAt: string;
}

export interface ProbeTaskPayload {
  models?: string[];           // 真伪检测的上游模型名；为空则检测主测模型
}

export interface ProbeTask {
  id: number;
  channelId: number;
  kind: ProbeKind;
  trigger: ProbeTrigger;
  status: TaskStatus;
  payload: ProbeTaskPayload;
  result: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ---------- sites (public) ----------
export interface SiteStatsView {
  channelCount: number;
  modelCount: number;
  avgUptime24h: number | null;
  bestRecommendScore: number | null;
  minActualRatio: number | null;
  vendorSlugs: string[];
  reviewCount: number;
  avgRating: number | null;
}

export interface SiteContact {
  qq?: string;
  wechat?: string;
  telegram?: string;
  email?: string;
  group?: string;
}

export interface SiteListItem {
  id: number;
  slug: string;
  name: string;
  logoUrl: string | null;
  homepageUrl: string;
  type: SiteType;
  description: string | null;
  tags: string[];
  isVerified: boolean;
  isFeatured: boolean;
  stats: SiteStatsView;
  createdAt: string;
}

export interface SiteDetail extends SiteListItem {
  contact: SiteContact;
  paymentMethods: string[];
  rechargeRatio: number;
  approvedAt: string | null;
  channels: ChannelListItem[];
  ratingSummary: { avg: number | null; count: number; distribution: Record<'1' | '2' | '3' | '4' | '5', number> };
}

export interface Review {
  id: number;
  rating: number;
  content: string;
  user: { nickname: string; avatarUrl: string | null };
  createdAt: string;
  updatedAt: string;
}
export interface ReviewInput { rating: number; content: string }

/** GET /me/reviews：当前用户自己的评价（含所属站点与审核状态） */
export interface MyReview extends Review {
  status: ReviewStatus;
  site: { id: number; slug: string; name: string };
}

// ---------- home ----------
export interface RankingOverview {
  updatedAt: string | null;
  models: { model: ModelSummary; top: ChannelListItem[] }[];
}

export interface MetaResponse {
  vendors: VendorSummary[];
  featuredModels: ModelSummary[];
  counts: { sites: number; channels: number; models: number; probes24h: number };
  lastProbeAt: string | null;
}

export interface Announcement {
  id: number;
  title: string;
  contentMd: string;
  pinned: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface FeedbackInput {
  type: FeedbackType;
  siteName?: string;
  siteUrl?: string;
  contact?: string;
  content: string;
}

export interface Notification {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/** GET /me/notifications：分页 + 未读数 */
export interface NotificationList extends Paginated<Notification> {
  unreadCount: number;
}

// ---------- merchant ----------
export interface SiteInput {
  name: string;
  slug?: string;               // 不填则由名称生成
  homepageUrl: string;
  inviteUrl?: string | null;
  logoUrl?: string | null;
  description?: string | null;
  type: SiteType;
  rechargeRatio: number;
  contact?: SiteContact;
  tags?: string[];
  paymentMethods?: string[];
}

export interface MerchantSite {
  id: number;
  slug: string;
  name: string;
  homepageUrl: string;
  inviteUrl: string | null;
  logoUrl: string | null;
  description: string | null;
  type: SiteType;
  rechargeRatio: number;
  contact: SiteContact;
  tags: string[];
  paymentMethods: string[];
  status: SiteStatus;
  reviewNote: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  isVerified: boolean;
  isFeatured: boolean;
  channelCount: number;
  stats: SiteStatsView | null;
  createdAt: string;
  updatedAt: string;
}

export interface MerchantChannelModel {
  id: number;
  upstreamName: string;
  modelSlug: string | null;
  displayName: string | null;
  priceOverrideInput: number | null;
  priceOverrideOutput: number | null;
  lastStatus: TestStatus;
  lastLatencyMs: number | null;
  lastTestedAt: string | null;
  lastError: string | null;
  trustScore: number | null;
  trustVerdict: TrustVerdict;
}

export interface MerchantChannel {
  id: number;
  siteId: number;
  name: string;
  description: string | null;
  vendor: VendorRef | null;
  protocol: ChannelProtocol;
  baseUrl: string;
  apiKeyMask: string;
  groupRatio: number;
  actualRatio: number;
  billingType: BillingType;
  primaryModel: string;
  backupModel: string | null;
  rpmLimit: number | null;
  status: ChannelStatus;
  probeEnabled: boolean;
  probeIntervalSec: number;
  lastTestOk: boolean | null;
  lastTestAt: string | null;
  models: MerchantChannelModel[];
  stats: ChannelStatsView | null;
  latestReport: AuthenticityReport | null;
  createdAt: string;
  updatedAt: string;
}

export interface MerchantSiteDetail extends MerchantSite {
  channels: MerchantChannel[];
}

export interface ChannelInput {
  name: string;
  description?: string | null;
  vendorSlug?: string | null;
  protocol: ChannelProtocol;
  baseUrl: string;
  apiKey?: string;             // 新建必填；更新时留空表示不修改
  groupRatio: number;
  billingType?: BillingType;
  primaryModel: string;
  backupModel?: string | null;
  rpmLimit?: number | null;
  declaredModels?: string[];   // 上游模型名列表，自动映射目录
}

export interface ChannelModelsInput {
  models: {
    upstreamName: string;
    modelSlug?: string | null;
    priceOverrideInput?: number | null;
    priceOverrideOutput?: number | null;
  }[];
}

export interface MerchantAlert {
  channelId: number;
  channelName: string;
  siteName: string;
  type: 'down' | 'degraded' | 'invalid' | 'trust_low';
  message: string;
  at: string;
}

export interface MerchantOverview {
  siteCount: number;
  approvedSiteCount: number;
  pendingSiteCount: number;
  channelCount: number;
  activeChannelCount: number;
  avgUptime24h: number | null;
  alerts: MerchantAlert[];
  channels: {
    id: number;
    name: string;
    siteId: number;
    siteName: string;
    status: ChannelStatus;
    stats: ChannelStatsView | null;
  }[];
}

// ---------- admin ----------
export interface AdminOverview {
  pendingSites: number;
  sites: { total: number; approved: number; suspended: number };
  channels: { total: number; active: number; invalid: number };
  users: { total: number; merchants: number };
  probes24h: { total: number; failed: number };
  queue: { queued: number; running: number };
  recentFailures: (ProbeRun & { siteName: string; channelName: string })[];
}

export interface AdminSite extends MerchantSite {
  owner: { id: string; email: string; nickname: string };
  sortWeight: number;
  clickCount: number;
}

export interface AdminSiteDetail extends AdminSite {
  channels: MerchantChannel[];
  reports: AuthenticityReport[];
}

/** GET /admin/channels 返回 Paginated<AdminChannel> */
export interface AdminChannel extends MerchantChannel {
  site: { id: number; slug: string; name: string; status: SiteStatus };
}

export interface SiteReviewAction {
  action: 'approve' | 'reject' | 'suspend' | 'restore';
  reason?: string;
}

export interface AdminUser {
  id: string;
  email: string;
  nickname: string;
  role: Role;
  status: UserStatus;
  siteCount: number;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface VendorInput {
  slug: string;
  name: string;
  nameZh?: string | null;
  color?: string;
  iconUrl?: string | null;
  website?: string | null;
  description?: string | null;
  sortOrder?: number;
}

export interface ModelInput {
  slug: string;
  displayName: string;
  vendorSlug: string;
  family?: string | null;
  modality?: ModelModality;
  tier?: ModelTier;
  aliases?: string[];
  defaultProtocol?: ChannelProtocol;
  officialInputPrice?: number | null;
  officialOutputPrice?: number | null;
  contextWindow?: number | null;
  knowledgeCutoff?: string | null;
  expectedTps?: number | null;
  releasedAt?: string | null;
  description?: string | null;
  isFeatured?: boolean;
  sortOrder?: number;
  isActive?: boolean;
}

/** GET /admin/vendors 返回 AdminVendor[] */
export interface AdminVendor extends VendorSummary {
  website: string | null;
  description: string | null;
  sortOrder: number;
}

export interface AdminModel extends ModelDetail {
  isActive: boolean;
  sortOrder: number;
}

export interface FeedbackItem {
  id: number;
  type: FeedbackType;
  siteName: string | null;
  siteUrl: string | null;
  contact: string | null;
  content: string;
  status: FeedbackStatus;
  user: { id: string; email: string; nickname: string } | null;
  createdAt: string;
}

export interface AdminReview extends Review {
  status: ReviewStatus;
  site: { id: number; slug: string; name: string };
}

export interface AuditLog {
  id: number;
  actor: { id: string; email: string; nickname: string } | null;
  action: string;
  targetType: string;
  targetId: string;
  meta: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export interface ScoringWeights { uptime: number; latency: number; trust: number; stability: number }

export interface SettingsMap {
  'probe.defaultIntervalSec': number;
  'probe.concurrency': number;
  'probe.perSiteConcurrency': number;
  'probe.timeoutMs': number;
  'authenticity.intervalHours': number;
  'authenticity.merchantDailyLimit': number;
  'scoring.weights': ScoringWeights;
  'verify.hourlyLimitPerIp': number;
  'site.allowRegistration': boolean;
  'site.announcementBar': string;
}
