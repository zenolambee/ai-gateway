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
  usageTracker,
  modelRegistry,
  requestLog,
  providerConfigManager,
  rateLimiter,
} = require('../services');

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

// --- Model Registry ---
router.get('/models', async (req, res) => {
  const entries = await modelRegistry.getEntries();
  const health = healthMonitor.getAllHealth();
  res.json({
    models: entries.map((e) => ({
      id: e.id,
      providers: e.providers,
      capabilities: e.capabilities,
      health: e.providers.map((pid) => health[pid]).filter(Boolean),
    })),
  });
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

module.exports = router;
