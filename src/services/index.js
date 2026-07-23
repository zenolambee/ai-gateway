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
const { loadRateLimitConfig } = require('../config/rateLimitConfig');
const { loadRoutingConfig } = require('../config/routingConfig');
const { loadAliasesConfig } = require('../config/aliasesConfig');
const { loadRoutingRulesConfig } = require('../config/routingRulesConfig');
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
const modelRouter = new ModelRouter(providerManager, {
  defaultStrategy: routingConfig.strategy || 'priority',
  healthMonitor,
  aliasResolver,
  ruleEngine,
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
const chatCompletionsService = new ChatCompletionsService({ requestExecutor });
const responsesService = new ResponsesService({ requestExecutor });
const embeddingsService = new EmbeddingsService({ requestExecutor });
const imagesService = new ImagesService({ requestExecutor });
const audioService = new AudioService({ requestExecutor });

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
  discovery,
  ProviderDiscovery,
};
