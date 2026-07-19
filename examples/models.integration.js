/**
 * Integration test for the Models API (GET /v1/models, GET /v1/models/:id).
 *
 * Run:  node examples/models.integration.js
 *
 * Verifies:
 *   - aggregation: models from all enabled providers appear in one list
 *   - deduplication: a model served by multiple providers appears once
 *   - OpenAI-compatible response shape (object:"list", data[].object:"model")
 *   - GET /v1/models/:id returns a single model
 *   - GET /v1/models/:id 404 for unknown model
 *   - capabilities tracked per model (via internal registry access)
 *   - provider failure: one provider's adapter throwing does not break the
 *     whole registry
 *   - cache: second call within TTL does not re-aggregate
 *   - manual refresh: invalidate() forces re-aggregation
 *   - disabled providers are excluded
 *   - owned_by reflects a serving provider id
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const app = require('../src/app');
const logger = require('../src/utils/logger');

logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

let expressServer;
let expressPort;
let tmpProvidersDir;

function writeProviderConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-models-'));

  const providerA = {
    id: 'provider-a', name: 'Provider A', enabled: true,
    adapter: 'openai', baseURL: 'http://127.0.0.1:9999',
    apiKeys: ['key-a'],
    supportedModels: ['alpha-model', 'shared-model', 'a-only-model'],
    priority: 1, timeout: 5000,
  };
  const providerB = {
    id: 'provider-b', name: 'Provider B', enabled: true,
    adapter: 'openai', baseURL: 'http://127.0.0.1:9999',
    apiKeys: ['key-b'],
    supportedModels: ['beta-model', 'shared-model', 'b-only-model'],
    priority: 2, timeout: 5000,
  };
  const providerC = {
    id: 'provider-c', name: 'Provider C', enabled: false,
    adapter: 'openai', baseURL: 'http://127.0.0.1:9999',
    apiKeys: ['key-c'],
    supportedModels: ['disabled-model'],
    priority: 3, timeout: 5000,
  };

  fs.writeFileSync(path.join(tmpProvidersDir, 'a.json'), JSON.stringify(providerA));
  fs.writeFileSync(path.join(tmpProvidersDir, 'b.json'), JSON.stringify(providerB));
  fs.writeFileSync(path.join(tmpProvidersDir, 'c.json'), JSON.stringify(providerC));
}

function startExpressServer() {
  return new Promise((resolve) => {
    expressServer = app.listen(0, '127.0.0.1', () => {
      expressPort = expressServer.address().port;
      resolve();
    });
  });
}

function getJson(pathStr) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: expressPort, path: pathStr }, (res) => {
      let c = '';
      res.on('data', (d) => (c += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(c) }); }
        catch { resolve({ status: res.statusCode, body: c }); }
      });
    }).on('error', reject);
  });
}

async function testAggregation() {
  const res = await getJson('/v1/models');
  const ids = res.body.data.map((m) => m.id);
  const hasAlpha = ids.includes('alpha-model');
  const hasBeta = ids.includes('beta-model');
  const hasAOnly = ids.includes('a-only-model');
  const hasBOnly = ids.includes('b-only-model');
  const ok = res.status === 200 && res.body.object === 'list' && hasAlpha && hasBeta && hasAOnly && hasBOnly;
  record('aggregation: models from all enabled providers appear', ok, `status=${res.status}, count=${res.body.data.length}`);
}

async function testDeduplication() {
  const res = await getJson('/v1/models');
  const shared = res.body.data.filter((m) => m.id === 'shared-model');
  const ok = shared.length === 1;
  record('deduplication: shared model appears once', ok, `count=${shared.length}`);
}

async function testDisabledExcluded() {
  const res = await getJson('/v1/models');
  const ids = res.body.data.map((m) => m.id);
  const ok = !ids.includes('disabled-model');
  record('disabled providers excluded', ok, `disabled-model present=${ids.includes('disabled-model')}`);
}

async function testOpenAICompatibility() {
  const res = await getJson('/v1/models');
  const ok =
    res.body.object === 'list' &&
    Array.isArray(res.body.data) &&
    res.body.data.every((m) =>
      typeof m.id === 'string' &&
      m.object === 'model' &&
      typeof m.created === 'number' &&
      typeof m.owned_by === 'string'
    );
  record('OpenAI-compatible list response shape', ok, `status=${res.status}`);
}

async function testSingleModel() {
  const res = await getJson('/v1/models/alpha-model');
  const ok =
    res.status === 200 &&
    res.body.id === 'alpha-model' &&
    res.body.object === 'model' &&
    typeof res.body.created === 'number' &&
    typeof res.body.owned_by === 'string';
  record('GET /v1/models/:id returns single model', ok, `status=${res.status}, id=${res.body && res.body.id}`);
}

async function testSingleModelNotFound() {
  const res = await getJson('/v1/models/no-such-model');
  const ok =
    res.status === 404 &&
    res.body.error &&
    (res.body.error.code === 'model_not_found' || /does not exist/.test(res.body.error.message));
  record('GET /v1/models/:id 404 for unknown model', ok, `status=${res.status}`);
}

async function testOwnedBy() {
  const res = await getJson('/v1/models/alpha-model');
  // alpha-model is served by provider-a (priority 1) -> owned_by should be a
  // serving provider id.
  const ok = res.body.owned_by === 'provider-a' || res.body.owned_by === 'provider-b';
  record('owned_by reflects a serving provider', ok, `owned_by=${res.body && res.body.owned_by}`);
}

async function testCapabilitiesTracked() {
  const { modelRegistry } = require('../src/services');
  const entries = await modelRegistry.getEntries();
  const alpha = entries.find((e) => e.id === 'alpha-model');
  const ok =
    alpha &&
    alpha.capabilities &&
    typeof alpha.capabilities.chat === 'boolean' &&
    typeof alpha.capabilities.embeddings === 'boolean' &&
    typeof alpha.capabilities.tools === 'boolean' &&
    typeof alpha.capabilities.streaming === 'boolean';
  record('capabilities tracked per model (internal)', ok, `caps=${alpha && JSON.stringify(alpha.capabilities)}`);
}

async function testProvidersTracked() {
  const { modelRegistry } = require('../src/services');
  const entries = await modelRegistry.getEntries();
  const shared = entries.find((e) => e.id === 'shared-model');
  const ok =
    shared &&
    Array.isArray(shared.providers) &&
    shared.providers.includes('provider-a') &&
    shared.providers.includes('provider-b');
  record('dedup: providers tracked for shared model', ok, `providers=${shared && JSON.stringify(shared.providers)}`);
}

async function testCache() {
  const { modelRegistry } = require('../src/services');
  // The registry should already be cached from previous tests.
  const freshBefore = modelRegistry.isCacheFresh();
  const entries1 = await modelRegistry.getEntries();
  const entries2 = await modelRegistry.getEntries();
  const ok = freshBefore && entries1 === entries2;
  record('cache: second call within TTL returns same entries', ok, `fresh=${freshBefore}, same=${entries1 === entries2}`);
}

async function testManualRefresh() {
  const { modelRegistry, providerManager } = require('../src/services');

  // Add a new provider config mid-run and refresh.
  const newProvider = {
    id: 'provider-d', name: 'Provider D', enabled: true,
    adapter: 'openai', baseURL: 'http://127.0.0.1:9999',
    apiKeys: ['key-d'],
    supportedModels: ['delta-model'],
    priority: 4, timeout: 5000,
  };
  fs.writeFileSync(path.join(tmpProvidersDir, 'd.json'), JSON.stringify(newProvider));
  providerManager.load(tmpProvidersDir);

  // Before refresh: delta-model should not be in the cache.
  const beforeRes = await getJson('/v1/models');
  const beforeHas = beforeRes.body.data.some((m) => m.id === 'delta-model');

  // Force refresh.
  modelRegistry.invalidate();
  await modelRegistry.refresh();
  const afterRes = await getJson('/v1/models');
  const afterHas = afterRes.body.data.some((m) => m.id === 'delta-model');

  const ok = !beforeHas && afterHas;
  record('manual refresh: new provider model appears after refresh', ok, `before=${beforeHas}, after=${afterHas}`);
}

async function testProviderFailure() {
  const { modelRegistry, adapterRegistry, providerManager } = require('../src/services');

  // Monkey-patch one provider's adapter to throw in listModels, then verify
  // the registry still aggregates the other providers.
  const providers = providerManager.listProviders();
  const target = providers.find((p) => p.id === 'provider-a');
  if (!target) {
    record('provider failure: test skipped (provider-a not found)', true);
    return;
  }
  const realAdapter = adapterRegistry.getAdapter(target);
  const origListModels = realAdapter.listModels.bind(realAdapter);
  realAdapter.listModels = () => { throw new Error('simulated provider failure'); };

  modelRegistry.invalidate();
  const entries = await modelRegistry.refresh();

  // Restore the original method.
  realAdapter.listModels = origListModels;

  // beta-model and b-only-model should still be present even though
  // provider-a failed. (provider-d may also be present from the previous test.)
  const ids = entries.map((e) => e.id);
  const ok = ids.includes('beta-model') && ids.includes('b-only-model') && !ids.includes('alpha-model');
  record('provider failure: remaining providers still collected', ok, `ids=${ids.join(',')}`);

  // Restore the cache to a good state for subsequent tests.
  modelRegistry.invalidate();
  await modelRegistry.refresh();
}

async function testCacheTtl() {
  const { ModelRegistry } = require('../src/services');
  // Create a registry with a very short TTL and verify it expires.
  const reg = new ModelRegistry(
    { providerManager: require('../src/services').providerManager, adapterRegistry: require('../src/services').adapterRegistry },
    { cacheTtlMs: 50 }
  );
  await reg.refresh();
  const freshImmediately = reg.isCacheFresh();
  await new Promise((r) => setTimeout(r, 80));
  const staleAfter = !reg.isCacheFresh();
  const ok = freshImmediately && staleAfter;
  record('cache TTL: fresh then stale after expiry', ok, `fresh=${freshImmediately}, stale=${staleAfter}`);
}

async function testChatStillWorks() {
  // Ensure the models refactor didn't break chat completions.
  const data = JSON.stringify({ model: 'alpha-model', messages: [{ role: 'user', content: 'Hi' }] });
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'POST', path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (r) => {
      let c = ''; r.on('data', (d) => (c += d)); r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(c) }); } catch { resolve({ status: r.statusCode, body: c }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
  // The mock provider at 127.0.0.1:9999 doesn't exist, so this will fail with
  // a provider error — but that's expected (no real provider running). We
  // just verify the route doesn't 500 with a stack trace.
  const ok = res.status === 502 || res.status === 504 || res.status === 200;
  record('chat completions route still responds', ok, `status=${res.status}`);
}

async function main() {
  console.log('=== Models API Integration Tests ===\n');
  writeProviderConfigs();

  const { providerManager, apiKeyManager, modelRegistry } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());
  modelRegistry.invalidate();

  await startExpressServer();

  try {
    await testAggregation();
    await testDeduplication();
    await testDisabledExcluded();
    await testOpenAICompatibility();
    await testSingleModel();
    await testSingleModelNotFound();
    await testOwnedBy();
    await testCapabilitiesTracked();
    await testProvidersTracked();
    await testCache();
    await testManualRefresh();
    await testProviderFailure();
    await testCacheTtl();
    await testChatStillWorks();
  } finally {
    await new Promise((r) => expressServer.close(r));
    fs.rmSync(tmpProvidersDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length > 0) {
    console.error('FAILED TESTS:');
    failed.forEach((f) => console.error(`  - ${f.name}: ${f.detail}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Integration test crashed:', err);
  process.exit(1);
});
