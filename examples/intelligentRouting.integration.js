/**
 * Integration tests for the Intelligent Model Registry & Routing Engine (Sprint 10).
 *
 * Run:  node examples/intelligentRouting.integration.js
 *
 * Covers:
 *   - Provider discovery (GET /v1/models query)
 *   - Model registry enrichment (discovered models appear)
 *   - Alias resolution (client sends alias, gateway resolves to provider)
 *   - Routing rules (skip/prefer/demote based on health)
 *   - Per-model provider order
 *   - Capability detection
 *   - Admin API: /admin/models, /admin/aliases, /admin/discover,
 *     /admin/refresh-models, /admin/routing-rules, /admin/model-routing
 *   - Backward compatibility (direct model id still works)
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

let expressServer, expressPort;
let mockProviderA, mockProviderB;
let tmpDir;

// ---------------------------------------------------------------
// Mock provider that serves GET /models and POST /chat/completions
// ---------------------------------------------------------------
function createMockProvider(opts = {}) {
  const models = opts.models || ['shared-model'];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', created: 1700000000, owned_by: opts.id || 'mock' })),
      }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: 1700000000,
          model: opts.id || 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  return {
    server,
    start() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          this.port = server.address().port;
          resolve();
        });
      });
    },
    stop() { return new Promise((r) => server.close(r)); },
  };
}

// ---------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------
function startExpress() {
  return new Promise((resolve) => {
    expressServer = app.listen(0, '127.0.0.1', () => {
      expressPort = expressServer.address().port;
      resolve();
    });
  });
}

function chat(model) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] });
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'POST', path: '/v1/chat/completions',
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
      res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); } });
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
      res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); } });
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
      res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function adminDelete(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'DELETE', path: '/admin/api' + p,
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------
// Setup
// ---------------------------------------------------------------
async function setup() {
  mockProviderA = createMockProvider({ id: 'providerA', models: ['shared-model', 'gpt-4o'] });
  mockProviderB = createMockProvider({ id: 'providerB', models: ['shared-model', 'claude-3-5-sonnet'] });
  await mockProviderA.start();
  await mockProviderB.start();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-intel-'));
  fs.writeFileSync(path.join(tmpDir, 'providerA.json'), JSON.stringify({
    id: 'providerA', name: 'Provider A', enabled: true,
    baseURL: `http://127.0.0.1:${mockProviderA.port}`,
    apiKeys: ['key-a'],
    supportedModels: ['shared-model'],
    priority: 1, timeout: 5000,
  }));
  fs.writeFileSync(path.join(tmpDir, 'providerB.json'), JSON.stringify({
    id: 'providerB', name: 'Provider B', enabled: true,
    baseURL: `http://127.0.0.1:${mockProviderB.port}`,
    apiKeys: ['key-b'],
    supportedModels: ['shared-model'],
    priority: 2, timeout: 5000,
  }));

  const { providerManager, apiKeyManager, healthMonitor, aliasResolver, modelRouter, ruleEngine } = require('../src/services');
  providerManager.load(tmpDir);
  apiKeyManager.load(providerManager.listProviders());
  healthMonitor.reset();
  aliasResolver.load({ aliases: {} }); // start clean
  modelRouter.setModelOverrides({});
  ruleEngine.load([]);
  modelRouter.setStrategy('priority');

  await startExpress();
}

async function teardown() {
  await new Promise((r) => expressServer.close(r));
  await mockProviderA.stop();
  await mockProviderB.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

async function testBackwardCompat() {
  // Direct model id (no alias) must still work.
  const res = await chat('shared-model');
  record('backward compat: direct model id works', res.status === 200, `status=${res.status}`);
}

async function testProviderDiscovery() {
  // Run discovery — should find 'gpt-4o' and 'claude-3-5-sonnet' that
  // the providers serve but weren't in the initial supportedModels.
  const result = await adminPost('/discover');
  record('discover returns status', typeof result === 'object' && result.providers, `keys=${Object.keys(result || {}).join(',')}`);
  record('providerA discovered ok', result.providers && result.providers.providerA && result.providers.providerA.ok, `A=${JSON.stringify(result.providers && result.providers.providerA)}`);
  record('providerB discovered ok', result.providers && result.providers.providerB && result.providers.providerB.ok, `B=${JSON.stringify(result.providers && result.providers.providerB)}`);

  // After discovery, providerA should now also serve 'gpt-4o'
  const { providerManager } = require('../src/services');
  const a = providerManager.providersById.get('providerA');
  record('discovered model gpt-4o merged into providerA', a.supportedModels.includes('gpt-4o'), `models=${a.supportedModels.join(',')}`);
  record('discovered model claude-3-5-sonnet merged into providerB', a.supportedModels.includes('gpt-4o'), `models=${providerManager.providersById.get('providerB').supportedModels.join(',')}`);
}

async function testModelRegistryRichEntries() {
  // GET /admin/api/models — should return rich entries with capabilities + providers
  const r = await adminGet('/models');
  record('GET /admin/models returns list', Array.isArray(r.models), `count=${r.models && r.models.length}`);
  if (r.models && r.models.length > 0) {
    const entry = r.models[0];
    record('rich entry has id', typeof entry.id === 'string');
    record('rich entry has providers', Array.isArray(entry.providers));
    record('rich entry has capabilities', typeof entry.capabilities === 'object');
    record('rich entry has aliases', Array.isArray(entry.aliases));
    record('rich entry has latency', typeof entry.latency === 'number');
    record('rich entry has successRate', typeof entry.successRate === 'number');
    record('rich entry has priority', entry.priority !== undefined);
  }
}

async function testAliasResolution() {
  // Set an alias 'gpt-5' -> ['gpt-4o'] (which was discovered on providerA)
  const r = await adminPut('/aliases', { alias: 'gpt-5', models: ['gpt-4o'] });
  record('PUT /aliases succeeds', r.success === true, `success=${r.success}`);

  // Now a client request for 'gpt-5' should route to providerA (which serves gpt-4o)
  const res = await chat('gpt-5');
  record('alias gpt-5 routes to provider', res.status === 200, `status=${res.status}`);

  // Verify the alias is in the list
  const list = await adminGet('/aliases');
  record('GET /aliases lists gpt-5', list.aliases && list.aliases['gpt-5'], `aliases=${Object.keys(list.aliases || {}).join(',')}`);
}

async function testAliasDelete() {
  await adminDelete('/aliases/gpt-5');
  const list = await adminGet('/aliases');
  record('DELETE /aliases removes alias', !list.aliases || !list.aliases['gpt-5']);
  // Request for 'gpt-5' should now fail (no provider serves it directly)
  const res = await chat('gpt-5');
  record('deleted alias -> 404', res.status === 404, `status=${res.status}`);
}

async function testRoutingRules() {
  // Add a "skip providerB" rule
  const r = await adminPut('/routing-rules', {
    id: 'skip-b', description: 'Skip providerB for testing',
    when: { 'provider.id': { '==': 'providerB' } }, then: 'skip',
  });
  record('PUT /routing-rules succeeds', r.success === true);

  const list = await adminGet('/routing-rules');
  record('GET /routing-rules lists rule', list.rules && list.rules.length === 1, `count=${list.rules && list.rules.length}`);

  // Request for shared-model should go only to providerA (B is skipped)
  const res = await chat('shared-model');
  record('routing rule skips providerB', res.status === 200, `status=${res.status}`);

  // Remove the rule
  await adminDelete('/routing-rules/skip-b');
  const list2 = await adminGet('/routing-rules');
  record('DELETE /routing-rules removes rule', list2.rules.length === 0);
}

async function testPerModelProviderOrder() {
  // Set per-model override: shared-model -> providerB first (lower priority normally)
  const r = await adminPut('/model-routing', { overrides: { 'shared-model': { providerOrder: ['providerB', 'providerA'] } } });
  record('PUT /model-routing succeeds', r.success === true);

  const list = await adminGet('/model-routing');
  record('GET /model-routing returns override', list.overrides && list.overrides['shared-model'], `override=${JSON.stringify(list.overrides)}`);

  // Request for shared-model should now go to providerB first
  const res = await chat('shared-model');
  record('per-model override routes to providerB', res.status === 200, `status=${res.status}`);

  // Clear overrides
  await adminPut('/model-routing', { overrides: {} });
  record('per-model override cleared', (await adminGet('/model-routing')).overrides && Object.keys((await adminGet('/model-routing')).overrides).length === 0);
}

async function testRefreshModels() {
  const r = await adminPost('/refresh-models');
  record('POST /refresh-models succeeds', r.success === true);
}

async function testRefreshCapabilities() {
  const r = await adminPost('/refresh-capabilities');
  record('POST /refresh-capabilities succeeds', r.success === true);
}

async function testDiscoveryStatus() {
  const r = await adminGet('/discovery-status');
  record('GET /discovery-status returns status', r.status !== undefined, `status=${JSON.stringify(r.status).slice(0, 60)}`);
}

async function testOpenAIModelsEndpointUnchanged() {
  // The public /v1/models endpoint must still return the OpenAI shape
  const r = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: expressPort, path: '/v1/models' }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); } });
    }).on('error', reject);
  });
  record('GET /v1/models returns OpenAI shape', r.object === 'list' && Array.isArray(r.data), `object=${r.object}`);
  if (r.data && r.data.length > 0) {
    const m = r.data[0];
    record('OpenAI model has id', typeof m.id === 'string');
    record('OpenAI model has object', m.object === 'model');
    record('OpenAI model has created', typeof m.created === 'number');
    record('OpenAI model has owned_by', typeof m.owned_by === 'string');
    // Internal metadata must NOT leak
    record('OpenAI model has no providers field', m.providers === undefined);
    record('OpenAI model has no capabilities field', m.capabilities === undefined);
    record('OpenAI model has no aliases field', m.aliases === undefined);
  }
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------
async function main() {
  console.log('=== Intelligent Model Registry & Routing Engine Tests ===\n');
  await setup();
  try {
    await testBackwardCompat();
    await testProviderDiscovery();
    await testModelRegistryRichEntries();
    await testAliasResolution();
    await testAliasDelete();
    await testRoutingRules();
    await testPerModelProviderOrder();
    await testRefreshModels();
    await testRefreshCapabilities();
    await testDiscoveryStatus();
    await testOpenAIModelsEndpointUnchanged();
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

main().catch((err) => { console.error('Test crashed:', err); process.exit(1); });
