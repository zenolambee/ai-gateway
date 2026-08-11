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
  connectionRegistry,
  authAdapterFactory,
  providerCatalog,
  providerSDKRegistry,
  sdkHealthService,
  sdkModelDiscovery,
  sdkRoutingBridge,
  accountManager,
  connectionManager,
  backupService,
  usageAnalyticsService,
  adapterRegistry: providerAdapterRegistry,
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

// Mask a provider API key (never expose real secrets in admin responses).
function maskProviderKey(k) {
  const v = typeof k === 'string' ? k : (k && typeof k === 'object' ? k.value : '');
  return v ? `${v.slice(0, 4)}...${v.slice(-4)}` : '';
}

// Redacted public view of a provider config (shared by list + detail).
function providerView(p, extra = {}) {
  return {
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
    apiKeys: (p.apiKeys || []).map(maskProviderKey),
    health: extra.health !== undefined ? extra.health : null,
    connections: extra.connections !== undefined ? extra.connections : undefined,
    disabledReason: p.enabled ? null : (providerManager.getDisabledReason(p.id) || 'Disabled in config'),
    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null,
  };
}

// Shared helper: flip a provider's enabled flag, persist to disk, and run
// the reload cascade. Runtime-safe: the ProviderManager performs an atomic
// swap, so in-flight requests finish with the old config while new requests
// immediately see the provider as enabled/disabled. Models, credentials,
// API key permissions and usage history are all preserved untouched.
async function setProviderEnabled(id, enabled) {
  const existing = providerManager.providersById.get(id);
  if (!existing) return null;
  const updated = { ...existing, enabled, updatedAt: Date.now() };
  delete updated.health;
  delete updated.disabledReason;
  delete updated.connections;
  delete updated.usage;
  const allProviders = providerManager.listProviders().map((p) => (p.id === id ? updated : p));
  const result = providerManager.updateProviders(allProviders);
  if (!result.success) {
    throw new AppError(`Validation failed: ${result.errors.join('; ')}`, 400, {
      code: 'INVALID_REQUEST', errors: result.errors,
    });
  }
  providerConfigManager.reloadCascade(result.providers);
  // Persist the new state so it survives restarts (config files remain the
  // source of truth for the provider registry).
  try {
    const dir = providerManager.getConfigDir() || path.join(process.cwd(), 'config', 'providers');
    if (fs.existsSync(dir)) {
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(updated, null, 2));
    }
  } catch (err) {
    require('../utils/logger').warn('Provider state persistence failed (runtime state applied)', {
      providerId: id, error: err && err.message,
    });
  }
  return providerManager.providersById.get(id);
}

router.get('/providers', async (req, res, next) => {
  try {
    const providers = providerManager.listProviders();
    const health = healthMonitor.getAllHealth();
    // Connection counts per provider (ConnectionManager/AccountManager).
    let accounts = [];
    try {
      accounts = connectionManager ? await connectionManager.listConnections() : [];
    } catch (_) { accounts = []; }
    const connCount = {};
    for (const a of accounts || []) {
      const pid = a.providerId || a.provider;
      if (pid) connCount[pid] = (connCount[pid] || 0) + 1;
    }
    res.json({
      providers: providers.map((p) => providerView(p, { health: health[p.id] || null, connections: connCount[p.id] || 0 })),
    });
  } catch (err) {
    next(err);
  }
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
    // Adapter validation when the update changes the adapter — a provider
    // must never point at an unregistered adapter.
    if (req.body && req.body.adapter !== undefined && req.body.adapter !== null && req.body.adapter !== existing.adapter) {
      const known = providerAdapterRegistry ? [...providerAdapterRegistry.adapterClasses.keys()] : [];
      const sdkIds = providerSDKRegistry && typeof providerSDKRegistry.listManifests === 'function'
        ? providerSDKRegistry.listManifests().map((m) => m.id || m.providerId).filter(Boolean)
        : [];
      if (typeof req.body.adapter !== 'string' || !req.body.adapter || (!known.includes(req.body.adapter) && !sdkIds.includes(req.body.adapter))) {
        throw new AppError(
          `Unknown adapter "${req.body.adapter}". Available: ${[...new Set([...known, ...sdkIds])].sort().join(', ')}`,
          400, { code: 'INVALID_REQUEST' }
        );
      }
    }

    const updated = {
      ...existing,
      ...req.body,
      id, // prevent id change
      createdAt: existing.createdAt || req.body.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    delete updated.health;
    delete updated.disabledReason;
    delete updated.connections;
    delete updated.usage;

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

    // Run the reload cascade through the config manager's public API
    providerConfigManager.reloadCascade(result.providers);

    // Persist the update so it survives restarts (best-effort; runtime
    // state is already applied).
    try {
      const dir = providerManager.getConfigDir() || path.join(process.cwd(), 'config', 'providers');
      if (fs.existsSync(dir)) {
        fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(updated, null, 2));
      }
    } catch (err) {
      require('../utils/logger').warn('Provider update persistence failed (runtime state applied)', {
        providerId: id, error: err && err.message,
      });
    }

    res.json({ success: true, provider: providerView(providerManager.providersById.get(id) || updated) });
  } catch (err) {
    next(err);
  }
});

// Enable/disable a provider (runtime-safe). The provider, its models,
// connections, credentials, API key permissions and usage history are all
// preserved — the router simply stops returning it as a candidate because
// ModelRouter only considers `getEnabledProviders()`.
router.post('/providers/:id/enable', async (req, res, next) => {
  try {
    const updated = await setProviderEnabled(req.params.id, true);
    if (!updated) {
      throw new AppError(`Provider "${req.params.id}" not found`, 404, { code: 'PROVIDER_NOT_FOUND' });
    }
    require('../utils/logger').info('PROVIDER_ENABLED', { providerId: req.params.id });
    res.json({ success: true, provider: providerView(updated) });
  } catch (err) {
    next(err);
  }
});

router.post('/providers/:id/disable', async (req, res, next) => {
  try {
    const updated = await setProviderEnabled(req.params.id, false);
    if (!updated) {
      throw new AppError(`Provider "${req.params.id}" not found`, 404, { code: 'PROVIDER_NOT_FOUND' });
    }
    require('../utils/logger').info('PROVIDER_DISABLED', { providerId: req.params.id });
    res.json({ success: true, provider: providerView(updated) });
  } catch (err) {
    next(err);
  }
});

// Registered adapter ids (legacy ProviderAdapterRegistry + SDK manifests).
// NOTE: must be defined BEFORE '/providers/:id' so 'adapters' is not
// captured by the :id param.
router.get('/providers/adapters', (req, res) => {
  const legacy = providerAdapterRegistry ? [...providerAdapterRegistry.adapterClasses.keys()] : [];
  const sdk = providerSDKRegistry && typeof providerSDKRegistry.listManifests === 'function'
    ? providerSDKRegistry.listManifests().map((m) => m.id || m.providerId).filter(Boolean)
    : [];
  res.json({ adapters: [...new Set([...legacy, ...sdk])].sort() });
});

// Single provider detail (with connections, masked credentials, usage).
router.get('/providers/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const p = providerManager.providersById.get(id);
    if (!p) {
      throw new AppError(`Provider "${id}" not found`, 404, { code: 'PROVIDER_NOT_FOUND' });
    }
    const health = healthMonitor.getAllHealth()[id] || null;
    let connections = [];
    try {
      connections = connectionManager ? await connectionManager.listConnections(id) : [];
    } catch (_) { connections = []; }
    res.json({
      provider: providerView(p, { health }),
      connections,
      usage: usageAnalyticsService ? usageAnalyticsService.getProviderUsage().find((u) => u.providerId === id) || null : null,
    });
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

// --- Provider Adapter SDK manifests ---
/**
 * GET /admin/api/providers/sdk/manifests
 *
 * Returns the ProviderManifest for every registered SDK provider. The
 * dashboard uses this to auto-render provider configuration forms without
 * hardcoding provider details. New providers registered via the SDK appear
 * here automatically.
 */
router.get('/providers/sdk/manifests', (req, res) => {
  res.json({ manifests: providerSDKRegistry ? providerSDKRegistry.listManifests() : [] });
});

// Admin endpoint: trigger manual dynamic model discovery (force refresh).
router.post('/providers/sdk/discover', async (req, res, next) => {
  try {
    if (!sdkModelDiscovery) throw new AppError('SDK model discovery not available', 500, { code: 'NOT_AVAILABLE' });
    const result = await sdkModelDiscovery.discover({ force: true });
    res.json(result);
  } catch (err) { next(err); }
});

// Admin endpoint: return current SDK provider health status.
router.get('/providers/sdk/health', (req, res) => {
  res.json({ health: sdkHealthService ? sdkHealthService.getStatus() : {} });
});

// Admin endpoint: return the current capability map (for capability-aware routing).
router.get('/providers/sdk/capabilities', (req, res) => {
  res.json({ capabilities: modelRouter ? modelRouter._legacyCapabilities || {} : {} });
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

router.post('/keys', async (req, res, next) => {
  try {
    const { key, name, role, allowedProviders, deniedProviders, allowedModels, deniedModels, expiresAt, description, permissions, rateLimit, quota, metadata, tags, enabled, revoked, usageCount, userId } = req.body;

    // Secure-generation path (Prompt 23): when no explicit `key` is supplied,
    // generate a cryptographically-secure key, store ONLY its hash + prefix,
    // and return the plaintext EXACTLY ONCE. When a `key` is supplied the
    // legacy behaviour is preserved (backward compatible).
    if (!key) {
      const { record, rawKey } = await apiKeyStore.generateKey({
        name: name || `key-${Date.now()}`,
        role, userId, allowedProviders, deniedProviders, allowedModels, deniedModels,
        expiresAt, description, permissions, rateLimit, quota, metadata, tags,
        enabled, status: req.body.status,
      });
      if (usageTracker && typeof usageTracker._ensure === 'function') {
        // no-op ensure; usage is created lazily on first request
      }
      // Audit (non-secret): key created.
      require('../utils/logger').info('API_KEY_CREATED', { id: record.id, keyPrefix: record.keyPrefix, role: record.role });
      return res.json({
        success: true,
        key: apiKeyStore.publicView(record),
        // One-time plaintext — never returned again, never logged, never stored.
        apiKey: rawKey,
      });
    }

    if (typeof key !== 'string') {
      throw new AppError('A "key" string is required', 400, { code: 'INVALID_REQUEST' });
    }
    if (apiKeyStore.keysByKey.has(key)) {
      throw new AppError('A key with this value already exists', 409, { code: 'CONFLICT' });
    }

    const record = await apiKeyStore.createKey({
      key,
      name: name || `key-${Date.now()}`,
      role,
      userId,
      allowedProviders,
      deniedProviders,
      allowedModels,
      deniedModels,
      expiresAt,
      description,
      permissions,
      rateLimit,
      quota,
      metadata,
      tags,
      enabled,
      status: req.body.status,
      usageCount,
    });

    require('../utils/logger').info('API_KEY_CREATED', { id: record.id, keyPrefix: record.keyPrefix, role: record.role });
    res.json({ success: true, key: apiKeyStore.publicView(record) });
  } catch (err) {
    next(err);
  }
});

// Revoke a key (keeps the record + historical usage; status -> revoked).
router.post('/keys/:id/revoke', async (req, res, next) => {
  try {
    const record = await apiKeyStore.revokeKey(req.params.id);
    if (!record) {
      throw new AppError(`Key "${req.params.id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    require('../utils/logger').info('API_KEY_REVOKED', { id: record.id });
    res.json({ success: true, key: apiKeyStore.publicView(record) });
  } catch (err) {
    next(err);
  }
});

// Rotate a key's secret (preserves id, metadata, quota, usage). Returns the
// new one-time plaintext key.
router.post('/keys/:id/rotate', async (req, res, next) => {
  try {
    const result = await apiKeyStore.rotateKey(req.params.id);
    if (!result) {
      throw new AppError(`Key "${req.params.id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    require('../utils/logger').info('API_KEY_ROTATED', { id: result.record.id, keyPrefix: result.record.keyPrefix });
    res.json({ success: true, key: apiKeyStore.publicView(result.record), apiKey: result.rawKey });
  } catch (err) {
    next(err);
  }
});

// Per-key quota status ({ limit, used, remaining }).
router.get('/keys/:id/quota', (req, res, next) => {
  try {
    const quota = apiKeyStore.getQuota(req.params.id);
    if (quota === null) {
      // Key exists but has no quota, or key not found — distinguish.
      const exists = (apiKeyStore.keys || []).some((k) => k.id === req.params.id);
      if (!exists) throw new AppError(`Key "${req.params.id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    res.json({ keyId: req.params.id, quota: quota || null });
  } catch (err) {
    next(err);
  }
});

router.delete('/keys/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const removed = await apiKeyStore.deleteKey(id);
    if (!removed) {
      throw new AppError(`Key "${id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.put('/keys/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const updated = await apiKeyStore.updateKey(id, req.body);
    if (!updated) {
      throw new AppError(`Key "${id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    res.json({ success: true, key: apiKeyStore.publicView(updated) });
  } catch (err) {
    next(err);
  }
});

// PATCH — partial update (same handler as PUT for full backward compat; the
// update method only applies provided fields).
router.patch('/keys/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const updated = await apiKeyStore.updateKey(id, req.body);
    if (!updated) {
      throw new AppError(`Key "${id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    res.json({ success: true, key: apiKeyStore.publicView(updated) });
  } catch (err) {
    next(err);
  }
});

router.get('/keys/:id/usage', (req, res, next) => {
  try {
    // Rich analytics view (historical usage + status/stream/latency) plus the
    // legacy per-key counter for backward compatibility.
    const analytics = usageAnalyticsService.getApiKeyUsage(req.params.id);
    const usage = usageTracker.getUsage(req.params.id);
    res.json({ keyId: req.params.id, usage: usage || null, analytics: analytics || null });
  } catch (err) {
    next(err);
  }
});

// Per-key quota analytics ({ limit, used, remaining, percentageUsed,
// percentageRemaining, resetPeriod, resetAt }) from the single quota source
// of truth (ApiKeyStore).
router.get('/keys/:id/quota', (req, res, next) => {
  try {
    const quota = usageAnalyticsService.getApiKeyQuota(req.params.id);
    if (quota === null) {
      const exists = (apiKeyStore.keys || []).some((k) => k.id === req.params.id);
      if (!exists) throw new AppError(`Key "${req.params.id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    res.json({ keyId: req.params.id, quota: quota || null });
  } catch (err) {
    next(err);
  }
});

// --- Usage Analytics (Prompt 24) — admin aggregate reporting ---

// Global usage summary (status breakdown + stream split + latency stats).
router.get('/usage/summary', (req, res, next) => {
  try {
    res.json({ summary: usageAnalyticsService.getUsageSummary() });
  } catch (err) { next(err); }
});

// Provider usage aggregation (providers from the Provider Registry).
router.get('/usage/providers', (req, res, next) => {
  try {
    res.json({ providers: usageAnalyticsService.getProviderUsage() });
  } catch (err) { next(err); }
});

// Model usage aggregation; optional ?providerId= to slice per provider.
router.get('/usage/models', (req, res, next) => {
  try {
    res.json({ models: usageAnalyticsService.getModelUsage({ providerId: req.query.providerId }) });
  } catch (err) { next(err); }
});

// Daily usage buckets; optional ?days=N to slice the most recent N days.
router.get('/usage/daily', (req, res, next) => {
  try {
    const days = req.query.days ? parseInt(req.query.days, 10) : undefined;
    res.json({ daily: usageAnalyticsService.getDailyUsage({ days }) });
  } catch (err) { next(err); }
});

// Monthly usage buckets; optional ?months=N.
router.get('/usage/monthly', (req, res, next) => {
  try {
    const months = req.query.months ? parseInt(req.query.months, 10) : undefined;
    res.json({ monthly: usageAnalyticsService.getMonthlyUsage({ months }) });
  } catch (err) { next(err); }
});

// Paginated + filtered raw usage detail (request history, metadata only).
// Filters: apiKeyId, providerId, model, status(success|error), stream,
// startDate, endDate (epoch ms). Pagination: page, limit.
router.get('/usage/detail', (req, res, next) => {
  try {
    const q = req.query;
    const result = usageAnalyticsService.getUsageDetail({
      apiKeyId: q.apiKeyId,
      providerId: q.providerId,
      model: q.model,
      status: q.status,
      stream: q.stream === undefined ? undefined : (q.stream === 'true'),
      startDate: q.startDate ? parseInt(q.startDate, 10) : undefined,
      endDate: q.endDate ? parseInt(q.endDate, 10) : undefined,
      page: q.page,
      limit: q.limit,
    });
    res.json(result);
  } catch (err) { next(err); }
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
    const dir = providerManager.getConfigDir()
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
 * Returns the current routing strategies (provider, connection, key
 * selection), per-provider connection overrides, the list of available
 * strategies, and human-readable strategy descriptions for the dashboard.
 */
router.get('/routing', (req, res) => {
  res.json({
    strategy: modelRouter.getStrategy(),
    connectionStrategy: accountManager ? accountManager.defaultStrategy : 'priority',
    keySelectionStrategy: routingConfig.keySelectionStrategy || 'round-robin',
    providerStrategies: accountManager ? accountManager.getProviderStrategies() : {},
    availableStrategies: routingStrategy.listStrategies(),
    availableConnectionStrategies: require('../config/routingConfig').CONNECTION_STRATEGIES,
    availableKeySelectionStrategies: keySelectionStrategy.listStrategies(),
    strategyDescriptions: {
      priority: 'Uses the highest-priority eligible connection first.',
      'round-robin': 'Distributes requests sequentially across eligible connections.',
      'least-used': 'Selects the connection with the lowest current usage.',
      weighted: 'Distributes traffic according to configured weights.',
      random: 'Randomly selects an eligible connection.',
      'fastest-response': 'Uses the connection with the lowest observed latency.',
      'lowest-latency': 'Uses the connection with the lowest p50 latency.',
      'lowest-cost': 'Uses the lowest-cost eligible provider first.',
      'highest-success-rate': 'Uses the provider with the highest recent success rate.',
    },
    providers: providerManager.listProviders().map((p) => ({
      id: p.id,
      keySelectionStrategy: apiKeyManager.getStrategy(p.id),
      connectionStrategy: accountManager ? accountManager.getStrategy(p.id) : null,
    })),
  });
});

/**
 * PUT /admin/api/routing
 *
 * Update the routing strategies at runtime (no restart). The body may
 * contain any of:
 *   { strategy, connectionStrategy, keySelectionStrategy,
 *     providerStrategies: { providerId: strategyId|null } }
 *
 * Changes are applied in-memory immediately (the next request uses them —
 * in-flight requests are untouched) AND persisted to config/routing.json so
 * a restart (or hot reload) restores the same configuration. Invalid
 * strategies are rejected with 400 and nothing is changed.
 */
router.put('/routing', (req, res, next) => {
  try {
    const { validateRoutingPatch, saveRoutingConfig } = require('../config/routingConfig');
    const { valid, errors, patch } = validateRoutingPatch(req.body || {});
    if (!valid) {
      throw new AppError(errors.join('; '), 400, {
        code: 'INVALID_REQUEST',
        available: routingStrategy.listStrategies(),
      });
    }
    if (Object.keys(patch).length === 0) {
      throw new AppError('Nothing to update — provide strategy, connectionStrategy, keySelectionStrategy, or providerStrategies', 400, {
        code: 'INVALID_REQUEST',
      });
    }

    if (patch.strategy !== undefined) {
      routingConfig.strategy = patch.strategy;
      modelRouter.setStrategy(patch.strategy);
    }
    if (patch.connectionStrategy !== undefined && accountManager) {
      routingConfig.connectionStrategy = patch.connectionStrategy;
      accountManager.setDefaultStrategy(patch.connectionStrategy);
    }
    if (patch.keySelectionStrategy !== undefined) {
      routingConfig.keySelectionStrategy = patch.keySelectionStrategy;
      apiKeyManager.defaultStrategy = patch.keySelectionStrategy;
      for (const p of providerManager.listProviders()) {
        apiKeyManager.setStrategy(p.id, patch.keySelectionStrategy);
      }
    }
    if (patch.providerStrategies !== undefined && accountManager) {
      routingConfig.providerStrategies = { ...patch.providerStrategies };
      // Clear overrides not present in the new map, then apply the new set.
      const current = accountManager.getProviderStrategies();
      for (const pid of Object.keys(current)) {
        if (!(pid in patch.providerStrategies)) accountManager.setProviderStrategy(pid, null);
      }
      for (const [pid, sid] of Object.entries(patch.providerStrategies)) {
        accountManager.setProviderStrategy(pid, sid);
      }
    }

    // Legacy body field: providerKeySelectionStrategy (per-provider key
    // selection override) — preserved for backward compatibility.
    if (req.body.providerKeySelectionStrategy !== undefined) {
      const overrides = req.body.providerKeySelectionStrategy;
      if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
        for (const [providerId, stratId] of Object.entries(overrides)) {
          apiKeyManager.setStrategy(providerId, stratId);
        }
      }
    }

    const persisted = saveRoutingConfig(routingConfig);
    res.json({
      success: true,
      strategy: modelRouter.getStrategy(),
      connectionStrategy: accountManager ? accountManager.defaultStrategy : null,
      keySelectionStrategy: apiKeyManager.defaultStrategy,
      providerStrategies: accountManager ? accountManager.getProviderStrategies() : {},
      persisted,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/api/routing/status
 *
 * Aggregated routing status for the dashboard: active strategies, provider
 * and connection counts, and health breakdown. Secret-free.
 */
router.get('/routing/status', async (req, res, next) => {
  try {
    const providers = providerManager.listProviders();
    const enabledProviders = providers.filter((p) => p.enabled !== false);
    const health = healthMonitor ? healthMonitor.getAllHealth() : {};
    const accounts = accountManager ? await accountManager.listAccounts() : [];
    const active = accounts.filter((a) => a.enabled !== false && a.status !== 'expired' && a.status !== 'disconnected');
    const connHealth = accountManager ? accountManager.getHealth() : {};
    const healthy = active.filter((a) => {
      const h = connHealth[a.id];
      return !h || (h.failureCount || 0) === 0 || (h.successCount || 0) > 0;
    });
    res.json({
      strategy: modelRouter.getStrategy(),
      connectionStrategy: accountManager ? accountManager.defaultStrategy : 'priority',
      keySelectionStrategy: routingConfig.keySelectionStrategy || 'round-robin',
      providers: providers.length,
      activeProviders: enabledProviders.length,
      connections: accounts.length,
      activeConnections: active.length,
      disabledConnections: accounts.length - active.length,
      healthyConnections: healthy.length,
      unhealthyConnections: active.length - healthy.length,
      providerHealth: Object.fromEntries(Object.entries(health).map(([k, v]) => [k, { online: v.online }])),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/api/routing/activity
 *
 * Recent routing decisions (time, model, provider, connection, strategy,
 * latency, status). Sourced from the RequestLog ring buffer — never
 * contains credentials or API key material.
 */
router.get('/routing/activity', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const entries = requestLog.getRecent(limit).map((e) => ({
    timestamp: e.timestamp,
    model: e.model,
    providerId: e.providerId,
    connectionId: e.connectionId || null,
    connectionName: e.connectionName || null,
    strategy: e.strategy || null,
    latencyMs: e.latencyMs,
    status: e.status,
  }));
  res.json({ entries });
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
// Model-Based Routing Rules (Dashboard-managed)
// ---------------------------------------------------------------

/**
 * GET /admin/api/routing/rules
 *
 * Returns all model-based routing rules.
 */
router.get('/routing/rules', (req, res) => {
  res.json({ rules: modelRouter.listModelRules() });
});

/**
 * POST /admin/api/routing/rules
 *
 * Create a model-based routing rule. Body: { id?, model, strategy?,
 * providerOrder?, connectionIds?, enabled? }. When `id` is omitted one is
 * generated from the model. Rule is applied immediately (hot) and persisted
 * to config/routingRules.json.
 */
router.post('/routing/rules', (req, res, next) => {
  try {
    const { validateModelRoutingRule } = require('../config/routingRulesConfig');
    const body = req.body || {};
    const baseId = typeof body.id === 'string' && body.id
      ? body.id
      : `rule-${String(body.model || 'model').replace(/[^A-Za-z0-9._-]/g, '-')}`;
    // Auto-generated ids get a collision-proof suffix; explicit ids must be unique.
    let ruleId = baseId;
    if (!body.id) {
      const existing = new Set(modelRouter.listModelRules().map((r) => r.id));
      if (existing.has(ruleId)) {
        ruleId = `${baseId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      }
    }
    const rule = {
      id: ruleId,
      model: body.model,
      strategy: body.strategy,
      providerOrder: body.providerOrder,
      connectionIds: body.connectionIds,
      enabled: body.enabled !== false,
    };
    const { valid, errors } = validateModelRoutingRule(rule);
    if (!valid) {
      throw new AppError(errors.join('; '), 400, { code: 'INVALID_REQUEST' });
    }
    // Strategy must be a known routing strategy.
    if (rule.strategy && !routingStrategy.listStrategies().includes(rule.strategy)) {
      throw new AppError(`Unknown routing strategy "${rule.strategy}"`, 400, {
        code: 'INVALID_REQUEST', available: routingStrategy.listStrategies(),
      });
    }
    if (modelRouter.listModelRules().some((r) => r.id === rule.id)) {
      throw new AppError(`Rule "${rule.id}" already exists`, 409, { code: 'CONFLICT' });
    }
    modelRouter.setModelRule(rule);
    const persisted = persistModelRules();
    res.status(201).json({ success: true, rule, persisted });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /admin/api/routing/rules/:id
 *
 * Update a model-based routing rule (full replace of mutable fields).
 */
router.put('/routing/rules/:id', (req, res, next) => {
  try {
    const { validateModelRoutingRule } = require('../config/routingRulesConfig');
    const id = req.params.id;
    const existing = modelRouter.listModelRules().find((r) => r.id === id);
    if (!existing) {
      throw new AppError(`Routing rule "${id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    const body = req.body || {};
    const rule = {
      id,
      model: body.model !== undefined ? body.model : existing.model,
      strategy: body.strategy !== undefined ? body.strategy : existing.strategy,
      providerOrder: body.providerOrder !== undefined ? body.providerOrder : existing.providerOrder,
      connectionIds: body.connectionIds !== undefined ? body.connectionIds : existing.connectionIds,
      enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
    };
    const { valid, errors } = validateModelRoutingRule(rule);
    if (!valid) {
      throw new AppError(errors.join('; '), 400, { code: 'INVALID_REQUEST' });
    }
    if (rule.strategy && !routingStrategy.listStrategies().includes(rule.strategy)) {
      throw new AppError(`Unknown routing strategy "${rule.strategy}"`, 400, {
        code: 'INVALID_REQUEST', available: routingStrategy.listStrategies(),
      });
    }
    modelRouter.setModelRule(rule);
    const persisted = persistModelRules();
    res.json({ success: true, rule, persisted });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /admin/api/routing/rules/:id
 *
 * Remove a model-based routing rule.
 */
router.delete('/routing/rules/:id', (req, res, next) => {
  try {
    const removed = modelRouter.removeModelRule(req.params.id);
    if (!removed) {
      throw new AppError(`Routing rule "${req.params.id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    const persisted = persistModelRules();
    res.json({ success: true, persisted });
  } catch (err) {
    next(err);
  }
});

/**
 * Persist the current model-rule set to config/routingRules.json.
 * Best-effort — returns false when the write fails (never throws into the
 * request path).
 * @returns {boolean}
 */
function persistModelRules() {
  try {
    const { saveModelRoutingRules } = require('../config/routingRulesConfig');
    return saveModelRoutingRules(modelRouter.listModelRules());
  } catch (_) {
    return false;
  }
}

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

// ---------------------------------------------------------------

// ---------------------------------------------------------------
// Connect Account — provider catalog + auth types
// ---------------------------------------------------------------
/**
 * GET /admin/api/accounts/catalog
 * Returns the full provider catalog (metadata + templates for every known
 * provider) so the UI can render "Connect Account" forms.
 */
router.get('/accounts/catalog', (req, res) => {
  res.json({ catalog: providerCatalog ? providerCatalog.list() : [] });
});

/**
 * GET /admin/api/accounts/types
 * Returns the available auth types for the Connect Account UI.
 */
router.get('/accounts/types', (req, res) => {
  res.json({ authTypes: connectionRegistry.authTypes() });
});

// Connect Account (Sprint: Dashboard Admin & Connect Account)
// ---------------------------------------------------------------
// Endpoints for the generic authentication architecture. Each provider
// selects an auth type; the ConnectionRegistry + AuthAdapterFactory drive the
// lifecycle. New providers = new adapter — no public API change.

/**
 * GET /admin/api/accounts
 * GET /admin/api/accounts?providerId=<id>
 *
 * List all connected accounts (redacted — never exposes credentials), plus
 * the available auth types and per-provider adapter availability.
/**

 * GET /admin/api/accounts/:accountId/status
 *
 * Return the current connection state for one account.
 */
router.get('/accounts/:accountId/status', async (req, res, next) => {
  try {
    const status = await connectionRegistry.status(req.params.accountId);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/api/accounts/connect
 *
 * Connect (or reconnect) a provider account. Body:
 *   { providerId, authType, name?, ...provider-specific credential }
 */
router.post('/accounts/connect', async (req, res, next) => {
  try {
    const account = await connectionRegistry.connect(req.body || {});
    res.json({ success: true, account });
  } catch (err) {
    next(new AppError(err.message || 'connect failed', 400, { code: err.code || 'AUTH_CONNECT_FAILED' }));
  }
});

/**
 * POST /admin/api/accounts/:accountId/refresh
 *
 * Refresh a connection's expiring credential.
 */
router.post('/accounts/:accountId/refresh', async (req, res, next) => {
  try {
    const account = await connectionRegistry.refresh(req.params.accountId);
    res.json({ success: true, account });
  } catch (err) {
    next(new AppError(err.message || 'refresh failed', 400, { code: err.code || 'AUTH_REFRESH_FAILED' }));
  }
});

/**
 * DELETE /admin/api/accounts/:accountId
 *
 * Disconnect (revoke) an account. Removes the stored credential from both
 * the registry storage and the AccountManager index; usage/analytics
 * history recorded under the account id is left untouched.
 */
router.delete('/accounts/:accountId', async (req, res, next) => {
  try {
    const ok = await connectionManager.disconnect(req.params.accountId);
    if (!ok) {
      throw new AppError(`Account "${req.params.accountId}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    require('../utils/logger').info('CONNECTION_DELETED', { accountId: req.params.accountId });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/api/accounts/hydrate
 *
 * Manually re-restore accounts from the storage backend (e.g. after a Redis
 * connection is established).
 */
router.post('/accounts/hydrate', async (req, res, next) => {
  try {
    const count = await connectionRegistry.hydrate();
    res.json({ success: true, restored: count });
  } catch (err) {
    next(err);
  }
});

// --- Account Manager: enhance accounts with rich fields, health, test, routing ---

/**
 * PUT /admin/api/accounts/:accountId
 *
 * Update an account's fields (displayName, email, enabled, priority, weight, tags,
 * quota, apiKey, accessToken, refreshToken). Also can enable/disable.
 */
router.put('/accounts/:accountId', async (req, res, next) => {
  try {
    const id = req.params.accountId;
    const raw = await connectionRegistry._loadAccount(id).catch(() => null);
    if (!raw) {
      throw new AppError(`Account "${id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    const patch = req.body || {};
    // Merge into the raw stored account. The encrypted credential envelope
    // is ALWAYS preserved from storage unless the admin explicitly supplies
    // a replacement credential (apiKey/accessToken/sessionToken/cookies).
    const merged = { ...raw, ...patch };
    if (patch.apiKey || patch.accessToken || patch.sessionToken || patch.cookies) {
      // Credential rotation: build a new plain credential object; it is
      // encrypted by _saveAccount before persistence.
      merged.credential = {
        ...(connectionRegistry._plain(raw).credential || {}),
        ...(patch.apiKey ? { apiKey: patch.apiKey } : {}),
        ...(patch.accessToken ? { accessToken: patch.accessToken } : {}),
        ...(patch.sessionToken ? { sessionToken: patch.sessionToken } : {}),
        ...(patch.cookies ? { cookies: patch.cookies } : {}),
      };
    } else {
      merged.credential = raw.credential;
    }
    delete merged.token;
    merged.updatedAt = Date.now();
    if (patch.enabled === undefined) merged.enabled = raw.enabled !== false;
    await connectionRegistry._saveAccount(merged, raw.authType);
    // Keep the AccountManager's enhanced in-memory index in sync so routing
    // strategies (weight/priority/enabled) see the new values immediately.
    if (accountManager && accountManager._accounts) {
      const plain = connectionRegistry._plain(merged);
      const existing = accountManager._accounts.get(id) || {};
      accountManager._accounts.set(id, { ...existing, ...plain });
    }
    res.json({ success: true, account: accountManager.publicView(connectionRegistry._plain(merged)) });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /admin/api/accounts/:accountId
 *
 * Partial update alias (same handler).
 */
router.patch('/accounts/:accountId', async (req, res, next) => {
  try {
    // PATCH behaves exactly like PUT (both preserve the stored credential
    // unless a replacement is supplied) — delegate to the PUT handler.
    req.method = 'PUT';
    router.handle(req, res, next);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/api/accounts/:accountId/test
 *
 * Test connection validity for an account.
 */
router.post('/accounts/:accountId/test', async (req, res, next) => {
  try {
    const id = req.params.accountId;
    const token = await connectionRegistry.getToken ? connectionRegistry.getToken(id) : null;
    if (!token) throw new AppError(`Account "${id}" has no token record`, 400, { code: 'AUTH_NOT_CONNECTED' });
    const start = Date.now();
    // Attempt a simple connectivity check (try to get the provider's models).
    const adapter = connectionRegistry._adapter(token.providerId, token.authType);
    let ok = true;
    let error = null;
    try {
      if (adapter.healthCheckHttp) {
        await adapter.healthCheckHttp({ timeout: 5000 });
      } else {
        // Lightweight check: verify the credential can be decrypted and is not expired.
        ok = token.status !== 'expired' && !!token.accessToken;
        if (!ok) error = 'Token is expired';
      }
    } catch (err) {
      ok = false;
      error = err.message;
      accountManager.recordFailure(id, err.message);
    }
    const latencyMs = Date.now() - start;
    res.json({ success: ok, accountId: id, latencyMs, error, state: token.status });
  } catch (err) {
    next(err);
  }
});

// --- ConnectionManager lifecycle endpoints ---

router.post('/accounts/:id/connect', async (req, res, next) => {
  try {
    const id = req.params.id;
    const existing = await connectionManager.getConnection(id);
    if (existing) throw new AppError(`Account "${id}" already exists`, 409, { code: 'CONFLICT' });
    const acct = await connectionManager.registerConnection({ accountId: id, ...(req.body || {}) });
    res.status(201).json({ success: true, account: acct });
  } catch (err) { next(err); }
});

router.post('/accounts/:id/disconnect', async (req, res, next) => {
  try {
    await connectionManager.disconnect(req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/accounts/:id/reconnect', async (req, res, next) => {
  try {
    const acct = await connectionManager.reconnect(req.params.id);
    res.json({ success: true, account: acct });
  } catch (err) { next(err); }
});

router.post('/accounts/:id/refresh', async (req, res, next) => {
  try {
    const acct = await connectionManager.refresh(req.params.id);
    res.json({ success: true, account: acct });
  } catch (err) { next(err); }
});

router.post('/accounts/:id/validate', async (req, res, next) => {
  try {
    const valid = await connectionManager.validate(req.params.id);
    const status = await connectionManager.getStatus(req.params.id);
    res.json({ valid, status });
  } catch (err) { next(err); }
});

/**
 * GET /admin/api/accounts/config/health
 *
 * Returns per-account health metrics for the dashboard.
 */
router.get('/accounts/config/health', (req, res) => {
  res.json({ health: accountManager ? accountManager.getHealth() : {} });
});

/**
 * PUT /admin/api/accounts/config/routing
 *
 * Set the account selection strategy per provider. Body:
 *   { providerId: "...", strategy: "priority|fastest|weighted|round-robin|least-used|random" }
 */
router.put('/accounts/config/routing', (req, res, next) => {
  try {
    const { providerId, strategy } = req.body || {};
    if (!providerId || !strategy) {
      throw new AppError('providerId and strategy are required', 400, { code: 'INVALID_REQUEST' });
    }
    const { CONNECTION_STRATEGIES } = require('../config/routingConfig');
    if (!CONNECTION_STRATEGIES.includes(strategy)) {
      throw new AppError(`Invalid strategy "${strategy}". Valid: ${CONNECTION_STRATEGIES.join(', ')}`, 400, { code: 'INVALID_REQUEST' });
    }
    // Store the strategy as a per-provider override on the AccountManager.
    accountManager.setProviderStrategy(providerId, strategy);
    res.json({ success: true, providerId, strategy });
  } catch (err) {
    next(err);
  }
});

/** Get all available accounts with live status and health. */
router.get('/accounts', async (req, res, next) => {
  try {
    const accounts = await connectionRegistry.listAccounts();
    const providerId = req.query.providerId;
    const filtered = providerId ? accounts.filter((a) => a.providerId === providerId) : accounts;
    // Enhance with account manager fields (priority, weight, health, etc.)
    const enhanced = filtered.map((a) => {
      const pub = accountManager.publicView(a);
      const health = (accountManager.getHealth() || {})[a.accountId] || {};
      return { ...pub, ...health, credential: undefined };
    });
    res.json({
      accounts: enhanced,
      authTypes: connectionRegistry.authTypes(),
      routing: Object.fromEntries(accountManager._cursors),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// Connection Management (Provider credentials via Dashboard)
//
// Connections are provider credentials managed exclusively through the
// ConnectionManager/ConnectionRegistry + EncryptionService that already
// exist. Secrets are encrypted at rest, never logged, and never returned
// in plaintext — responses only ever contain masked views.
// ---------------------------------------------------------------

// Classify a connectivity/HTTP failure into a stable, secret-free reason.
function classifyTestError(err) {
  const status = err && (err.status || (err.info && err.info.status));
  const code = err && (err.code || (err.info && err.info.code));
  if (status === 401) return 'Authentication failed (401)';
  if (status === 403) return 'Access forbidden (403)';
  if (status === 429) return 'Rate limited (429)';
  if (status >= 500) return `Upstream server error (${status})`;
  if (code === 'TIMEOUT' || /timeout/i.test(err && err.message || '')) return 'Connection timed out';
  if (code === 'NETWORK_ERROR' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 'Network error';
  return (err && err.message ? String(err.message).slice(0, 120) : 'Connection failed')
    // Never leak secret-looking material in the message.
    .replace(/(sk|nvapi|pk|key|token|bearer)[-_]?[A-Za-z0-9]{12,}/gi, '********');
}

// Shared test-connection logic (used by both route shapes).
async function performConnectionTest(accountId) {
  const raw = await connectionRegistry._loadAccount(accountId).catch(() => null);
  if (!raw) return { notFound: true };
  const plain = connectionRegistry._plain(raw);
  const provider = providerManager.providersById.get(plain.providerId);
  const start = Date.now();
  let ok = false;
  let reason = null;
  try {
    if (!provider || !provider.baseURL) {
      // No endpoint to probe — validate credential presence/decryptability.
      ok = !!(plain.credential && (plain.credential.apiKey || plain.credential.accessToken));
      if (!ok) reason = 'No usable credential material';
    } else {
      const axios = require('axios');
      const cred = plain.credential || {};
      const apiKey = cred.apiKey || cred.key || cred.token;
      const resp = await axios.get(`${provider.baseURL.replace(/\/$/, '')}/models`, {
        timeout: 8000,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        validateStatus: () => true,
      });
      if (resp.status >= 200 && resp.status < 300) {
        ok = true;
      } else {
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
      }
    }
  } catch (err) {
    ok = false;
    reason = classifyTestError(err);
  }
  const latencyMs = Date.now() - start;
  // Record health via the existing AccountManager health tracking.
  if (ok) accountManager.recordUsage(accountId, { latencyMs });
  else accountManager.recordFailure(accountId, reason);
  return { ok, reason, latencyMs, status: raw };
}

// POST /admin/api/accounts/:accountId/enable | /disable
// A disabled connection keeps its credential + history but is excluded from
// every selection strategy (priority/round-robin/weighted/least-used/random)
// because AccountManager.getAvailableAccounts() filters enabled === false.
router.post('/accounts/:accountId/:action(enable|disable)', async (req, res, next) => {
  try {
    const id = req.params.accountId;
    const enable = req.params.action === 'enable';
    const raw = await connectionRegistry._loadAccount(id).catch(() => null);
    if (!raw) {
      throw new AppError(`Connection "${id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    const updated = { ...raw, enabled: enable, updatedAt: Date.now() };
    await connectionRegistry._saveAccount(updated, raw.authType);
    accountManager._accounts.set(id, { ...accountManager._accounts.get(id), ...updated });
    require('../utils/logger').info(enable ? 'CONNECTION_ENABLED' : 'CONNECTION_DISABLED', {
      accountId: id, providerId: raw.providerId,
    });
    res.json({ success: true, account: accountManager.publicView(updated) });
  } catch (err) {
    next(err);
  }
});

// POST /admin/api/accounts/:accountId/check — test connectivity using the
// server-side credential. Never returns the credential.
router.post('/accounts/:accountId/check', async (req, res, next) => {
  try {
    const result = await performConnectionTest(req.params.accountId);
    if (result.notFound) {
      throw new AppError(`Connection "${req.params.accountId}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    res.json({
      success: result.ok,
      accountId: req.params.accountId,
      latencyMs: result.latencyMs,
      error: result.ok ? null : result.reason,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/api/accounts/:accountId/detail — full redacted connection view
// (metadata + health + usage counters; credential masked).
router.get('/accounts/:accountId/detail', async (req, res, next) => {
  try {
    const id = req.params.accountId;
    const raw = await connectionRegistry._loadAccount(id).catch(() => null);
    if (!raw) {
      throw new AppError(`Connection "${id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    const health = (accountManager.getHealth() || {})[id] || {};
    const pub = accountManager.publicView({ ...raw, state: undefined });
    const status = await connectionRegistry.status(id).catch(() => ({ state: 'unknown' }));
    res.json({
      connection: {
        ...pub,
        providerId: raw.providerId,
        status: status.state || pub.status,
        lastHealthCheck: health.lastUsed || null,
        successCount: health.successCount || 0,
        failureCount: health.failureCount || 0,
        lastLatencyMs: health.lastLatencyMs || null,
        lastError: health.lastError || null,
        updatedAt: raw.updatedAt || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Nested aliases under /providers/:providerId/connections — the dashboard's
// canonical shape. They delegate to the same ConnectionManager logic above.
router.post('/providers/:providerId/connections', async (req, res, next) => {
  try {
    const providerId = req.params.providerId;
    if (!providerManager.providersById.has(providerId)) {
      throw new AppError(`Provider "${providerId}" not found`, 404, { code: 'PROVIDER_NOT_FOUND' });
    }
    const { id, name, apiKey, enabled } = req.body || {};
    const accountId = id || `${providerId}-${Date.now()}`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(accountId)) {
      throw new AppError('Connection "id" may only contain letters, digits, "-" and "_"', 400, { code: 'INVALID_REQUEST' });
    }
    if (await connectionManager.getConnection(accountId)) {
      throw new AppError(`Connection "${accountId}" already exists`, 409, { code: 'CONFLICT' });
    }
    if (!apiKey || typeof apiKey !== 'string') {
      throw new AppError('A credential "apiKey" is required', 400, { code: 'INVALID_REQUEST' });
    }
    const acct = await connectionManager.registerConnection({
      accountId, providerId, authType: 'api-key', displayName: name || accountId, apiKey, enabled: enabled !== false,
    });
    require('../utils/logger').info('CONNECTION_CREATED', { accountId, providerId });
    res.status(201).json({ success: true, account: acct });
  } catch (err) {
    next(err);
  }
});

router.get('/providers/:providerId/connections', async (req, res, next) => {
  try {
    // AccountManager reconciles with the registry/storage on every call.
    const accounts = await accountManager.listAccounts(req.params.providerId);
    const health = accountManager.getHealth() || {};
    res.json({
      connections: accounts.map((a) => ({ ...a, ...(health[a.id] || {}), credential: undefined })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/providers/:providerId/connections/:connectionId/test', async (req, res, next) => {
  try {
    const result = await performConnectionTest(req.params.connectionId);
    if (result.notFound || result.status.providerId !== req.params.providerId) {
      throw new AppError(`Connection "${req.params.connectionId}" not found for provider "${req.params.providerId}"`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    res.json({
      success: result.ok,
      connectionId: req.params.connectionId,
      providerId: req.params.providerId,
      latencyMs: result.latencyMs,
      error: result.ok ? null : result.reason,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/providers/:providerId/connections/:connectionId/:action(enable|disable)', async (req, res, next) => {
  try {
    const raw = await connectionRegistry._loadAccount(req.params.connectionId).catch(() => null);
    if (!raw || raw.providerId !== req.params.providerId) {
      throw new AppError(`Connection "${req.params.connectionId}" not found for provider "${req.params.providerId}"`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    // Delegate to the flat route logic.
    req.params.accountId = req.params.connectionId;
    req.url = `/accounts/${req.params.connectionId}/${req.params.action}`;
    router.handle(req, res, next);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/api/providers
 *
 * Add a new provider by writing its config file and triggering a reload.
 * Body is the full provider config object (id required).
 */
router.post('/providers', async (req, res, next) => {
  try {
    const p = req.body || {};
    if (!p.id || typeof p.id !== 'string') {
      throw new AppError('A provider "id" is required', 400, { code: 'INVALID_REQUEST' });
    }
    // Provider IDs are used in file names, URLs, routing maps and API key
    // permissions — restrict to a safe slug.
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(p.id)) {
      throw new AppError(
        'Provider "id" must be a lowercase slug (letters, digits, "-" and "_", starting with a letter or digit)',
        400, { code: 'INVALID_REQUEST' }
      );
    }
    if (providerManager.providersById.has(p.id)) {
      throw new AppError(`Provider "${p.id}" already exists`, 409, { code: 'CONFLICT' });
    }

    // Adapter validation: the provider must use a registered adapter so it
    // never bypasses the ProviderAdapterRegistry / ProviderSDKRegistry.
    // "generic-openai" is the built-in OpenAI-compatible adapter and is
    // always available.
    const knownAdapters = providerAdapterRegistry ? [...providerAdapterRegistry.adapterClasses.keys()] : [];
    const sdkIds = providerSDKRegistry && typeof providerSDKRegistry.listManifests === 'function'
      ? providerSDKRegistry.listManifests().map((m) => m.id || m.providerId).filter(Boolean)
      : [];
    const adapterId = p.adapter || (knownAdapters.includes(p.id) ? p.id : 'generic-openai');
    if (p.adapter !== undefined && p.adapter !== null) {
      if (typeof p.adapter !== 'string' || !p.adapter) {
        throw new AppError('"adapter" must be a non-empty string', 400, { code: 'INVALID_REQUEST' });
      }
      if (!knownAdapters.includes(p.adapter) && !sdkIds.includes(p.adapter)) {
        throw new AppError(
          `Unknown adapter "${p.adapter}". Available adapters: ${[...new Set([...knownAdapters, ...sdkIds])].sort().join(', ')}. ` +
          'Register a new adapter in the ProviderAdapterRegistry / ProviderSDKRegistry before adding this provider.',
          400, { code: 'INVALID_REQUEST', available: [...new Set([...knownAdapters, ...sdkIds])].sort() }
        );
      }
    }

    // Early baseURL validation (the config validator re-checks this, but we
    // want a clean 400 before touching disk).
    if (p.baseURL !== undefined) {
      try {
        const url = new URL(p.baseURL);
        if (!['http:', 'https:'].includes(url.protocol)) {
          throw new AppError('"baseURL" must use http or https', 400, { code: 'INVALID_REQUEST' });
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(`Invalid "baseURL": "${p.baseURL}"`, 400, { code: 'INVALID_REQUEST' });
      }
    }

    // Models validation: must be a non-empty string array.
    if (!Array.isArray(p.supportedModels) || p.supportedModels.length === 0 || !p.supportedModels.every((m) => typeof m === 'string' && m)) {
      throw new AppError('"supportedModels" must be a non-empty array of model id strings', 400, { code: 'INVALID_REQUEST' });
    }

    const dir = providerManager.getConfigDir() || path.join(process.cwd(), 'config', 'providers');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const toWrite = { ...p, adapter: adapterId, createdAt: p.createdAt || Date.now(), updatedAt: Date.now() };
    delete toWrite.health;
    fs.writeFileSync(path.join(dir, `${p.id}.json`), JSON.stringify(toWrite, null, 2));

    const result = await providerConfigManager.reload();
    if (!result.success) {
      // Roll back the file we wrote so config stays consistent.
      fs.unlinkSync(path.join(dir, `${p.id}.json`));
      throw new AppError('Validation failed: ' + (result.errors || []).join('; '), 400, {
        code: 'INVALID_REQUEST', errors: result.errors,
      });
    }
    require('../utils/logger').info('PROVIDER_CREATED', { providerId: p.id, adapter: adapterId });
    // Never return plaintext credentials — respond with the redacted view.
    res.status(201).json({ success: true, provider: providerView(providerManager.providersById.get(p.id)) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /admin/api/providers/:id
 *
 * Safe-delete a provider. Deletion is REFUSED (409) while the provider still
 * has any of the following, so historical data is never orphaned:
 *   - active/enabled connections (disable or remove them first)
 *   - API keys that allow this provider (allowedProviders)
 *   - recorded usage history
 * This keeps usage analytics, permissions and audit history intact.
 */
router.delete('/providers/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const existing = providerManager.providersById.get(id);
    if (!existing) {
      throw new AppError(`Provider "${id}" not found`, 404, { code: 'PROVIDER_NOT_FOUND' });
    }

    const blockers = [];

    // 1. Active connections (disabled ones don't block deletion).
    let connections = [];
    try {
      connections = connectionManager ? await connectionManager.listConnections(id) : [];
    } catch (_) { connections = []; }
    const activeConnections = (connections || []).filter((c) => c && c.enabled !== false && c.status !== 'disconnected');
    if (activeConnections.length > 0) {
      blockers.push(`${activeConnections.length} active connection(s)`);
    }

    // 2. API key permissions referencing this provider.
    const referencingKeys = (apiKeyStore.listKeys() || []).filter(
      (k) => Array.isArray(k.allowedProviders) && k.allowedProviders.includes(id)
    );
    if (referencingKeys.length > 0) {
      blockers.push(`${referencingKeys.length} API key(s) allow this provider`);
    }

    // 3. Usage history.
    const usage = usageAnalyticsService
      ? usageAnalyticsService.getProviderUsage().find((u) => u.providerId === id)
      : null;
    if (usage && (usage.requests || 0) > 0) {
      blockers.push('usage history exists');
    }

    if (blockers.length > 0) {
      throw new AppError(
        `Provider "${id}" cannot be deleted: ${blockers.join('; ')}. ` +
        'Disable the provider instead to keep models, credentials, permissions and history.',
        409, { code: 'CONFLICT', blockers }
      );
    }

    const dir = providerManager.getConfigDir() || path.join(process.cwd(), 'config', 'providers');
    const file = path.join(dir, `${id}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);

    const result = await providerConfigManager.reload();
    if (!result.success) {
      throw new AppError('Reload after delete failed: ' + (result.errors || []).join('; '), 500, {
        code: 'RELOAD_FAILED', errors: result.errors,
      });
    }
    require('../utils/logger').info('PROVIDER_DELETED', { providerId: id });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/api/providers/:id/manual-models
 *
 * Add models to a provider's supportedModels manually and reload. Body:
 *   { models: string[] } (added idempotently)
 */
router.post('/providers/:id/manual-models', async (req, res, next) => {
  try {
    const id = req.params.id;
    const p = providerManager.providersById.get(id);
    if (!p) {
      throw new AppError(`Provider "${id}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    const models = Array.isArray(req.body && req.body.models) ? req.body.models : [];
    const existing = new Set(p.supportedModels || []);
    for (const m of models) if (m) existing.add(m);
    p.supportedModels = [...existing];
    if (p.supportedModels.length === 0) {
      throw new AppError('"models" must be a non-empty array', 400, { code: 'INVALID_REQUEST' });
    }
    const result = await updateProviderOnDisk(p);
    res.json({ success: true, provider: p, warnings: result.warnings || [] });
  } catch (err) {
    next(err);
  }
});

// Helper: rewrite a single provider config file + reload cascade (no disk reload).
function updateProviderOnDisk(provider) {  const dir = providerManager.getConfigDir() || path.join(process.cwd(), 'config', 'providers');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const toWrite = { ...provider };
  delete toWrite.health;
  fs.writeFileSync(path.join(dir, `${provider.id}.json`), JSON.stringify(toWrite, null, 2));
  providerConfigManager.reloadCascade(providerManager.listProviders());
  return { warnings: [] };
}

// ---- Backup & Restore (Prompt 23) ----

// Create a backup (versioned, secret-free). Returns the backup object; when
// `?save=true` and a BACKUP_DIR is configured, also persists it to disk.
router.post('/backup', async (req, res, next) => {
  try {
    const backup = await backupService.createBackup({ includeUsage: req.body ? req.body.includeUsage !== false : true });
    let savedTo = null;
    if ((req.query.save === 'true' || (req.body && req.body.save === true)) && backupService.backupDir) {
      savedTo = await backupService.saveBackup(backup, (req.body && req.body.name) || 'backup');
    }
    require('../utils/logger').info('BACKUP_CREATED', {
      backupVersion: backup.backupVersion,
      savedTo: savedTo ? path.basename(savedTo) : null,
    });
    res.json({ success: true, backup, savedTo: savedTo ? path.basename(savedTo) : null });
  } catch (err) {
    next(err);
  }
});

// List persisted backups (metadata only) when a BACKUP_DIR is configured.
router.get('/backup', (req, res, next) => {
  try {
    res.json({ backups: backupService.listBackups() });
  } catch (err) {
    next(err);
  }
});

// Validate a backup payload (format, version, schema, integrity) without
// applying anything.
router.post('/backup/validate', (req, res, next) => {
  try {
    const backup = (req.body && req.body.backup) || req.body;
    const result = backupService.validateBackup(backup);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Restore a backup. Body: { backup, dryRun?:boolean } OR a stored file via
// { file, dryRun? }. Validates first; aborts on any validation error.
router.post('/backup/restore', async (req, res, next) => {
  try {
    let backup = (req.body && req.body.backup) || null;
    if (!backup && req.body && req.body.file) {
      backup = backupService.loadBackup(req.body.file);
      if (!backup) throw new AppError(`Backup file "${req.body.file}" not found`, 404, { code: 'MODEL_NOT_FOUND' });
    }
    if (!backup) throw new AppError('A "backup" object or "file" name is required', 400, { code: 'INVALID_REQUEST' });
    const dryRun = !!(req.body && req.body.dryRun);
    const result = await backupService.restoreBackup(backup, { dryRun });
    if (!result.ok && !dryRun) {
      return res.status(400).json({ success: false, ...result });
    }
    if (!dryRun) {
      require('../utils/logger').info('BACKUP_RESTORED', { applied: result.applied });
    }
    res.json({ success: result.ok, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
