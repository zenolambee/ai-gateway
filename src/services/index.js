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

const routingConfig = loadRoutingConfig();
const aliasesConfig = loadAliasesConfig();
const routingRulesConfig = loadRoutingRulesConfig();
const virtualModelsConfig = loadVirtualModelsConfig();

const providerManager = new ProviderManager();
const apiKeyManager = new ApiKeyManager({
  defaultStrategy: routingConfig.keySelectionStrategy || 'round-robin',
});
const httpClient = new HttpClient({ apiKeyManager });
const metricsCollector = new MetricsCollector({ providerManager, apiKeyManager });
const healthMonitor = new ProviderHealthMonitor({ providerManager, httpClient });
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
const rateLimiter = new RateLimiter(loadRateLimitConfig());
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
const apiKeyStore = new ApiKeyStore();
const usageTracker = new UsageTracker();
// Inject the stores into the executor (circular init avoided by late binding).
requestExecutor.usageTracker = usageTracker;
requestExecutor.apiKeyStore = apiKeyStore;
requestExecutor.rateLimiter = rateLimiter;
// Inject the apiKeyManager into the router so the rule engine can read per-key health.
modelRouter.setApiKeyManager(apiKeyManager);
requestExecutor.rateLimiter = rateLimiter;

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
const quotaService = new QuotaService(loadQuotaConfig());
const budgetService = new BudgetService(loadBudgetConfig());
const analyticsService = new AnalyticsService({
  usageAccountant,
  metricsCollector,
  alertService,
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
  // Sprint 13
  policyEngine,
  PolicyEngine,
  policySimulator,
  PolicySimulator,
  policyAudit,
  PolicyAuditService,
};
