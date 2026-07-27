const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const AppError = require('../utils/AppError');
const {
  metricsCollector,
  healthMonitor,
  providerManager,
  apiKeyStore,
  apiKeyManager,
  usageTracker,
  modelRegistry,
  requestLog,
  providerConfigManager,
  rateLimiter,
  modelRouter,
  routingStrategy,
  keySelectionStrategy,
  routingConfig,
  aliasResolver,
  ruleEngine,
  discovery,
  virtualModelRegistry,
  virtualModelsConfig,
} = require('../services');
const { SELECTION_STRATEGIES, validateVirtualModelsConfig } = require('../config/virtualModelsConfig');

/**
 * Admin API routes.
 *
 * All routes are mounted under `/admin/api` and require an admin-role API
 * key (checked by the adminAuth middleware in app.js).
 *
 *   GET  /admin/api/overview           — dashboard overview cards
 *   GET  /admin/api/providers          — list all providers
 *   PUT  /admin/api/providers/:id      — update provider config
 *   POST /admin/api/providers/:id/test — test provider connectivity
 *   POST /admin/api/reload             — manual config reload
 *   GET  /admin/api/keys               — list API keys
 *   POST /admin/api/keys               — create API key
 *   DELETE /admin/api/keys/:id         — delete API key
 *   PUT  /admin/api/keys/:id           — update key (enable/disable/expire)
 *   GET  /admin/api/keys/:id/usage     — per-key usage stats
 *   GET  /admin/api/models             — model registry
 *   GET  /admin/api/monitoring         — metrics + charts data
 *   GET  /admin/api/logs               — request log (filterable)
 *   GET  /admin/api/health             — provider health overview
 *   GET  /admin/api/config             — current configuration
 *   PUT  /admin/api/config             — live edit configuration
 *   GET  /admin/api/virtual-models      — list virtual models (Sprint 11)
 *   GET  /admin/api/virtual-models/:id  — single virtual model
 *   POST /admin/api/virtual-models      — create virtual model
 *   PUT  /admin/api/virtual-models/:id  — update virtual model (replace)
 *   DELETE /admin/api/virtual-models/:id — delete virtual model
 *   PUT  /admin/api/virtual-models/:id/toggle — enable/disable
 *   PUT  /admin/api/virtual-models      — bulk replace + persist
 */

// --- Overview ---
router.get('/overview', (req, res) => {
  const snap = metricsCollector.getSnapshot();
  const health = healthMonitor.getAllHealth();
  const healthyCount = Object.values(health).filter((h) => h.online).length;
  const rlStats = rateLimiter.getStats();

  res.json({
    requests: snap.global.totalRequests,
    successfulRequests: snap.global.successfulRequests,
    failedRequests: snap.global.failedRequests,
    tokens: snap.global.totalTokens,
    promptTokens: snap.global.promptTokens,
    completionTokens: snap.global.completionTokens,
    cost: snap.global.totalCost,
    activeProviders: snap.activeProviders,
    disabledProviders: snap.disabledProviders,
    healthyProviders: healthyCount,
    activeApiKeys: snap.activeApiKeys,
    rateLimitRejections: snap.global.rateLimitRejections,
    averageLatencyMs: snap.global.averageLatencyMs,
    p50LatencyMs: snap.global.p50LatencyMs,
    p95LatencyMs: snap.global.p95LatencyMs,
    p99LatencyMs: snap.global.p99LatencyMs,
    retryCount: snap.global.retryCount,
    fallbackCount: snap.global.fallbackCount,
    uptimeMs: snap.uptimeMs,
    configReloadCount: snap.configReloadCount,
    configReloadFailures: snap.configReloadFailures,
    rateLimitEnabled: rlStats.enabled,
  });
});

// --- Providers ---
router.get('/providers', (req, res) => {
  const providers = providerManager.listProviders();
  const health = healthMonitor.getAllHealth();
  res.json({
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      baseURL: p.baseURL,
      supportedModels: p.supportedModels,
      priority: p.priority,
      timeout: p.timeout,
      weight: p.weight || 1,
      adapter: p.adapter || 'generic-openai',
      retryPolicy: p.retryPolicy || null,
      fallbackPolicy: p.fallbackPolicy !== undefined ? p.fallbackPolicy : true,
      apiKeys: (p.apiKeys || []).map((k) => k ? `${k.slice(0, 4)}...${k.slice(-4)}` : ''),
      health: health[p.id] || null,
    })),
  });
});

// Update provider config (live edit)
router.put('/providers/:id', (req, res, next) => {
  try {
    const id = req.params.id;
    const existing = providerManager.providersById.get(id);
    if (!existing) {
      throw new AppError(`Provider "${id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }

    // Merge the update into the existing config
    const updated = {
      ...existing,
      ...req.body,
      id, // prevent id change
    };

    // Build the full provider list with the updated entry
    const allProviders = providerManager.listProviders().map((p) => {
      if (p.id === id) return updated;
      return p;
    });

    const result = providerManager.updateProviders(allProviders);
    if (!result.success) {
      throw new AppError(`Validation failed: ${result.errors.join('; ')}`, 400, {
        code: 'INVALID_REQUEST', errors: result.errors,
      });
    }

    // Run the reload cascade
    providerConfigManager._runReloadCascade(result.providers);

    res.json({ success: true, provider: updated });
  } catch (err) {
    next(err);
  }
});

// Test provider connectivity
router.post('/providers/:id/test', async (req, res, next) => {
  try {
    const id = req.params.id;
    const provider = providerManager.providersById.get(id);
    if (!provider) {
      throw new AppError(`Provider "${id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }

    const { httpClient } = require('../services');
    const start = Date.now();
    try {
      await httpClient.sendRequest(provider, '/models', { method: 'GET', timeout: 5000 });
      res.json({
        providerId: id,
        success: true,
        latencyMs: Date.now() - start,
      });
    } catch (err) {
      res.json({
        providerId: id,
        success: false,
        error: err.message,
        code: err.info && err.info.code,
        latencyMs: Date.now() - start,
      });
    }
  } catch (err) {
    next(err);
  }
});

// Manual reload
router.post('/reload', async (req, res, next) => {
  try {
    const result = await providerConfigManager.reload();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- API Keys ---
router.get('/keys', (req, res) => {
  const keys = apiKeyStore.listKeys();
  const usage = usageTracker.getAllUsage();
  const usageById = new Map(usage.map((u) => [u.keyId, u]));
  res.json({
    keys: keys.map((k) => ({
      ...k,
      usage: usageById.get(k.id) || null,
    })),
  });
});

router.post('/keys', (req, res, next) => {
  try {
    const { key, name, role, allowedProviders, allowedModels, expiresAt } = req.body;
    if (!key || typeof key !== 'string') {
      throw new AppError('A "key" string is required', 400, { code: 'INVALID_REQUEST' });
    }

    // Build the full key list with the new entry
    const newEntry = {
      id: key,
      key,
      name: name || `key-${Date.now()}`,
      status: 'active',
      role: role === 'admin' ? 'admin' : 'user',
      allowedProviders: Array.isArray(allowedProviders) ? allowedProviders : undefined,
      allowedModels: Array.isArray(allowedModels) ? allowedModels : undefined,
      expiresAt: typeof expiresAt === 'number' ? expiresAt : undefined,
      createdAt: Math.floor(Date.now() / 1000),
    };

    // Add to the store
    apiKeyStore.keys.push(newEntry);
    apiKeyStore.keysByKey.set(newEntry.key, newEntry);

    res.json({ success: true, key: apiKeyStore._publicView(newEntry) });
  } catch (err) {
    next(err);
  }
});

router.delete('/keys/:id', (req, res, next) => {
  try {
    const id = req.params.id;
    const idx = apiKeyStore.keys.findIndex((k) => k.id === id);
    if (idx < 0) {
      throw new AppError(`Key "${id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    apiKeyStore.keys.splice(idx, 1);
    const keyToRemove = apiKeyStore.keys.find((k) => k.id === id);
    if (keyToRemove) {
      apiKeyStore.keysByKey.delete(keyToRemove.key);
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.put('/keys/:id', (req, res, next) => {
  try {
    const id = req.params.id;
    const keyRecord = apiKeyStore.keys.find((k) => k.id === id);
    if (!keyRecord) {
      throw new AppError(`Key "${id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }

    if (req.body.status !== undefined) keyRecord.status = req.body.status;
    if (req.body.role !== undefined) keyRecord.role = req.body.role;
    if (req.body.expiresAt !== undefined) keyRecord.expiresAt = req.body.expiresAt;
    if (req.body.allowedProviders !== undefined) keyRecord.allowedProviders = req.body.allowedProviders;
    if (req.body.allowedModels !== undefined) keyRecord.allowedModels = req.body.allowedModels;
    if (req.body.name !== undefined) keyRecord.name = req.body.name;

    res.json({ success: true, key: apiKeyStore._publicView(keyRecord) });
  } catch (err) {
    next(err);
  }
});

router.get('/keys/:id/usage', (req, res, next) => {
  try {
    const usage = usageTracker.getUsage(req.params.id);
    res.json({ keyId: req.params.id, usage: usage || null });
  } catch (err) {
    next(err);
  }
});

// --- Model Registry (rich — Sprint 10) ---
// The /admin/api/models endpoint now returns the full rich model records
// (aliases, capabilities, health, latency, success rate, priority,
// context length, endpoint). The simpler shape is still available via
// GET /v1/models (public, OpenAI-compatible).
router.get('/models', async (req, res, next) => {
  try {
    const entries = await modelRegistry.getRichEntries();
    res.json({ models: entries });
  } catch (err) { next(err); }
});

// --- Monitoring ---
router.get('/monitoring', (req, res) => {
  const snap = metricsCollector.getSnapshot();
  res.json(snap);
});

// --- Logs ---
router.get('/logs', (req, res) => {
  const { providerId, apiKeyId, model, status, limit, since } = req.query;
  const lim = limit ? parseInt(limit, 10) : 100;
  if (since !== undefined) {
    const entries = requestLog.getSince(parseInt(since, 10), lim);
    res.json({ entries, offset: requestLog.getOffset() });
    return;
  }
  const filters = {};
  if (providerId) filters.providerId = providerId;
  if (apiKeyId) filters.apiKeyId = apiKeyId;
  if (model) filters.model = model;
  if (status) filters.status = parseInt(status, 10);
  const entries = requestLog.getFiltered(filters, lim);
  res.json({ entries, offset: requestLog.getOffset() });
});

// --- Health ---
router.get('/health', (req, res) => {
  res.json({ providers: healthMonitor.getAllHealth() });
});

// --- Configuration ---
router.get('/config', (req, res) => {
  const providers = providerManager.listProviders();
  res.json({
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      baseURL: p.baseURL,
      apiKeys: (p.apiKeys || []).map((k) => k ? `${k.slice(0, 4)}...${k.slice(-4)}` : ''),
      supportedModels: p.supportedModels,
      priority: p.priority,
      timeout: p.timeout,
      weight: p.weight || 1,
      adapter: p.adapter || 'generic-openai',
      retryPolicy: p.retryPolicy || null,
      fallbackPolicy: p.fallbackPolicy !== undefined ? p.fallbackPolicy : true,
      headers: p.headers || {},
    })),
    reloadStats: providerConfigManager.getReloadStats(),
  });
});

// --- System info (version, memory, process) ---
router.get('/system', (req, res) => {
  const config = require('../config');
  const mem = process.memoryUsage();
  res.json({
    version: config.version || '1.0.0',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptimeMs: process.uptime() * 1000,
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    },
    timestamp: Date.now(),
  });
});

// Live edit: write provider configs to disk + reload
router.put('/config', async (req, res, next) => {
  try {
    const { providers } = req.body;
    if (!Array.isArray(providers)) {
      throw new AppError('"providers" must be an array', 400, { code: 'INVALID_REQUEST' });
    }

    // Write each provider to its own file in the config dir
    const dir = providerManager._configDir
      || process.env.PROVIDERS_CONFIG_DIR
      || path.join(process.cwd(), 'config', 'providers');

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Clear existing .json files
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      fs.unlinkSync(path.join(dir, f));
    }

    // Write new configs
    for (const p of providers) {
      const filename = `${p.id}.json`;
      const filepath = path.join(dir, filename);
      // Don't write masked keys back — write the full config
      const toWrite = { ...p };
      delete toWrite.health;
      fs.writeFileSync(filepath, JSON.stringify(toWrite, null, 2));
    }

    // Reload from disk
    const result = await providerConfigManager.reload();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// Routing Strategy (Sprint 9)
// ---------------------------------------------------------------

/**
 * GET /admin/api/routing
 *
 * Returns the current routing strategy, the list of available strategies,
 * the per-provider key selection strategies, and the key selection strategy
 * options.
 */
router.get('/routing', (req, res) => {
  res.json({
    strategy: modelRouter.getStrategy(),
    keySelectionStrategy: routingConfig.keySelectionStrategy || 'round-robin',
    availableStrategies: routingStrategy.listStrategies(),
    availableKeySelectionStrategies: keySelectionStrategy.listStrategies(),
    providers: providerManager.listProviders().map((p) => ({
      id: p.id,
      keySelectionStrategy: apiKeyManager.getStrategy(p.id),
    })),
  });
});

/**
 * PUT /admin/api/routing
 *
 * Update the routing strategy at runtime (no restart). The body should
 * contain { strategy: string } and/or { keySelectionStrategy: string }.
 * The routing strategy applies globally; the key selection strategy
 * applies per-provider via the provider config or can be set globally
 * here as the default for all providers.
 *
 * This does NOT write to config/routing.json — changes are in-memory and
 * revert on restart. To persist, edit config/routing.json (hot-reloaded).
 */
router.put('/routing', (req, res, next) => {
  try {
    if (req.body.strategy !== undefined) {
      const id = req.body.strategy;
      const available = routingStrategy.listStrategies();
      if (!available.includes(id)) {
        throw new AppError(`Unknown routing strategy "${id}". Available: ${available.join(', ')}`, 400, {
          code: 'INVALID_REQUEST', available,
        });
      }
      modelRouter.setStrategy(id);
    }
    if (req.body.keySelectionStrategy !== undefined) {
      const id = req.body.keySelectionStrategy;
      const available = keySelectionStrategy.listStrategies();
      if (!available.includes(id)) {
        throw new AppError(`Unknown key selection strategy "${id}". Available: ${available.join(', ')}`, 400, {
          code: 'INVALID_REQUEST', available,
        });
      }
      // Set as default for providers that don't override it.
      apiKeyManager.defaultStrategy = id;
      // Also apply to all providers currently using the previous default.
      for (const p of providerManager.listProviders()) {
        // Only override if the provider didn't have an explicit strategy
        // in its config (detected by matching the previous default).
        // We can't know the original config value here, so we set it
        // unconditionally — the admin API is an explicit override.
        apiKeyManager.setStrategy(p.id, id);
      }
    }
    if (req.body.providerKeySelectionStrategy !== undefined) {
      // Per-provider override: { providerId: strategyId, ... }
      const overrides = req.body.providerKeySelectionStrategy;
      if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
        for (const [providerId, stratId] of Object.entries(overrides)) {
          apiKeyManager.setStrategy(providerId, stratId);
        }
      }
    }
    res.json({
      success: true,
      strategy: modelRouter.getStrategy(),
      keySelectionStrategy: apiKeyManager.defaultStrategy,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// Provider Key Health (Sprint 9)
// ---------------------------------------------------------------

/**
 * GET /admin/api/providers/:id/keys
 *
 * Returns per-key health for a provider: status, priority, weight,
 * success rate, error rate, average latency, request count, token usage,
 * last success/failure, cooldown status.
 */
router.get('/providers/:id/keys', (req, res, next) => {
  try {
    const id = req.params.id;
    const provider = providerManager.providersById.get(id);
    if (!provider) {
      throw new AppError(`Provider "${id}" not found`, 404, { code: 'PROVIDER_NOT_FOUND' });
    }
    const keys = apiKeyManager.getKeyHealth(id);
    res.json({ providerId: id, keys });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/api/providers/:id/keys/:key/disable
 * POST /admin/api/providers/:id/keys/:key/enable
 *
 * Manually disable/enable a specific provider API key. The :key param is
 * the masked key value from the keys list — but for safety we accept the
 * raw key value. (Admin-only, so this is acceptable.)
 */
router.post('/providers/:id/keys/:action(enable|disable)', (req, res, next) => {
  try {
    const id = req.params.id;
    const action = req.params.action;
    const key = req.body && req.body.key;
    if (!key) {
      throw new AppError('"key" is required in the body', 400, { code: 'INVALID_REQUEST' });
    }
    const ok = action === 'disable'
      ? apiKeyManager.disableKey(id, key)
      : apiKeyManager.enableKey(id, key);
    if (!ok) {
      throw new AppError(`Key not found for provider "${id}"`, 404, { code: 'PROVIDER_NOT_FOUND' });
    }
    res.json({ success: true, providerId: id, action });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// Model Registry — Rich Model Records (Sprint 10)
// (The GET /admin/api/models endpoint is defined above with getRichEntries.)
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// Aliases (Sprint 10)
// ---------------------------------------------------------------

/**
 * GET /admin/api/aliases
 *
 * Returns all configured model aliases and the canonical model ids they
 * map to.
 */
router.get('/aliases', (req, res) => {
  res.json({ aliases: aliasResolver.listAliases() });
});

/**
 * PUT /admin/api/aliases
 *
 * Add or update an alias at runtime. Body: { alias: string, models: string[] }
 * Does NOT persist to disk — use config/aliases.json for persistence (hot-reloaded).
 */
router.put('/aliases', (req, res, next) => {
  try {
    const { alias, models } = req.body;
    if (!alias || typeof alias !== 'string') {
      throw new AppError('"alias" is required', 400, { code: 'INVALID_REQUEST' });
    }
    if (!Array.isArray(models) || models.length === 0) {
      throw new AppError('"models" must be a non-empty array', 400, { code: 'INVALID_REQUEST' });
    }
    aliasResolver.setAlias(alias, models);
    modelRegistry.invalidate();
    res.json({ success: true, alias, models });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /admin/api/aliases/:alias
 *
 * Remove an alias at runtime.
 */
router.delete('/aliases/:alias', (req, res, next) => {
  try {
    const removed = aliasResolver.removeAlias(req.params.alias);
    if (!removed) {
      throw new AppError(`Alias "${req.params.alias}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    modelRegistry.invalidate();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// Routing Rules (Sprint 10)
// ---------------------------------------------------------------

/**
 * GET /admin/api/routing-rules
 *
 * Returns all configured routing rules.
 */
router.get('/routing-rules', (req, res) => {
  res.json({ rules: ruleEngine.listRules() });
});

/**
 * PUT /admin/api/routing-rules
 *
 * Add or update a routing rule. Body: { id, description?, when, then }
 */
router.put('/routing-rules', (req, res, next) => {
  try {
    const ok = ruleEngine.setRule(req.body);
    if (!ok) {
      throw new AppError('Invalid rule (requires id, when, then)', 400, { code: 'INVALID_REQUEST' });
    }
    res.json({ success: true, rule: req.body });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /admin/api/routing-rules/:id
 *
 * Remove a routing rule.
 */
router.delete('/routing-rules/:id', (req, res, next) => {
  try {
    const removed = ruleEngine.removeRule(req.params.id);
    if (!removed) {
      throw new AppError(`Rule "${req.params.id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// Per-Model Provider Order (Sprint 10)
// ---------------------------------------------------------------

/**
 * GET /admin/api/model-routing
 *
 * Returns the per-model routing overrides (provider order + strategy).
 */
router.get('/model-routing', (req, res) => {
  res.json({ overrides: modelRouter.getModelOverrides() });
});

/**
 * PUT /admin/api/model-routing
 *
 * Set per-model routing overrides. Body: { overrides: { [model]: { strategy?, providerOrder? } } }
 * Example: { overrides: { "gpt-5": { providerOrder: ["openai", "openrouter", "providerX"] } } }
 */
router.put('/model-routing', (req, res, next) => {
  try {
    const { overrides } = req.body;
    if (!overrides || typeof overrides !== 'object') {
      throw new AppError('"overrides" object is required', 400, { code: 'INVALID_REQUEST' });
    }
    modelRouter.setModelOverrides(overrides);
    res.json({ success: true, overrides: modelRouter.getModelOverrides() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// Provider Discovery (Sprint 10)
// ---------------------------------------------------------------

/**
 * POST /admin/api/discover
 *
 * Trigger provider discovery: query each enabled provider's /models and
 * merge the discovered models into the registry. Returns the discovery
 * status per provider.
 */
router.post('/discover', async (req, res, next) => {
  try {
    const result = await discovery.discover();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/api/refresh-models
 *
 * Invalidate the model registry cache so the next request triggers a
 * fresh aggregation. Equivalent to a manual refresh of the model list.
 */
router.post('/refresh-models', (req, res, next) => {
  try {
    modelRegistry.invalidate();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/api/refresh-capabilities
 *
 * Re-detect capabilities for all models and refresh the registry. This
 * runs discovery + cache invalidation so capabilities are re-read from
 * the adapters.
 */
router.post('/refresh-capabilities', async (req, res, next) => {
  try {
    await discovery.discover();
    modelRegistry.invalidate();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/api/discovery-status
 *
 * Returns the last discovery result (which providers were queried, how
 * many models were found, errors).
 */
router.get('/discovery-status', (req, res) => {
  res.json({ status: discovery.getStatus() });
});

// ---------------------------------------------------------------
// Virtual Models (Sprint 11)
// ---------------------------------------------------------------

/**
 * Persist the current in-memory virtual model set to disk and reload so the
 * on-disk config stays consistent with the running registry. Shared by the
 * single-resource POST/PUT/DELETE/toggle handlers so partial edits also get
 * saved — without requiring the admin to send the full set each time.
 *
 * Returns the save result (success/errors/warnings/count). When persistence
 * is not desired (e.g. tests), `opts.persist` may be set to false.
 * @private
 */
function persistVirtualModels(opts = {}) {
  if (opts.persist === false) return { success: true, errors: [], warnings: [], count: 0 };
  // Rebuild the full config from the registry so persistence reflects the
  // exact runtime state (including candidate priorities/weights/enabled).
  const virtualModels = {};
  for (const vm of virtualModelRegistry.listVirtualModels()) {
    virtualModels[vm.id] = {
      enabled: vm.enabled,
      strategy: vm.strategy,
      candidates: vm.candidates.map((c) => ({
        provider: c.provider,
        model: c.model,
        priority: c.priority,
        weight: c.weight,
        enabled: c.enabled,
      })),
    };
  }
  return providerConfigManager.saveVirtualModels({ virtualModels });
}

/**
 * GET /admin/api/virtual-models
 *
 * List all configured virtual models with their candidate providers and
 * per-virtual-model metrics. Includes the list of selection strategies the
 * client may assign (so the dashboard can populate its dropdown).
 */
router.get('/virtual-models', (req, res) => {
  res.json({
    virtualModels: virtualModelRegistry.listVirtualModels(),
    strategies: SELECTION_STRATEGIES,
    metrics: (metricsCollector.getSnapshot().virtualModels) || {},
  });
});

/**
 * GET /admin/api/virtual-models/:id
 *
 * Retrieve a single virtual model.
 */
router.get('/virtual-models/:id', (req, res, next) => {
  const vm = virtualModelRegistry.getVirtualModel(req.params.id);
  if (!vm) {
    return next(new AppError(`Virtual model "${req.params.id}" not found`, 404, { code: 'MODEL_NOT_FOUND' }));
  }
  res.json({ virtualModel: vm });
});

/**
 * POST /admin/api/virtual-models
 *
 * Create a virtual model. Body:
 *   { id, enabled?, strategy?, candidates: [{provider, model, priority?, weight?, enabled?}, ...] }
 * Validates before registering. When persist is true (default), the updated
 * full set is written to config/virtualModels.json (hot-reloaded elsewhere).
 */
router.post('/virtual-models', (req, res, next) => {
  try {
    const { id, enabled, strategy, candidates } = req.body || {};
    if (!id || typeof id !== 'string') {
      throw new AppError('"id" is required', 400, { code: 'INVALID_REQUEST' });
    }
    if (virtualModelRegistry.isVirtualModel(id) || virtualModelRegistry.getVirtualModel(id)) {
      throw new AppError(`Virtual model "${id}" already exists — use PUT to update`, 409, { code: 'CONFLICT' });
    }
    const meta = {};
    const ok = virtualModelRegistry.setVirtualModel(id, { enabled, strategy, candidates }, meta);
    if (!ok) {
      throw new AppError(
        (meta.errors && meta.errors.length) ? meta.errors.join('; ') : 'Invalid virtual model',
        400, { code: 'INVALID_REQUEST' }
      );
    }
    modelRegistry.invalidate();
    const persist = persistVirtualModels({ persist: req.body.persist !== undefined ? req.body.persist : true });
    if (!persist.success) {
      // In-memory change succeeded, but persistence failed — warn but keep
      // the runtime change (it will be lost on restart; the dashboard shows
      // a toast).
      res.status(201).json({
        success: true,
        virtualModel: virtualModelRegistry.getVirtualModel(id),
        persistWarnings: persist.errors,
      });
      return;
    }
    res.status(201).json({
      success: true,
      virtualModel: virtualModelRegistry.getVirtualModel(id),
      warnings: persist.warnings || [],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /admin/api/virtual-models/:id
 *
 * Replace a virtual model. Body: { enabled?, strategy?, candidates: [...] }
 * (the id comes from the path; the body id, if present, must match).
 */
router.put('/virtual-models/:id', (req, res, next) => {
  try {
    const id = req.params.id;
    if (!virtualModelRegistry.getVirtualModel(id)) {
      return next(new AppError(`Virtual model "${id}" not found`, 404, { code: 'MODEL_NOT_FOUND' }));
    }
    if (req.body && req.body.id && req.body.id !== id) {
      throw new AppError('id in body must match the path id', 400, { code: 'INVALID_REQUEST' });
    }
    const { enabled, strategy, candidates } = req.body || {};
    const meta = {};
    const ok = virtualModelRegistry.setVirtualModel(id, { enabled, strategy, candidates }, meta);
    if (!ok) {
      throw new AppError(
        (meta.errors && meta.errors.length) ? meta.errors.join('; ') : 'Invalid virtual model',
        400, { code: 'INVALID_REQUEST' }
      );
    }
    modelRegistry.invalidate();
    const persist = persistVirtualModels({ persist: req.body && req.body.persist !== undefined ? req.body.persist : true });
    res.json({
      success: true,
      virtualModel: virtualModelRegistry.getVirtualModel(id),
      persistWarnings: persist.success ? null : persist.errors,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /admin/api/virtual-models/:id
 *
 * Remove a virtual model.
 */
router.delete('/virtual-models/:id', (req, res, next) => {
  try {
    const removed = virtualModelRegistry.removeVirtualModel(req.params.id);
    if (!removed) {
      return next(new AppError(`Virtual model "${req.params.id}" not found`, 404, { code: 'MODEL_NOT_FOUND' }));
    }
    modelRegistry.invalidate();
    persistVirtualModels();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /admin/api/virtual-models/:id/toggle
 *
 * Enable or disable a virtual model. Body: { enabled: boolean }
 */
router.put('/virtual-models/:id/toggle', (req, res, next) => {
  try {
    const enabled = req.body && typeof req.body.enabled === 'boolean' ? req.body.enabled : !!(req.body && req.body.enabled);
    const ok = virtualModelRegistry.setEnabled(req.params.id, enabled);
    if (!ok) {
      return next(new AppError(`Virtual model "${req.params.id}" not found`, 404, { code: 'MODEL_NOT_FOUND' }));
    }
    persistVirtualModels();
    res.json({ success: true, id: req.params.id, enabled: virtualModelRegistry.getVirtualModel(req.params.id).enabled });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /admin/api/virtual-models
 *
 * Bulk-replace the entire virtual model set and persist. Body:
 *   { virtualModels: { [id]: { enabled, strategy, candidates } } }
 * This validates the WHOLE set first and only swaps when valid — used by
 * the dashboard's primary virtual-model editor (full edit round-trip).
 */
router.put('/virtual-models', (req, res, next) => {
  try {
    const { virtualModels } = req.body || {};
    const result = providerConfigManager.saveVirtualModels({ virtualModels });
    if (!result.success) {
      throw new AppError(
        'Validation failed: ' + (result.errors || []).join('; '),
        400, { code: 'INVALID_REQUEST', errors: result.errors }
      );
    }
    res.json({
      success: true,
      count: result.count,
      warnings: result.warnings || [],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
