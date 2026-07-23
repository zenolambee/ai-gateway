/**
 * Integration tests for the Multi-Provider Gateway (Sprint 9).
 *
 * Run:  node examples/multiProvider.integration.js
 *
 * Covers:
 *   - Multiple providers for the same model
 *   - Provider failover when all keys of the first provider fail
 *   - Model-aware failover (only same-model providers are tried)
 *   - API key rotation within a provider
 *   - Smart routing (priority strategy)
 *   - Cooldown after repeated failures
 *   - Admin API: routing strategy, key health, per-key enable/disable
 *
 * Spins up mock provider HTTP servers, the Express app, and drives the
 * full stack through the real Chat Completions endpoint.
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

// ---------------------------------------------------------------
// Mock provider servers
// ---------------------------------------------------------------
// Each mock server records which Authorization key was used and can be
// configured to return specific status codes per key or globally.

function createMockProvider(opts = {}) {
  const seenKeys = [];
  const failKeys = new Set(); // keys that should return failure
  let failAll = false;
  let latencyMs = 0;
  let responseBody = {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 1700000000,
    model: opts.model || 'shared-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (latencyMs > 0) {
        setTimeout(() => handle(), latencyMs);
      } else {
        handle();
      }
      function handle() {
        const auth = req.headers.authorization || '';
        const key = auth.replace('Bearer ', '');
        seenKeys.push(key);

        if (failAll) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Service unavailable' } }));
          return;
        }
        if (failKeys.has(key)) {
          res.writeHead(opts.failStatus || 429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Rate limited' } }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody));
      }
    });
  });

  return {
    server,
    seenKeys,
    failKeys,
    failAll: (v) => { failAll = v; },
    setLatency: (ms) => { latencyMs = ms; },
    setResponseBody: (b) => { responseBody = b; },
    start() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          this.port = server.address().port;
          resolve();
        });
      });
    },
    stop() {
      return new Promise((r) => server.close(r));
    },
  };
}

// ---------------------------------------------------------------
// HTTP client helpers
// ---------------------------------------------------------------
let expressServer;
let expressPort;

function startExpress() {
  return new Promise((resolve) => {
    expressServer = app.listen(0, '127.0.0.1', () => {
      expressPort = expressServer.address().port;
      resolve();
    });
  });
}

function chat(model, extra) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(Object.assign({ model, messages: [{ role: 'user', content: 'hi' }] }, extra || {}));
    const req = http.request({
      host: '127.0.0.1',
      port: expressPort,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function adminGet(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: expressPort, path: '/admin/api' + p }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); }
      });
    }).on('error', reject);
  });
}

function adminPut(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'PUT', path: '/admin/api' + p,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function adminPost(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'POST', path: '/admin/api' + p,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------
let mockA, mockB, mockC; // three providers, all serving 'shared-model'
let mockExclusive; // only serves 'exclusive-model'
let tmpDir;

async function setup() {
  mockA = createMockProvider({ model: 'shared-model' });
  mockB = createMockProvider({ model: 'shared-model' });
  mockC = createMockProvider({ model: 'shared-model' });
  mockExclusive = createMockProvider({ model: 'exclusive-model' });
  await mockA.start();
  await mockB.start();
  await mockC.start();
  await mockExclusive.start();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-multi-'));
  // Provider A: priority 1, two keys
  fs.writeFileSync(path.join(tmpDir, 'providerA.json'), JSON.stringify({
    id: 'providerA', name: 'Provider A', enabled: true,
    baseURL: `http://127.0.0.1:${mockA.port}`,
    apiKeys: ['key-a1', 'key-a2'],
    supportedModels: ['shared-model'],
    priority: 1,
    timeout: 5000,
    keySelectionStrategy: 'round-robin',
  }));
  // Provider B: priority 2, two keys
  fs.writeFileSync(path.join(tmpDir, 'providerB.json'), JSON.stringify({
    id: 'providerB', name: 'Provider B', enabled: true,
    baseURL: `http://127.0.0.1:${mockB.port}`,
    apiKeys: ['key-b1', 'key-b2'],
    supportedModels: ['shared-model'],
    priority: 2,
    timeout: 5000,
  }));
  // Provider C: priority 3, one key
  fs.writeFileSync(path.join(tmpDir, 'providerC.json'), JSON.stringify({
    id: 'providerC', name: 'Provider C', enabled: true,
    baseURL: `http://127.0.0.1:${mockC.port}`,
    apiKeys: ['key-c1'],
    supportedModels: ['shared-model'],
    priority: 3,
    timeout: 5000,
  }));
  // Exclusive provider: only serves 'exclusive-model'
  fs.writeFileSync(path.join(tmpDir, 'providerExclusive.json'), JSON.stringify({
    id: 'providerExclusive', name: 'Exclusive', enabled: true,
    baseURL: `http://127.0.0.1:${mockExclusive.port}`,
    apiKeys: ['key-ex1'],
    supportedModels: ['exclusive-model'],
    priority: 1,
    timeout: 5000,
  }));

  const { providerManager, apiKeyManager, modelRouter, healthMonitor } = require('../src/services');
  providerManager.load(tmpDir);
  apiKeyManager.load(providerManager.listProviders());
  healthMonitor.reset(); // start with clean circuit-breaker state
  modelRouter.setStrategy('priority'); // explicit default for test determinism

  await startExpress();
}

async function teardown() {
  await new Promise((r) => expressServer.close(r));
  await mockA.stop();
  await mockB.stop();
  await mockC.stop();
  await mockExclusive.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

async function testMultipleProviders() {
  // A request for shared-model should go to providerA (priority 1).
  mockA.seenKeys.length = 0;
  mockB.seenKeys.length = 0;
  const res = await chat('shared-model');
  record('request succeeds via multi-provider setup', res.status === 200, `status=${res.status}`);
  record('routed to highest-priority provider', mockA.seenKeys.length > 0, `A=${mockA.seenKeys.length}, B=${mockB.seenKeys.length}`);
}

async function testKeyRotationWithinProvider() {
  // Two keys on providerA, round-robin should alternate.
  mockA.seenKeys.length = 0;
  // Reset key manager state for deterministic rotation
  const { apiKeyManager, providerManager, healthMonitor } = require('../src/services');
  apiKeyManager.load(providerManager.listProviders());
  healthMonitor.reset();
  await chat('shared-model');
  await chat('shared-model');
  await chat('shared-model');
  await chat('shared-model');
  const keys = mockA.seenKeys;
  record('keys rotate within provider (round-robin)',
    keys.includes('key-a1') && keys.includes('key-a2'),
    `keys=${keys.join(',')}`);
  record('both keys used', new Set(keys).size >= 2, `unique=${new Set(keys).size}`);
}

async function testProviderFailoverOnAllKeysFailing() {
  // Make all keys on providerA return 429. The gateway should fail over
  // to providerB (next provider that supports shared-model).
  const { apiKeyManager, providerManager, healthMonitor } = require('../src/services');
  apiKeyManager.load(providerManager.listProviders());
  healthMonitor.reset();
  mockA.failKeys.add('key-a1');
  mockA.failKeys.add('key-a2');
  mockA.seenKeys.length = 0;
  mockB.seenKeys.length = 0;

  const res = await chat('shared-model');
  record('client gets 200 after provider failover', res.status === 200, `status=${res.status}`);
  record('providerA was tried', mockA.seenKeys.length > 0, `A_keys=${mockA.seenKeys.join(',')}`);
  record('providerB served the request', mockB.seenKeys.length > 0, `B_keys=${mockB.seenKeys.join(',')}`);

  mockA.failKeys.clear();
  // Reset state for subsequent tests
  apiKeyManager.load(providerManager.listProviders());
  healthMonitor.reset();
}

async function testModelAwareFailover() {
  // Request 'exclusive-model' — only providerExclusive serves it.
  // providerA/B/C do NOT serve exclusive-model, so they must NEVER be tried.
  const { healthMonitor } = require('../src/services');
  healthMonitor.reset();
  mockA.seenKeys.length = 0;
  mockB.seenKeys.length = 0;
  mockC.seenKeys.length = 0;
  mockExclusive.seenKeys.length = 0;

  const res = await chat('exclusive-model');
  record('exclusive-model request succeeds', res.status === 200, `status=${res.status}`);
  record('only exclusive provider is tried (model-aware)',
    mockA.seenKeys.length === 0 && mockB.seenKeys.length === 0 && mockC.seenKeys.length === 0,
    `A=${mockA.seenKeys.length},B=${mockB.seenKeys.length},C=${mockC.seenKeys.length},Ex=${mockExclusive.seenKeys.length}`);
}

async function testModelNotFound() {
  // Request a model no provider supports.
  const res = await chat('nonexistent-model');
  record('unknown model returns 404', res.status === 404, `status=${res.status}`);
  record('error code is model_not_found',
    res.body && res.body.error && res.body.error.code === 'model_not_found',
    `code=${res.body && res.body.error && res.body.error.code}`);
}

async function testNoSilentModelSubstitution() {
  // Even if providerA is down, the gateway must not substitute
  // 'exclusive-model' with 'shared-model' on providerA/B/C.
  mockExclusive.failAll(true);
  const res = await chat('exclusive-model');
  record('no silent model substitution (exclusive-model fails, not rerouted to shared-model providers)',
    res.status !== 200 || (res.body && res.body.error),
    `status=${res.status}`);
  // providerA/B/C should not have been tried for exclusive-model
  record('shared-model providers not tried for exclusive-model',
    mockA.seenKeys.length === 0 && mockB.seenKeys.length === 0,
    `A=${mockA.seenKeys.length},B=${mockB.seenKeys.length}`);
  mockExclusive.failAll(false);
}

async function testSmartRoutingPriority() {
  // With priority strategy, providerA (priority 1) should be preferred.
  const { apiKeyManager, providerManager, modelRouter, healthMonitor } = require('../src/services');
  modelRouter.setStrategy('priority');
  apiKeyManager.load(providerManager.listProviders());
  healthMonitor.reset(); // clear any open circuits from prior tests
  // Re-enable all keys (load() preserves stats/status across reloads, so
  // keys that were RATE_LIMITED by the failover test must be reactivated).
  apiKeyManager.enableKey('providerA', 'key-a1');
  apiKeyManager.enableKey('providerA', 'key-a2');
  apiKeyManager.enableKey('providerB', 'key-b1');
  apiKeyManager.enableKey('providerB', 'key-b2');
  mockA.seenKeys.length = 0;
  mockB.seenKeys.length = 0;
  await chat('shared-model');
  record('priority routing sends to providerA first', mockA.seenKeys.length > 0, `A=${mockA.seenKeys.length}`);
}

async function testSmartRoutingRoundRobin() {
  // With round-robin routing, the start provider should rotate across calls.
  const { apiKeyManager, providerManager, modelRouter, healthMonitor } = require('../src/services');
  modelRouter.setStrategy('round-robin');
  apiKeyManager.load(providerManager.listProviders());
  healthMonitor.reset();
  // Re-enable all keys (in case prior tests left some rate-limited).
  apiKeyManager.enableKey('providerA', 'key-a1');
  apiKeyManager.enableKey('providerA', 'key-a2');
  apiKeyManager.enableKey('providerB', 'key-b1');
  apiKeyManager.enableKey('providerB', 'key-b2');
  // Reset cursors
  modelRouter._cursors = {};

  mockA.seenKeys.length = 0;
  mockB.seenKeys.length = 0;
  mockC.seenKeys.length = 0;

  await chat('shared-model'); // should start at providerA
  await chat('shared-model'); // should start at providerB
  await chat('shared-model'); // should start at providerC

  // At least two different providers should have been the first hit.
  // (round-robin rotates the start of the candidate list)
  record('round-robin routing rotates across providers',
    mockA.seenKeys.length > 0 && mockB.seenKeys.length > 0,
    `A=${mockA.seenKeys.length},B=${mockB.seenKeys.length},C=${mockC.seenKeys.length}`);

  // Reset to priority for subsequent tests
  modelRouter.setStrategy('priority');
}

async function testCooldownAfterFailures() {
  // Make key-a1 fail repeatedly. After the failure threshold, it should
  // enter cooldown and be skipped.
  const { apiKeyManager, providerManager, healthMonitor } = require('../src/services');
  // Use a manager with a low threshold for fast cooldown
  apiKeyManager.load(providerManager.listProviders());
  healthMonitor.reset();

  mockA.failKeys.add('key-a1');
  mockA.seenKeys.length = 0;

  // Send several requests — key-a1 should fail and eventually be cooled down.
  for (let i = 0; i < 6; i += 1) {
    await chat('shared-model');
  }

  const status = apiKeyManager.getKeyStatus('providerA');
  const a1 = status.find((k) => k.key.endsWith('a1'));
  record('key-a1 enters cooldown/rate-limited after failures',
    a1 && (a1.status === 'COOLDOWN' || a1.status === 'RATE_LIMITED'),
    `status=${a1 && a1.status}`);

  // Clear the failure; key-a2 should now be preferred.
  mockA.failKeys.clear();
  mockA.seenKeys.length = 0;
  await chat('shared-model');
  record('after cooldown, requests use healthy key',
    !mockA.seenKeys.includes('key-a1') || a1.status === 'ACTIVE',
    `keys=${mockA.seenKeys.join(',')}`);

  // Reset state for subsequent tests
  apiKeyManager.load(providerManager.listProviders());
  healthMonitor.reset();
}

async function testAdminRoutingApi() {
  // GET /admin/api/routing
  const r = await adminGet('/routing');
  record('GET /routing returns strategy', typeof r.strategy === 'string', `strategy=${r.strategy}`);
  record('GET /routing returns available strategies', Array.isArray(r.availableStrategies) && r.availableStrategies.length >= 7, `count=${r.availableStrategies && r.availableStrategies.length}`);
  record('GET /routing returns key selection strategies', Array.isArray(r.availableKeySelectionStrategies), `count=${r.availableKeySelectionStrategies && r.availableKeySelectionStrategies.length}`);

  // PUT /admin/api/routing — change strategy
  const updated = await adminPut('/routing', { strategy: 'round-robin' });
  record('PUT /routing succeeds', updated.success === true, `success=${updated.success}`);
  record('routing strategy changed to round-robin', updated.strategy === 'round-robin', `strategy=${updated.strategy}`);

  // Change back to priority
  await adminPut('/routing', { strategy: 'priority' });
  const r2 = await adminGet('/routing');
  record('routing strategy reverted to priority', r2.strategy === 'priority', `strategy=${r2.strategy}`);
}

async function testAdminKeyHealthApi() {
  // GET /admin/api/providers/providerA/keys
  const r = await adminGet('/providers/providerA/keys');
  record('GET /providers/:id/keys returns key list', Array.isArray(r.keys) && r.keys.length === 2, `count=${r.keys && r.keys.length}`);
  const k = r.keys[0];
  record('key health has status', typeof k.status === 'string', `status=${k.status}`);
  record('key health has stats', typeof k.stats === 'object', `stats=${!!k.stats}`);
  record('key health has averageLatencyMs', 'averageLatencyMs' in k.stats, `latency=${k.stats.averageLatencyMs}`);
  record('key health has totalRequests', 'totalRequests' in k.stats, `reqs=${k.stats.totalRequests}`);
  record('key health has successRate', 'successRate' in k.stats, `rate=${k.stats.successRate}`);
}

async function testAdminKeyDisableEnable() {
  // Disable key-a1 via admin API, verify it's skipped.
  const res = await adminPost('/providers/providerA/keys/disable', { key: 'key-a1' });
  record('POST /keys/disable succeeds', res.success === true, `success=${res.success}`);

  mockA.seenKeys.length = 0;
  const { apiKeyManager, providerManager, healthMonitor } = require('../src/services');
  apiKeyManager.load(providerManager.listProviders()); // reset
  healthMonitor.reset(); // clear open circuits
  // Re-disable after reload (reload resets state)
  await adminPost('/providers/providerA/keys/disable', { key: 'key-a1' });

  await chat('shared-model');
  await chat('shared-model');
  record('disabled key is skipped', !mockA.seenKeys.includes('key-a1'), `keys=${mockA.seenKeys.join(',')}`);

  // Re-enable
  await adminPost('/providers/providerA/keys/enable', { key: 'key-a1' });
  mockA.seenKeys.length = 0;
  await chat('shared-model');
  await chat('shared-model');
  await chat('shared-model');
  await chat('shared-model');
  record('re-enabled key is used again', mockA.seenKeys.includes('key-a1'), `keys=${mockA.seenKeys.join(',')}`);
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------
async function main() {
  console.log('=== Multi-Provider Gateway Integration Tests ===\n');
  await setup();

  try {
    await testMultipleProviders();
    await testKeyRotationWithinProvider();
    await testProviderFailoverOnAllKeysFailing();
    await testModelAwareFailover();
    await testModelNotFound();
    await testNoSilentModelSubstitution();
    await testSmartRoutingPriority();
    await testSmartRoutingRoundRobin();
    await testCooldownAfterFailures();
    await testAdminRoutingApi();
    await testAdminKeyHealthApi();
    await testAdminKeyDisableEnable();
  } finally {
    await teardown();
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
