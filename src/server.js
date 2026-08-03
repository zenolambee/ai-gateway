const app = require('./app');
const config = require('./config');
const logger = require('./utils/logger');
const { providerManager, apiKeyManager, adapterRegistry, refreshScheduler, sdkHealthService, sdkModelDiscovery } = require('./services');

// Validate critical environment configuration
if (!config.aiApiKey) {
  console.error('FATAL: AI_API_KEY environment variable is not set. Aborting.');
  process.exit(1);
}

// Load and validate AI provider configurations
providerManager.load();

const allProviders = providerManager.listProviders();
const enabledProviders = providerManager.getEnabledProviders();
const disabledProviders = providerManager.getDisabledProviders();

// Startup validation summary — log every disabled provider with its reason
// so operators can fix configuration issues without reading error logs.
if (disabledProviders.length > 0) {
  logger.warn('Startup validation: some providers were disabled', {
    total: allProviders.length,
    enabled: enabledProviders.length,
    disabled: disabledProviders.length,
    disabledProviders: disabledProviders.map((d) => ({
      id: d.provider.id,
      reason: d.reason,
    })),
  });
}

// Load API keys for every provider into the ApiKeyManager
apiKeyManager.load(allProviders);

// Reset the adapter cache so any changed provider config (e.g. an `adapter`
// field) is picked up immediately after a reload.
adapterRegistry.reset();

logger.info('Loaded AI providers', {
  total: allProviders.length,
  enabled: enabledProviders.map((p) => ({
    id: p.id,
    name: p.name,
    models: p.supportedModels,
    priority: p.priority,
    keys: p.apiKeys.length,
    adapter: p.adapter || p.id,
  })),
  disabled: disabledProviders.map((d) => ({
    id: d.provider.id,
    reason: d.reason,
  })),
});

const server = app.listen(config.port, () => {
  console.log(`AI Gateway running on port ${config.port}`);
  // Start the background refresh scheduler for OAuth tokens.
  if (refreshScheduler) {
    refreshScheduler.start();
  }
  // Start SDK health scheduling + initial dynamic model discovery.
  if (sdkHealthService) {
    sdkHealthService.start();
  }
  if (sdkModelDiscovery) {
    sdkModelDiscovery.discover({ force: false }).catch(() => {});
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
