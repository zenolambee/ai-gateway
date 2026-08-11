// TypeScript types mirroring the AI Gateway backend response shapes.
// These match the JSON returned by src/routes/admin.js + public routes.
// No `any` is used for backend data.

export type KeyStatus = 'active' | 'inactive' | 'revoked' | 'expired';

export interface QuotaView {
  limit: number | null;
  used: number;
  remaining: number | null;
}

export interface RateLimit {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  [k: string]: number | undefined;
}

export interface ApiKeyUsageCounter {
  keyId?: string;
  totalRequests?: number;
  totalTokens?: number;
  lastUsed?: number | null;
}

export interface ApiKey {
  id: string;
  name: string;
  description?: string;
  status: KeyStatus;
  role: 'admin' | 'user';
  userId?: string;
  expiresAt?: number | null;
  allowedProviders?: string[];
  deniedProviders?: string[];
  allowedModels?: string[];
  deniedModels?: string[];
  permissions?: string[];
  rateLimit?: RateLimit | null;
  quota?: QuotaView;
  metadata?: Record<string, unknown>;
  tags?: string[];
  createdAt?: number;
  updatedAt?: number;
  revokedAt?: number | null;
  lastUsed?: number | null;
  usageCount?: number;
  keyPrefix: string;
  usage?: ApiKeyUsageCounter | null;
}

export interface CreateApiKeyInput {
  name: string;
  allowedProviders?: string[];
  allowedModels?: string[];
  quota?: { limit: number | null; reset?: ResetPeriod };
  rateLimit?: RateLimit;
  expiresAt?: number | null;
}

export interface CreateApiKeyResult {
  success: boolean;
  key: ApiKey;
  // One-time plaintext, only present immediately after creation/rotation.
  apiKey?: string;
}

export type ResetPeriod = 'never' | 'daily' | 'weekly' | 'monthly';

export interface ProviderHealth {
  online?: boolean;
  latencyMs?: number | null;
  lastCheck?: number | null;
  successRate?: number | null;
  circuitState?: string;
}

export interface Provider {
  id: string;
  name: string;
  enabled: boolean;
  baseURL?: string;
  supportedModels?: string[];
  priority?: number;
  timeout?: number;
  weight?: number;
  adapter?: string;
  fallbackPolicy?: boolean;
  // Masked, never a real secret (e.g. "abcd...wxyz").
  apiKeys?: string[];
  health?: ProviderHealth | null;
  // Number of connections (accounts) managed by the ConnectionManager.
  connections?: number;
  // Why the provider is disabled (when known), e.g. "No API keys configured".
  disabledReason?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface CreateProviderInput {
  id: string;
  name: string;
  baseURL: string;
  adapter?: string;
  enabled?: boolean;
  supportedModels: string[];
  // Provider credential (API key). Sent to the backend over the admin
  // channel only; never persisted in the browser. Omitted when the
  // credential is managed exclusively via connections.
  apiKey?: string;
  priority?: number;
  timeout?: number;
}

export interface UpdateProviderInput {
  name?: string;
  baseURL?: string;
  adapter?: string;
  enabled?: boolean;
  supportedModels?: string[];
  apiKeys?: string[];
  priority?: number;
  timeout?: number;
  weight?: number;
}

export interface ProviderDetail {
  provider: Provider;
  connections: Connection[];
  usage: ProviderUsage | null;
}

export interface ModelCapabilities {
  chat?: boolean;
  embeddings?: boolean;
  images?: boolean;
  audio?: boolean;
  tools?: boolean;
  vision?: boolean;
  streaming?: boolean;
  [k: string]: boolean | undefined;
}

export interface ModelEntry {
  id: string;
  object?: string;
  providerIds?: string[];
  provider?: string;
  capabilities?: ModelCapabilities;
  contextLength?: number;
  aliases?: string[];
  health?: ProviderHealth | null;
  priority?: number;
  status?: string;
}

export interface Connection {
  accountId: string;
  id?: string;
  providerId: string;
  name?: string;
  displayName?: string;
  authType?: string;
  status?: string;
  enabled?: boolean;
  online?: boolean;
  lastCheck?: number | null;
  lastUsed?: number | null;
  createdAt?: number;
  connectedAt?: number | null;
  updatedAt?: number | null;
  priority?: number;
  weight?: number;
  // Masked credential preview (e.g. "nva...abcd") — never a real secret.
  apiKey?: string | null;
  // Health metadata from the AccountManager.
  successCount?: number;
  failureCount?: number;
  lastLatencyMs?: number | null;
  lastError?: string | null;
  successRate?: number | null;
}

export interface UsageShape {
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  errorRate: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  streamRequests: number;
  nonStreamRequests: number;
  averageLatencyMs: number;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
  estimatedCost: number | null;
  errorsByCategory: Record<string, number>;
}

export interface UsageSummary extends UsageShape {
  providers: number;
  models: number;
  apiKeys: number;
  entryCount: number;
}

export interface ProviderUsage extends UsageShape {
  providerId: string;
}

export interface ModelUsage extends UsageShape {
  model: string;
  providerId?: string;
}

export interface DailyUsage extends UsageShape {
  date: string;
}

export interface MonthlyUsage extends UsageShape {
  month: string;
}

export interface UsageDetailItem {
  id: string | number;
  apiKeyId: string | null;
  providerId: string | null;
  model: string | null;
  connectionId: string | null;
  operation: string | null;
  status: number;
  errorCategory: string | null;
  stream?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  timestamp?: number;
}

export interface UsageDetailPage {
  page: number;
  limit: number;
  total: number;
  items: UsageDetailItem[];
}

export interface QuotaAnalytics {
  limit: number | null;
  used: number;
  remaining: number | null;
  percentageUsed: number | null;
  percentageRemaining: number | null;
  resetPeriod: ResetPeriod | string;
  resetAt: string | null;
}

export interface Overview {
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  activeProviders: number;
  disabledProviders: number;
  healthyProviders: number;
  activeApiKeys: number;
  rateLimitRejections: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  uptimeMs: number;
  rateLimitEnabled: boolean;
}

export interface BackupIntegrity {
  algorithm: string;
  checksum: string;
}

export interface BackupObject {
  backupVersion: number;
  createdAt?: string | number;
  integrity?: BackupIntegrity;
  checksum?: string;
  data: {
    apiKeys: Array<Record<string, unknown>>;
    providers: Array<Record<string, unknown>>;
    [k: string]: unknown;
  };
}

export interface BackupFileMeta {
  file: string;
  name?: string;
  size?: number;
  createdAt?: string | number;
  backupVersion?: number;
}

export interface BackupValidateResult {
  valid: boolean;
  errors: string[];
  version?: number;
}

export interface RestoreReport {
  ok: boolean;
  success?: boolean;
  dryRun?: boolean;
  applied?: number;
  skipped?: string[];
  warnings?: string[];
  errors?: string[];
  plan?: Record<string, unknown>;
}

export interface SystemInfo {
  version: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  pid: number;
  uptimeMs: number;
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  timestamp: number;
}

export interface HealthResponse {
  providers: Record<string, ProviderHealth>;
}

export interface LogEntry {
  seq?: number;
  requestId?: string;
  timestamp?: number;
  providerId?: string | null;
  apiKeyId?: string | null;
  model?: string | null;
  status?: number;
  event?: string;
  [k: string]: unknown;
}

export interface ApiError {
  message: string;
  type?: string;
  code?: string | null;
  request_id?: string;
}

// ---- Routing Management ----

export type RoutingStrategyId =
  | 'priority'
  | 'round-robin'
  | 'least-used'
  | 'weighted'
  | 'random'
  | 'fastest-response'
  | 'lowest-latency'
  | 'fastest'
  | 'lowest-cost'
  | 'highest-success-rate';

export interface RoutingConfig {
  strategy: RoutingStrategyId;
  connectionStrategy: RoutingStrategyId;
  keySelectionStrategy: string;
  providerStrategies: Record<string, string>;
  availableStrategies: string[];
  availableConnectionStrategies: string[];
  availableKeySelectionStrategies: string[];
  strategyDescriptions: Record<string, string>;
  providers: Array<{
    id: string;
    keySelectionStrategy: string;
    connectionStrategy: string | null;
  }>;
}

export interface RoutingStatus {
  strategy: string;
  connectionStrategy: string;
  keySelectionStrategy: string;
  providers: number;
  activeProviders: number;
  connections: number;
  activeConnections: number;
  disabledConnections: number;
  healthyConnections: number;
  unhealthyConnections: number;
}

export interface RoutingActivityEntry {
  timestamp: number;
  model: string | null;
  providerId: string | null;
  connectionId: string | null;
  connectionName: string | null;
  strategy: string | null;
  latencyMs: number;
  status: number;
}

export interface ModelRoutingRule {
  id: string;
  model: string;
  strategy?: string;
  providerOrder?: string[];
  connectionIds?: string[];
  enabled: boolean;
}
