const ProviderManager = require('./providerManager');
const HttpClient = require('./httpClient');
const ModelRouter = require('./modelRouter');
const ApiKeyManager = require('./apiKeyManager');
const RequestExecutor = require('./requestExecutor');
const ModelRegistry = require('./modelRegistry');
const ApiKeyStore = require('./apiKeyStore');
const UsageTracker = require('./usageTracker');
const MetricsCollector = require('./metricsCollector');
const ProviderHealthMonitor = require('./providerHealthMonitor');
const RateLimiter = require('./rateLimiter');
const ProviderConfigManager = require('./providerConfigManager');
const RequestLog = require('./requestLog');
const keySelectionStrategy = require('./keySelectionStrategy');
const routingStrategy = require('./routingStrategy');
const ModelAliasResolver = require('./modelAliasResolver');
const RoutingRuleEngine = require('./routingRuleEngine');
const ProviderDiscovery = require('./providerDiscovery');
const VirtualModelRegistry = require('./virtualModelRegistry');
// Sprint 12 — cost & quota & budget & analytics services.
const PricingService = require('./pricingService');
const BudgetService = require('./budgetService');
const QuotaService = require('./quotaService');
const AlertService = require('./alertService');
const UsageAccountant = require('./usageAccountant');
const AnalyticsService = require('./analyticsService');
// Sprint 13 — Enterprise Policy Engine.
const PolicyEngine = require('./policyEngine');
const PolicySimulator = require('./policySimulator');
const PolicyAuditService = require('./policyAuditService');
const { loadRateLimitConfig } = require('../config/rateLimitConfig');
const { loadRoutingConfig } = require('../config/routingConfig');
const { loadAliasesConfig } = require('../config/aliasesConfig');
const { loadRoutingRulesConfig } = require('../config/routingRulesConfig');
const { loadVirtualModelsConfig } = require('../config/virtualModelsConfig');
const { loadPricingConfig } = require('../config/pricingConfig');
const { loadBudgetConfig } = require('../config/budgetConfig');
const { loadQuotaConfig } = require('../config/quotaConfig');
const { loadPolicyConfig } = require('../config/policyConfig');
const { ChatCompletionsService } = require('./chatCompletionsService');
const { ResponsesService } = require('./responsesService');
const { EmbeddingsService } = require('./embeddingsService');
const { ImagesService } = require('./imagesService');
const { AudioService } = require('./audioService');
const ProviderAdapterRegistry = require('../providers/providerAdapterRegistry');
const aiService = require('./aiService');
const { createStorage } = require('../storage');
const MemoryStorage = require('../storage/MemoryStorage');
const DataStore = require('../storage/DataStore');
const { AuthAdapterFactory, ConnectionRegistry } = require('../auth');
const logger = require('../utils/logger');

// Storage backend — initialized BEFORE services so constructors can use it.
// Default is MemoryStorage (always works). Redis is attempted asynchronously
// and upgrades storageBackend when successful.
let storageBackend = null;
let storageType = 'memory';
try {
  const ms = new MemoryStorage({ prefix: process.env.REDIS_PREFIX || 'ai_gateway' });
  storageBackend = ms;
  storageType = 'memory';
} catch (err) {
  logger.warn('Failed to create default MemoryStorage', { error: err.message });
}

// Async Redis connection attempt — replaces storageBackend when successful.
if ((process.env.STORAGE_PROVIDER || 'memory').toLowerCase() === 'redis' && process.env.REDIS_URL) {
  createStorage({
    provider: 'redis',
    redisUrl: process.env.REDIS_URL,
    prefix: process.env.REDIS_PREFIX || 'ai_gateway',
    connectTimeoutMs: 3000,
    maxRetries: 1,
  }).then((result) => {
    if (result.type === 'redis') {
      storageBackend = result.storage;
      storageType = 'redis';
      logger.info('Storage: upgraded to Redis', { prefix: process.env.REDIS_PREFIX || 'ai_gateway' });
    }
  }).catch((err) => {
    logger.warn('Storage: Redis not available, staying on MemoryStorage', { error: err.message });
  });
}

const routingConfig = loadRoutingConfig();
const aliasesConfig = loadAliasesConfig();
const routingRulesConfig = loadRoutingRulesConfig();
const virtualModelsConfig = loadVirtualModelsConfig();

const providerManager = new ProviderManager();
const apiKeyManager = new ApiKeyManager({
  defaultStrategy: routingConfig.keySelectionStrategy || 'round-robin',
  storageProvider: storageBackend,
});
const httpClient = new HttpClient({ apiKeyManager });

const metricsCollector = new MetricsCollector({
  providerManager,
  apiKeyManager,
  storageProvider: storageBackend,
});
const healthMonitor = new ProviderHealthMonitor({
  providerManager,
  httpClient,
  storageProvider: storageBackend,
});
const aliasResolver = new ModelAliasResolver();
aliasResolver.load(aliasesConfig);
const ruleEngine = new RoutingRuleEngine();
ruleEngine.load(routingRulesConfig.rules);
// Virtual model registry (Sprint 11). Loaded from config/virtualModels.json.
// When the file is absent or empty the registry is empty — clients using real
// model ids are unaffected (backward compatible). Built AFTER the provider
// manager so candidate filtering can reference enabled providers, and BEFORE
// the model router so the router can take it as a dependency.
const virtualModelRegistry = new VirtualModelRegistry({
  providerManager,
  healthMonitor,
  apiKeyManager,
});
virtualModelRegistry.load(virtualModelsConfig);
const modelRouter = new ModelRouter(providerManager, {
  defaultStrategy: routingConfig.strategy || 'priority',
  healthMonitor,
  aliasResolver,
  ruleEngine,
  virtualModelRegistry,
});
modelRouter.setStrategy(routingConfig.strategy || 'priority');
const adapterRegistry = new ProviderAdapterRegistry();
const rateLimiter = new RateLimiter(loadRateLimitConfig(), {
  storageProvider: storageBackend,
});
const requestLog = new RequestLog();
const requestExecutor = new RequestExecutor({
  modelRouter, httpClient, adapterRegistry,
  usageTracker: null,
  apiKeyStore: null,
  apiKeyManager,
  metricsCollector,
  healthMonitor,
  requestLog,
});
const modelRegistry = new ModelRegistry({
  providerManager, adapterRegistry,
  aliasResolver, healthMonitor,
  virtualModelRegistry,
});
const discovery = new ProviderDiscovery({
  providerManager, httpClient, adapterRegistry, modelRegistry,
});
const apiKeyStore = new ApiKeyStore({
  storageProvider: () => storageBackend,
});
// ---- Provider Adapter SDK (Sprint: Provider Adapter SDK & Built-in Providers)
const { ProviderSDKRegistry, ProviderManifest } = require('../providers/providerSDK');
const providerSDKRegistry = new ProviderSDKRegistry();
providerSDKRegistry.setHttpClient(httpClient);

// Register built-in provider adapters.
const builtinAdapters = [
  require('../providers/providerSDK/adapters/GrokAdapter'),
  require('../providers/providerSDK/adapters/OpenAIAdapter'),
  require('../providers/providerSDK/adapters/ClaudeAdapter'),
  require('../providers/providerSDK/adapters/GeminiAdapter'),
  require('../providers/providerSDK/adapters/CopilotAdapter'),
  require('../providers/providerSDK/adapters/CursorAdapter'),
  require('../providers/providerSDK/adapters/WindsurfAdapter'),
  require('../providers/providerSDK/adapters/KimiAdapter'),
  require('../providers/providerSDK/adapters/QwenAdapter'),
];
for (const Adapter of builtinAdapters) providerSDKRegistry.register(Adapter);

// SDKRoutingBridge: routes providers through SDK adapters (sendRequest) when a
// matching SDK adapter is registered, else falls back to the legacy path.
const { SDKRoutingBridge } = require('../providers/providerSDK');
const sdkRoutingBridge = new SDKRoutingBridge({ sdkRegistry: providerSDKRegistry, httpClient });

// Dynamic Model Discovery (SDK fetchModels-first) + SDK Health Scheduler.
const SDKModelDiscovery = require('./sdkModelDiscovery');
const SDKHealthService = require('./sdkHealthService');
const sdkModelDiscovery = new SDKModelDiscovery({
  providerManager,
  sdkRoutingBridge,
  legacyDiscovery: discovery,
  modelRegistry,
  providerSDKRegistry,
});
const sdkHealthService = new SDKHealthService({
  sdkRoutingBridge,
  providerManager,
  modelRouter,
  legacyDiscovery: discovery,
});
// Publish an initial capability map to the router for capability-aware routing.
sdkHealthService._publishCapabilities();
// ---- Connect Account (Sprint: Dashboard Admin & Connect Account) ----
// Generic auth architecture. The registry owns storage; adapters never touch
// a storage backend. New providers = new adapter (no core change).
const { EncryptionService, ProviderCatalog } = require('../auth');
const encryptionService = new EncryptionService({});
const providerCatalog = new ProviderCatalog();
const authAdapterFactory = new AuthAdapterFactory();
const connectionRegistry = new ConnectionRegistry({
  factory: authAdapterFactory,
  storageProvider: () => storageBackend,
  encryption: encryptionService,
  httpClient: httpClient,
});
connectionRegistry.setProviderCatalog(providerCatalog);
// Wire the token manager and start the background refresh scheduler.
const TokenManager = require('../auth/TokenManager');
const tokenManager = new TokenManager({ registry: connectionRegistry, encryption: encryptionService });
connectionRegistry.setTokenManager(tokenManager);
const RefreshScheduler = require('../auth/RefreshScheduler');
const refreshScheduler = new RefreshScheduler({ registry: connectionRegistry });
connectionRegistry.setScheduler(refreshScheduler);
// The scheduler starts only when the server runs (not in tests) — see server.js.
const AccountManager = require('./accountManager');
const accountManager = new AccountManager({
  registry: connectionRegistry,
  providerManager,
  httpClient,
});
const ConnectionManager = require('./connectionManager');
const connectionManager = new ConnectionManager({
  accountManager,
  registry: connectionRegistry,
  factory: authAdapterFactory,
  providerManager,
});
// Wire selectConnection into the executor for SDK account-level routing.
requestExecutor.connectionManager = connectionManager;
const usageTracker = new UsageTracker({ storageProvider: storageBackend });
// Inject the stores into the executor (circular init avoided by late binding).
requestExecutor.usageTracker = usageTracker;
requestExecutor.apiKeyStore = apiKeyStore;
requestExecutor.rateLimiter = rateLimiter;
 // Inject the apiKeyManager into the router so the rule engine can read per-key health.
modelRouter.setApiKeyManager(apiKeyManager);
requestExecutor.rateLimiter = rateLimiter;
// SDK routing bridge: attach so providers with an SDK adapter route through
// adapter.sendRequest(); providers without one keep the legacy path.
requestExecutor.sdkRouter = sdkRoutingBridge;
modelRouter.sdkRoutingBridge = sdkRoutingBridge;

// ---- Sprint 12 — Quota, Cost, Budget, Alerts, Analytics ----
// Built AFTER the existing services so they can wrap them. Each new service
// composes with the others via setAlertService + late-binding into the
// executor. When their config files are absent or `enabled:false` they all
// no-op — preserving full backward compatibility with existing deployments.
const alertService = new AlertService({
  webhookUrl: process.env.ALERT_WEBHOOK_URL || null,
  adminEmail: process.env.ALERT_ADMIN_EMAIL || null,
});
const pricingService = new PricingService(loadPricingConfig());
const usageAccountant = new UsageAccountant({
  persistencePath: process.env.USAGE_LEDGER_FILE || null,
  persist: process.env.USAGE_LEDGER_FILE != null,
});
const quotaService = new QuotaService(loadQuotaConfig(), { storageProvider: storageBackend });
const budgetService = new BudgetService(loadBudgetConfig(), { storageProvider: storageBackend });
const analyticsService = new AnalyticsService({
  usageAccountant,
  metricsCollector,
  alertService,
});
// Prompt 24 — official read-only usage & quota analytics reporting layer.
// Reuses UsageAccountant rollups + ApiKeyStore quota (single source of truth)
// + Provider/Model registries. No second usage/quota system.
const UsageAnalyticsService = require('./usageAnalyticsService');
const usageAnalyticsService = new UsageAnalyticsService({
  usageAccountant,
  apiKeyStore,
  providerManager,
  modelRegistry,
  pricingService: null, // late-bound below once pricingService exists
});
// Cross-inject alerters so threshold breaches raise alerts.
budgetService.setAlertService(alertService);
quotaService.setAlertService(alertService);
// Late-bind the Sprint 12 hooks into the executor (additive, no ordering
// constraints because the executor's hooks are all defensively wrapped in
// try/catch with `instanceof` null-checks).
requestExecutor.pricingService = pricingService;
requestExecutor.usageAccountant = usageAccountant;
requestExecutor.quotaService = quotaService;
requestExecutor.budgetService = budgetService;
requestExecutor.analyticsService = analyticsService;
// Late-bind pricing into the analytics reporter (cost already baked into
// rollups; this enables future per-report recomputation without a redesign).
usageAnalyticsService.pricingService = pricingService;
const chatCompletionsService = new ChatCompletionsService({ requestExecutor });
const responsesService = new ResponsesService({ requestExecutor });
const embeddingsService = new EmbeddingsService({ requestExecutor });
const imagesService = new ImagesService({ requestExecutor });
const audioService = new AudioService({ requestExecutor });

// ---- Sprint 13 — Enterprise Policy Engine & Intelligent Routing ----
// Built AFTER the routing + cost services so the engine can inject routing
// decisions (force_provider / force_model / select_*), and AFTER the chat
// services so the simulator can project what would have happened without
// running through them. The engine + simulator + audit are all opt-in:
// when policies are absent / `enabled:false` the middleware is a no-op and
// the existing routing path runs untouched (full backward compat).
const policyEngine = new PolicyEngine(loadPolicyConfig());
const policyAudit = new PolicyAuditService({
  persistencePath: process.env.POLICY_AUDIT_FILE || null,
  persist: process.env.POLICY_AUDIT_FILE != null,
});
const policySimulator = new PolicySimulator({
  policyEngine,
  providerManager,
  virtualModelRegistry,
  pricingService,
  apiKeyStore,
  modelRouter,
});
// Late-bind policy hooks into the executor (additive).
requestExecutor.policyEngine = policyEngine;
requestExecutor.policyAudit = policyAudit;
// The model router reads `req.policyRouting` to apply force/select decisions
// post-candidate; expose the engine on the router for that integration.
modelRouter.policyEngine = policyEngine;

// ProviderConfigManager: hot reload of provider configs.
// Created after all dependent services so the reload cascade can reach them.
const providerConfigManager = new ProviderConfigManager({
  providerManager,
  adapterRegistry,
  apiKeyManager,
  modelRegistry,
  healthMonitor,
  metricsCollector,
  modelRouter,
  routingConfig,
  aliasResolver,
  ruleEngine,
  discovery,
  virtualModelRegistry,
});

// ---- Prompt 23 — Backup & Restore ----
// BackupService produces versioned, secret-free snapshots and restores API
// key metadata / quota policies. Built last so it can read from every
// registry/service. When BACKUP_DIR is set it can persist/list backup files.
const BackupService = require('./backupService');
const backupService = new BackupService({
  providerManager,
  apiKeyStore,
  modelRegistry,
  quotaService,
  usageAccountant,
  virtualModelRegistry,
  connectionManager,
}, {
  backupDir: process.env.BACKUP_DIR || null,
  gatewayVersion: process.env.VERSION || '1.0.0',
});

module.exports = {
  providerManager,
  ProviderManager,
  apiKeyManager,
  ApiKeyManager,
  httpClient,
  HttpClient,
  modelRouter,
  ModelRouter,
  requestExecutor,
  RequestExecutor,
  adapterRegistry,
  ProviderAdapterRegistry,
  modelRegistry,
  ModelRegistry,
  apiKeyStore,
  ApiKeyStore,
  usageTracker,
  UsageTracker,
  metricsCollector,
  MetricsCollector,
  healthMonitor,
  ProviderHealthMonitor,
  rateLimiter,
  RateLimiter,
  providerConfigManager,
  ProviderConfigManager,
  requestLog,
  RequestLog,
  chatCompletionsService,
  ChatCompletionsService,
  responsesService,
  ResponsesService,
  embeddingsService,
  EmbeddingsService,
  imagesService,
  ImagesService,
  audioService,
  AudioService,
  aiService,
  keySelectionStrategy,
  routingStrategy,
  routingConfig,
  aliasResolver,
  ModelAliasResolver,
  ruleEngine,
  RoutingRuleEngine,
  virtualModelRegistry,
  VirtualModelRegistry,
  virtualModelsConfig,
  discovery,
  ProviderDiscovery,
  // Sprint 12
  pricingService,
  PricingService,
  budgetService,
  BudgetService,
  quotaService,
  QuotaService,
  alertService,
  AlertService,
  usageAccountant,
  UsageAccountant,
  analyticsService,
  AnalyticsService,
  usageAnalyticsService,
  UsageAnalyticsService: require('./usageAnalyticsService'),
  policyEngine,
  PolicyEngine,
  policySimulator,
  PolicySimulator,
  policyAudit,
  PolicyAuditService,
  // Storage
  storageBackend,
  storageType,
  MemoryStorage: require('../storage/MemoryStorage'),
  RedisStorage: require('../storage/RedisStorage'),
  StorageProvider: require('../storage/StorageProvider'),
  // Provider Adapter SDK
  providerSDKRegistry,
  ProviderSDKRegistry: require('../providers/providerSDK/ProviderSDKRegistry'),
  ProviderAdapterSDK: require('../providers/providerSDK/ProviderAdapterSDK'),
  ProviderManifest: require('../providers/providerSDK/ProviderManifest'),
  sdkRoutingBridge,
  SDKRoutingBridge: require('../providers/providerSDK/SDKRoutingBridge'),
  sdkModelDiscovery,
  SDKModelDiscovery,
  sdkHealthService,
  SDKHealthService,
  // Connect Account
  connectionRegistry,
  ConnectionRegistry,
  authAdapterFactory,
  AuthAdapterFactory,
  AuthAdapter: require('../auth/AuthAdapter'),
  EncryptionService: require('../auth/EncryptionService'),
  TokenManager: require('../auth/TokenManager'),
  RefreshScheduler: require('../auth/RefreshScheduler'),
  ProviderCatalog: require('../auth/ProviderCatalog'),
  refreshScheduler,
  tokenManager,
  encryptionService,
  providerCatalog,
  // Account Manager (Universal Provider Account Manager)
  accountManager,
  AccountManager: require('./accountManager'),
  // Connection Manager (centralized unified service)
  connectionManager,
  ConnectionManager: require('./connectionManager'),
  // Prompt 23 — Backup & Restore + API Key hashing
  backupService,
  BackupService: require('./backupService'),
  ApiKeyHasher: require('./apiKeyHasher'),
};
