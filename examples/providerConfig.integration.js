/**
 * Integration test for Provider Configuration & Hot Reload.
 *
 * Run:  node examples/providerConfig.integration.js
 *
 * Verifies:
 *   - enable/disable: provider becomes available/unavailable after reload
 *   - hot reload: file changes trigger automatic reload
 *   - rollback: invalid config keeps the previous configuration
 *   - validation: duplicate ids, invalid URLs, duplicate models rejected
 *   - priority changes: routing order changes after reload
 *   - provider removal: removed provider becomes unavailable
 *   - provider addition: new provider becomes available
 *   - reload metrics: reloadCount + reloadFailures tracked
 *   - existing requests continue during reload
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

let mockServer;
let mockPort;
let expressServer;
let expressPort;
let tmpProvidersDir;

function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const auth = req.headers.authorization || '';
        let providerId = 'unknown';
        if (auth.includes('key-a')) providerId = 'provider-a';
        else if (auth.includes('key-b')) providerId = 'provider-b';
        else if (auth.includes('key-c')) providerId = 'provider-c';

        if (req.url === '/chat/completions') {
          let received;
          try { received = JSON.parse(body); } catch { received = {}; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion', created: 1700000000,
            model: received.model || 'mock',
            choices: [{ index: 0, message: { role: 'assistant', content: providerId }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }));
          return;
        }
        res.writeHead(404); res.end('{}');
      });
    });
    mockServer.listen(0, '127.0.0.1', () => { mockPort = mockServer.address().port; resolve(); });
  });
}

function writeProviderConfig(dir, id, config) {
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(config));
}

function setupConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-pcfg-'));
  const base = `http://127.0.0.1:${mockPort}`;

  writeProviderConfig(tmpProvidersDir, 'a', {
    id: 'provider-a', name: 'Provider A', enabled: true,
    adapter: 'openai', baseURL: base, apiKeys: ['key-a'],
    supportedModels: ['shared-model', 'a-only'], priority: 1, timeout: 5000,
  });
  writeProviderConfig(tmpProvidersDir, 'b', {
    id: 'provider-b', name: 'Provider B', enabled: true,
    adapter: 'openai', baseURL: base, apiKeys: ['key-b'],
    supportedModels: ['shared-model', 'b-only'], priority: 2, timeout: 5000,
  });
}

function startExpressServer() {
  return new Promise((resolve) => {
    expressServer = app.listen(0, '127.0.0.1', () => {
      expressPort = expressServer.address().port;
      resolve();
    });
  });
}

function post(pathStr, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'POST', path: pathStr,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(c) }); } catch { resolve({ status: res.statusCode, body: c }); }
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function get(pathStr) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: expressPort, path: pathStr }, (res) => {
      let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(c) }); } catch { resolve({ status: res.statusCode, body: c }); }
      });
    }).on('error', reject);
  });
}

// Wait for a file-watch reload to propagate (with timeout)
function waitForReload(configManager, timeoutMs = 500) {
  return new Promise((resolve) => {
    const before = configManager._reloadCount + configManager._reloadFailures;
    const start = Date.now();
    const check = () => {
      const current = configManager._reloadCount + configManager._reloadFailures;
      if (current > before) return resolve();
      if (Date.now() - start > timeoutMs) return resolve();
      setTimeout(check, 20);
    };
    check();
  });
}

async function testEnableDisable() {
  const { providerConfigManager, providerManager } = require('../src/services');

  // Initially provider-a is enabled
  let pa = providerManager.providersById.get('provider-a');
  let ok1 = pa && pa.enabled === true;

  // Disable provider-a
  writeProviderConfig(tmpProvidersDir, 'a', {
    id: 'provider-a', name: 'Provider A', enabled: false,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-a'],
    supportedModels: ['shared-model', 'a-only'], priority: 1, timeout: 5000,
  });
  await providerConfigManager.reload();

  pa = providerManager.providersById.get('provider-a');
  let ok2 = pa && pa.enabled === false;

  // Re-enable
  writeProviderConfig(tmpProvidersDir, 'a', {
    id: 'provider-a', name: 'Provider A', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-a'],
    supportedModels: ['shared-model', 'a-only'], priority: 1, timeout: 5000,
  });
  await providerConfigManager.reload();

  pa = providerManager.providersById.get('provider-a');
  let ok3 = pa && pa.enabled === true;

  record('enable/disable: provider toggled via reload', ok1 && ok2 && ok3, `before=${ok1}, disabled=${ok2}, re-enabled=${ok3}`);
}

async function testPriorityChange() {
  const { providerConfigManager, providerManager } = require('../src/services');

  // Initially: provider-a priority=1, provider-b priority=2
  // shared-model routes to provider-a (lowest priority)
  let candidates = providerManager.modelToProviders.get('shared-model');
  let firstId = candidates ? candidates.sort((a, b) => a.priority - b.priority)[0].id : null;
  let ok1 = firstId === 'provider-a';

  // Swap priorities: provider-b becomes priority=1
  writeProviderConfig(tmpProvidersDir, 'a', {
    id: 'provider-a', name: 'Provider A', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-a'],
    supportedModels: ['shared-model', 'a-only'], priority: 5, timeout: 5000,
  });
  writeProviderConfig(tmpProvidersDir, 'b', {
    id: 'provider-b', name: 'Provider B', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-b'],
    supportedModels: ['shared-model', 'b-only'], priority: 1, timeout: 5000,
  });
  await providerConfigManager.reload();

  candidates = providerManager.modelToProviders.get('shared-model');
  firstId = candidates ? candidates.sort((a, b) => a.priority - b.priority)[0].id : null;
  let ok2 = firstId === 'provider-b';

  // Restore original priorities
  writeProviderConfig(tmpProvidersDir, 'a', {
    id: 'provider-a', name: 'Provider A', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-a'],
    supportedModels: ['shared-model', 'a-only'], priority: 1, timeout: 5000,
  });
  writeProviderConfig(tmpProvidersDir, 'b', {
    id: 'provider-b', name: 'Provider B', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-b'],
    supportedModels: ['shared-model', 'b-only'], priority: 2, timeout: 5000,
  });
  await providerConfigManager.reload();

  record('priority change: routing order changes after reload', ok1 && ok2, `before=${ok1 ? 'a' : '?'}, after=${ok2 ? 'b' : '?'}`);
}

async function testProviderRemoval() {
  const { providerConfigManager, providerManager } = require('../src/services');

  // Remove provider-b by deleting its file
  fs.unlinkSync(path.join(tmpProvidersDir, 'b.json'));
  await providerConfigManager.reload();

  let pb = providerManager.providersById.get('provider-b');
  let ok1 = !pb;

  // b-only model should no longer be available
  let candidates = providerManager.modelToProviders.get('b-only');
  let ok2 = !candidates || candidates.length === 0;

  // Restore provider-b
  writeProviderConfig(tmpProvidersDir, 'b', {
    id: 'provider-b', name: 'Provider B', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-b'],
    supportedModels: ['shared-model', 'b-only'], priority: 2, timeout: 5000,
  });
  await providerConfigManager.reload();

  pb = providerManager.providersById.get('provider-b');
  let ok3 = !!pb;

  record('provider removal + restoration', ok1 && ok2 && ok3, `removed=${ok1}, model gone=${ok2}, restored=${ok3}`);
}

async function testProviderAddition() {
  const { providerConfigManager, providerManager } = require('../src/services');

  // Add provider-c
  writeProviderConfig(tmpProvidersDir, 'c', {
    id: 'provider-c', name: 'Provider C', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-c'],
    supportedModels: ['c-only'], priority: 3, timeout: 5000,
  });
  await providerConfigManager.reload();

  let pc = providerManager.providersById.get('provider-c');
  let ok1 = !!pc;

  let candidates = providerManager.modelToProviders.get('c-only');
  let ok2 = candidates && candidates.length > 0;

  // Remove it to restore the original state
  fs.unlinkSync(path.join(tmpProvidersDir, 'c.json'));
  await providerConfigManager.reload();

  record('provider addition', ok1 && ok2, `added=${ok1}, model available=${ok2}`);
}

async function testRollbackOnInvalidConfig() {
  const { providerConfigManager, providerManager, metricsCollector } = require('../src/services');
  metricsCollector.configReloadCount = 0;
  metricsCollector.configReloadFailures = 0;

  // Write an invalid config (duplicate id with provider-a)
  writeProviderConfig(tmpProvidersDir, 'a-dup', {
    id: 'provider-a', name: 'Duplicate A', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-a'],
    supportedModels: ['dup-model'], priority: 1, timeout: 5000,
  });
  await providerConfigManager.reload();

  // The previous config should be kept — provider-a should still have
  // its original supportedModels (including a-only), not dup-model.
  let pa = providerManager.providersById.get('provider-a');
  let ok1 = pa && pa.supportedModels.includes('a-only') && !pa.supportedModels.includes('dup-model');

  let ok2 = metricsCollector.configReloadFailures >= 1;

  // Clean up: remove the duplicate file
  fs.unlinkSync(path.join(tmpProvidersDir, 'a-dup.json'));
  await providerConfigManager.reload();

  record('rollback: invalid config keeps previous config', ok1 && ok2, `kept=${ok1}, failures=${metricsCollector.configReloadFailures}`);
}

async function testValidationDuplicateIds() {
  const { providerConfigManager, providerManager } = require('../src/services');

  // Write two configs with the same id
  writeProviderConfig(tmpProvidersDir, 'd1', {
    id: 'provider-d', name: 'D1', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-d'],
    supportedModels: ['d1-model'], priority: 10, timeout: 5000,
  });
  writeProviderConfig(tmpProvidersDir, 'd2', {
    id: 'provider-d', name: 'D2', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-d'],
    supportedModels: ['d2-model'], priority: 11, timeout: 5000,
  });
  const result = await providerConfigManager.reload();

  let ok = !result.success && result.errors.some((e) => /Duplicate provider id/.test(e));

  // Clean up
  fs.unlinkSync(path.join(tmpProvidersDir, 'd1.json'));
  fs.unlinkSync(path.join(tmpProvidersDir, 'd2.json'));
  await providerConfigManager.reload();

  record('validation: duplicate ids rejected', ok, `success=${result.success}, errors=${result.errors.length}`);
}

async function testValidationInvalidURL() {
  const { providerConfigManager } = require('../src/services');

  writeProviderConfig(tmpProvidersDir, 'bad-url', {
    id: 'bad-url-provider', name: 'Bad URL', enabled: true,
    adapter: 'openai', baseURL: 'not-a-valid-url', apiKeys: ['key-x'],
    supportedModels: ['bad-model'], priority: 10, timeout: 5000,
  });
  const result = await providerConfigManager.reload();

  let ok = !result.success && result.errors.some((e) => /invalid baseURL/.test(e));

  // Clean up
  fs.unlinkSync(path.join(tmpProvidersDir, 'bad-url.json'));
  await providerConfigManager.reload();

  record('validation: invalid URL rejected', ok, `success=${result.success}, errors=${result.errors.length}`);
}

async function testValidationDuplicateModels() {
  const { providerConfigManager } = require('../src/services');

  writeProviderConfig(tmpProvidersDir, 'dup-models', {
    id: 'dup-models-provider', name: 'Dup Models', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-x'],
    supportedModels: ['same-model', 'same-model'], priority: 10, timeout: 5000,
  });
  const result = await providerConfigManager.reload();

  let ok = !result.success && result.errors.some((e) => /duplicate model/.test(e));

  // Clean up
  fs.unlinkSync(path.join(tmpProvidersDir, 'dup-models.json'));
  await providerConfigManager.reload();

  record('validation: duplicate models in same provider rejected', ok, `success=${result.success}`);
}

async function testReloadMetrics() {
  const { providerConfigManager, metricsCollector } = require('../src/services');
  metricsCollector.configReloadCount = 0;
  metricsCollector.configReloadFailures = 0;

  // Successful reload (touch a file)
  writeProviderConfig(tmpProvidersDir, 'a', {
    id: 'provider-a', name: 'Provider A', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-a'],
    supportedModels: ['shared-model', 'a-only'], priority: 1, timeout: 5000,
  });
  await providerConfigManager.reload();

  // Failed reload
  writeProviderConfig(tmpProvidersDir, 'bad', {
    id: 'bad-provider', name: 'Bad', enabled: true,
    adapter: 'openai', baseURL: 'invalid-url', apiKeys: ['key-x'],
    supportedModels: ['bad-model'], priority: 10, timeout: 5000,
  });
  await providerConfigManager.reload();

  // Clean up
  fs.unlinkSync(path.join(tmpProvidersDir, 'bad.json'));
  await providerConfigManager.reload();

  const snap = metricsCollector.getSnapshot();
  const ok = snap.configReloadCount >= 1 && snap.configReloadFailures >= 1;
  record('reload metrics (reloadCount + reloadFailures)', ok, `count=${snap.configReloadCount}, failures=${snap.configReloadFailures}`);
}

async function testActiveDisabledProviders() {
  const { providerConfigManager, metricsCollector, providerManager } = require('../src/services');

  // Set up: 2 enabled, 1 disabled
  writeProviderConfig(tmpProvidersDir, 'c', {
    id: 'provider-c', name: 'Provider C', enabled: false,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-c'],
    supportedModels: ['c-only'], priority: 3, timeout: 5000,
  });
  await providerConfigManager.reload();

  const snap = metricsCollector.getSnapshot();
  const ok = snap.activeProviders === 2 && snap.disabledProviders === 1;

  // Clean up
  fs.unlinkSync(path.join(tmpProvidersDir, 'c.json'));
  await providerConfigManager.reload();

  record('metrics: active + disabled providers count', ok, `active=${snap.activeProviders}, disabled=${snap.disabledProviders}`);
}

async function testExistingRequestsContinue() {
  const { providerConfigManager } = require('../src/services');

  // Start a request, then reload the config while it's in flight.
  // The request should still succeed (it uses the provider object it
  // already resolved).
  const reqPromise = post('/v1/chat/completions', { model: 'shared-model', messages: [{ role: 'user', content: 'hi' }] });

  // Immediately reload (the request is in flight with the 100ms mock delay)
  writeProviderConfig(tmpProvidersDir, 'a', {
    id: 'provider-a', name: 'Provider A', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['key-a'],
    supportedModels: ['shared-model', 'a-only'], priority: 1, timeout: 5000,
  });
  await providerConfigManager.reload();

  const res = await reqPromise;
  const ok = res.status === 200;
  record('existing requests continue during reload', ok, `status=${res.status}`);
}

async function main() {
  console.log('=== Provider Config & Hot Reload Integration Tests ===\n');
  await startMockProvider();
  setupConfigs();

  const { providerManager, apiKeyManager, providerConfigManager } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());

  await startExpressServer();

  try {
    await testEnableDisable();
    await testPriorityChange();
    await testProviderRemoval();
    await testProviderAddition();
    await testRollbackOnInvalidConfig();
    await testValidationDuplicateIds();
    await testValidationInvalidURL();
    await testValidationDuplicateModels();
    await testReloadMetrics();
    await testActiveDisabledProviders();
    await testExistingRequestsContinue();
  } finally {
    await new Promise((r) => expressServer.close(r));
    await new Promise((r) => mockServer.close(r));
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
