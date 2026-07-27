/**
 * Integration tests for Virtual Models & Intelligent Routing (Sprint 11).
 *
 * Run:  node examples/virtualModels.integration.js
 *
 * Covers the full Sprint 11 acceptance criteria end-to-end via the real
 * Express app, admin API, mock providers, and the live request pipeline:
 *
 *   ✓ Admin API: GET / POST / PUT / DELETE + toggle + list
 *   ✓ Validation before save (invalid POST/PUT rejected, nothing persisted)
 *   ✓ Persistence to config/virtualModels.json (round-trip on disk)
 *   ✓ Hot reload without restart (file change → runtime swap)
 *   ✓ OpenAI compatibility: client sends model=virtual-id; gateway resolves
 *     Virtual Model → Real Model → Provider → API Key without client changes
 *   ✓ /v1/models lists virtual models alongside real models
 *   ✓ Automatic routing via every selection strategy
 *   ✓ Automatic failover across candidates of the SAME virtual model
 *   ✓ Failover never routes to a provider that doesn't support the vm
 *   ✓ Backward compatibility: a real model id still works unchanged
 *   ✓ Metrics: virtual model usage, provider chosen, fallback count,
 *     routing decision, latency, success rate
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Run in test mode: skips morgan logging + config-file watching (which would
// otherwise watch the real config/providers dir and reload state mid-test).
process.env.NODE_ENV = 'test';
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
let mockA, mockB, mockC;
let tmpDir, vmFile;

// ---------------------------------------------------------------
// Mock provider: returns its own id as the model + records which
// provider served the request (so the test can assert failover).
// configurable 5xx to simulate a failing provider.
// ---------------------------------------------------------------
function createMockProvider(opts = {}) {
  const id = opts.id;
  let failMode = opts.fail ? 'fail' : null;
  const server = http.createServer((req, res) => {
    if (opts.onRequest) opts.onRequest(req);
    if (req.method === 'GET' && req.url === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: (opts.models || []).map((m) => ({ id: m, object: 'model', created: 1700000000, owned_by: id })),
      }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (failMode === 'fail') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock failure', type: 'server_error' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-' + id,
          object: 'chat.completion',
          created: 1700000000,
          model: id + '-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'served-by:' + id }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });
  return {
    id, server,
    start() { return new Promise((r) => server.listen(0, '127.0.0.1', () => { this.port = server.address().port; r(); })); },
    stop() { return new Promise((r) => server.close(r)); },
    setFail(f) { failMode = f ? 'fail' : null; },
  };
}

// ---------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------
function startExpress() {
  return new Promise((r) => {
    expressServer = app.listen(0, '127.0.0.1', () => {
      expressPort = expressServer.address().port;
      r();
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
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); } catch { resolve({ status: res.statusCode, body: chunks }); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function modelsList() {
  return new Promise((r, rej) => {
    http.get({ host: '127.0.0.1', port: expressPort, path: '/v1/models' }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { r(JSON.parse(d)); } catch { r(d); } });
    }).on('error', rej);
  });
}

function adminGet(p) {
  return new Promise((r, rej) => {
    http.get({ host: '127.0.0.1', port: expressPort, path: '/admin/api' + p }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { r({ status: res.statusCode, body: JSON.parse(d) }); } catch { r({ status: res.statusCode, body: d }); } });
    }).on('error', rej);
  });
}

function adminJson(p, method, body) {
  return new Promise((r, rej) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = body != null ? { 'Content-Type': 'application/json' } : {};
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port: expressPort, method, path: '/admin/api' + p, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { r({ status: res.statusCode, body: JSON.parse(d) }); } catch { r({ status: res.statusCode, body: d }); } });
    });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}

const adminPost = (p, b) => adminJson(p, 'POST', b);
const adminPut = (p, b) => adminJson(p, 'PUT', b);
const adminDelete = (p) => adminJson(p, 'DELETE', null);

// ---------------------------------------------------------------
// Setup
// ---------------------------------------------------------------
async function setup() {
  mockA = createMockProvider({ id: 'providerA', models: ['glm-5.2'] });
  mockB = createMockProvider({ id: 'providerB', models: ['deepseek-v3'] });
  mockC = createMockProvider({ id: 'providerC', models: ['qwen-coder'] });
  await Promise.all([mockA.start(), mockB.start(), mockC.start()]);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-vm-'));
  // Keep providers in their own subdir so config/virtualModels.json (which
  // loadProviders globs as *.json) is NOT parsed as a provider config.
  const pDir = path.join(tmpDir, 'providers');
  fs.mkdirSync(pDir, { recursive: true });
  fs.writeFileSync(path.join(pDir, 'providerA.json'), JSON.stringify({
    id: 'providerA', name: 'A', enabled: true,
    baseURL: `http://127.0.0.1:${mockA.port}`,
    apiKeys: ['key-a'], supportedModels: ['glm-5.2'], priority: 1, timeout: 5000,
  }));
  fs.writeFileSync(path.join(pDir, 'providerB.json'), JSON.stringify({
    id: 'providerB', name: 'B', enabled: true,
    baseURL: `http://127.0.0.1:${mockB.port}`,
    apiKeys: ['key-b'], supportedModels: ['deepseek-v3'], priority: 2, timeout: 5000,
  }));
  fs.writeFileSync(path.join(pDir, 'providerC.json'), JSON.stringify({
    id: 'providerC', name: 'C', enabled: true,
    baseURL: `http://127.0.0.1:${mockC.port}`,
    apiKeys: ['key-c'], supportedModels: ['qwen-coder'], priority: 3, timeout: 5000,
  }));

  vmFile = path.join(tmpDir, 'virtualModels.json');
  fs.writeFileSync(vmFile, JSON.stringify({ virtualModels: {} }));
  process.env.VIRTUAL_MODELS_CONFIG_FILE = vmFile;
  // Point the providers at our tmp dir + reset shared services.
  process.env.PROVIDERS_CONFIG_DIR = pDir;

  // The app was already built (module-level Services singleton) — reload the
  // virtual model registry from the (empty) tmp file and the providers from
  // the tmp dir so the integration suite runs against a clean state.
  const services = require('../src/services');
  services.providerManager.load(pDir);
  services.apiKeyManager.load(services.providerManager.listProviders());
  services.healthMonitor.reset();
  services.virtualModelRegistry.load({ virtualModels: {} });
  services.modelRegistry.invalidate();

  await startExpress();
}

async function teardown() {
  await new Promise((r) => expressServer.close(r));
  await Promise.all([mockA.stop(), mockB.stop(), mockC.stop()]);
  delete process.env.VIRTUAL_MODELS_CONFIG_FILE;
  delete process.env.PROVIDERS_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ============================================================
// Tests
// ============================================================

async function testBackwardCompat() {
  const r = await chat('glm-5.2');
  record('backward compat: real model id glm-5.2 works', r.status === 200, `status=${r.status}`);
  record('backward compat: served by providerA', /served-by:providerA/.test(JSON.stringify(r.body)), 'body not from A');
  const r2 = await chat('qwen-coder');
  record('backward compat: real model id qwen-coder works', r2.status === 200, `status=${r2.status}`);
}

async function testCreateAndResolveVirtualModel() {
  const r = await adminPost('/virtual-models', {
    id: 'coding-fast', enabled: true, strategy: 'priority',
    candidates: [
      { provider: 'providerA', model: 'glm-5.2', priority: 1 },
      { provider: 'providerB', model: 'deepseek-v3', priority: 2 },
      { provider: 'providerC', model: 'qwen-coder', priority: 3 },
    ],
  });
  record('POST /virtual-models creates (201)', r.status === 201, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 160)}`);

  const list = await adminGet('/virtual-models');
  record('GET /virtual-models lists the new vm', (list.body.virtualModels || []).some((v) => v.id === 'coding-fast'), 'count=' + (list.body.virtualModels || []).length);

  const one = await adminGet('/virtual-models/coding-fast');
  record('GET /virtual-models/:id returns the vm', one.status === 200 && one.body.virtualModel.id === 'coding-fast', `status=${one.status}`);

  const chatR = await chat('coding-fast');
  record('OpenAI-compat: client sent model=coding-fast (virtual), got 200', chatR.status === 200, `status=${chatR.status}`);
  record('OpenAI-compat: routed to highest-priority candidate (providerA)', /served-by:providerA/.test(JSON.stringify(chatR.body)), JSON.stringify(chatR.body).slice(0, 120));
}

async function testValidationBeforeSave() {
  const before = (await adminGet('/virtual-models')).body.virtualModels.length;
  // Invalid: empty candidates
  const r = await adminPost('/virtual-models', { id: 'bad-vm', candidates: [] });
  record('POST invalid virtual model rejected (400)', r.status === 400, `status=${r.status}`);
  const after = (await adminGet('/virtual-models')).body.virtualModels.length;
  record('invalid POST did not change the registry', before === after, `before=${before} after=${after}`);

  // Invalid: unknown strategy
  const r2 = await adminPost('/virtual-models', { id: 'bad-vm2', strategy: 'telepathy', candidates: [{ provider: 'providerA', model: 'glm-5.2' }] });
  record('POST invalid strategy rejected (400)', r2.status === 400, `status=${r2.status}`);

  // Duplicate id
  const r3 = await adminPost('/virtual-models', { id: 'coding-fast', candidates: [{ provider: 'providerA', model: 'glm-5.2' }] });
  record('POST duplicate id rejected (409)', r3.status === 409, `status=${r3.status}.body=${JSON.stringify(r3.body).slice(0,80)}`);

  // Disk file was NOT corrupted by an invalid save
  const disk = process.env.VIRTUAL_MODELS_CONFIG_FILE;
  if (fs.existsSync(disk)) {
    const onDisk = JSON.parse(fs.readFileSync(disk, 'utf8'));
    record('persistence: invalid POST did not write bad vm to disk', !onDisk.virtualModels['bad-vm'] && !onDisk.virtualModels['bad-vm2'], 'keys=' + Object.keys(onDisk.virtualModels).join(','));
  }
}

async function testPersistenceRoundTrip() {
  const onDisk = JSON.parse(fs.readFileSync(process.env.VIRTUAL_MODELS_CONFIG_FILE, 'utf8'));
  record('persistence: coding-fast written to disk', !!onDisk.virtualModels['coding-fast'], 'keys=' + Object.keys(onDisk.virtualModels).join(','));
  eqshape(onDisk.virtualModels['coding-fast'], { enabled: true, strategy: 'priority', candidates: 3 }, 'persistence: coding-fast shape on disk');
  record('persistence: candidate real model on disk', onDisk.virtualModels['coding-fast'].candidates[0].model === 'glm-5.2', JSON.stringify(onDisk.virtualModels['coding-fast'].candidates[0]));

  // Ensure the in-memory set equals the on-disk set (no drift)
  const api = await adminGet('/virtual-models');
  const apiIds = (api.body.virtualModels || []).map((v) => v.id).sort();
  const diskIds = Object.keys(onDisk.virtualModels).sort();
  record('persistence: in-memory ids match on-disk ids', JSON.stringify(apiIds) === JSON.stringify(diskIds), `api=${apiIds} disk=${diskIds}`);
}

async function testHotReload() {
  // Edit the on-disk file directly, then trigger reload.
  const onDiskPath = process.env.VIRTUAL_MODELS_CONFIG_FILE;
  const onDisk = JSON.parse(fs.readFileSync(onDiskPath, 'utf8'));
  onDisk.virtualModels['vision'] = { enabled: true, strategy: 'priority', candidates: [{ provider: 'providerA', model: 'glm-5.2', priority: 1 }] };
  fs.writeFileSync(onDiskPath, JSON.stringify({ virtualModels: onDisk.virtualModels }, null, 2));

  const r = await adminPost('/reload', {});
  record('POST /reload succeeds', r.status === 200 && r.body && r.body.success, `status=${r.status}`);
  const list = await adminGet('/virtual-models');
  record('hot reload: vision vm appears after file edit', (list.body.virtualModels || []).some((v) => v.id === 'vision'), 'ids=' + (list.body.virtualModels || []).map((v) => v.id).join(','));
}

async function testRoutingStrategies() {
  // Set up an equally-prioritized vm so strategy actually decides.
  await adminPut('/virtual-models/coding-fast', {
    enabled: true, strategy: 'priority',
    candidates: [
      { provider: 'providerA', model: 'glm-5.2', priority: 1, weight: 1, enabled: true },
      { provider: 'providerB', model: 'deepseek-v3', priority: 1, weight: 1, enabled: true },
    ],
  });
  // Request N times; with priority (tie-break is stable by id providerA < providerB),
  // providerA wins. Then switch to round-robin and verify rotation.
  const a1 = await chat('coding-fast');
  record('priority strategy: providerA wins on tie (stable by id)', /served-by:providerA/.test(JSON.stringify(a1.body)), JSON.stringify(a1.body.choices && a1.body.choices[0]).slice(0, 60));

  await adminPut('/virtual-models/coding-fast', {
    enabled: true, strategy: 'round-robin',
    candidates: [
      { provider: 'providerA', model: 'glm-5.2', priority: 2, weight: 1 },
      { provider: 'providerB', model: 'deepseek-v3', priority: 1, weight: 1 },
    ],
  });
  const b1 = await chat('coding-fast');
  const b2 = await chat('coding-fast');
  const b3 = await chat('coding-fast');
  // First call after load+registration goes to round-robin start (here stable-priority pB? actually the round-robin strategy sorts by priority then rotates). Verify consecutive requests serve different providers.
  const served = [b1, b2, b3].map((r) => servedBy(r.body));
  record('round-robin strategy: serves both providers across requests', served.includes('providerA') && served.includes('providerB'), 'served=' + served.join(','));
}

async function testEnableDisableCandidateAndVirtualModel() {
  // Disable candidate providerB within coding-fast; only providerA served.
  await adminPut('/virtual-models/coding-fast', {
    enabled: true, strategy: 'priority',
    candidates: [
      { provider: 'providerA', model: 'glm-5.2', priority: 1, enabled: true },
      { provider: 'providerB', model: 'deepseek-v3', priority: 1, enabled: false },
    ],
  });
  const r = await chat('coding-fast');
  record('candidate disable: only enabled candidate served', /served-by:providerA/.test(JSON.stringify(r.body)), servedBy(r.body));

  // Disable the whole virtual model; request should fall back to NOT a vm => MODEL_NOT_FOUND 404
  await adminPut('/virtual-models/coding-fast/toggle', { enabled: false });
  const r2 = await chat('coding-fast');
  record('virtual model disable: 404 when no real model named coding-fast', r2.status === 404, `status=${r2.status}`);
  await adminPut('/virtual-models/coding-fast/toggle', { enabled: true });
  const r3 = await chat('coding-fast');
  record('virtual model re-enable: works again', r3.status === 200, `status=${r3.status}`);
}

async function testAutomaticFailover() {
  // coding-fast with providerA (priority 1) and providerB (priority 2).
  // Make providerA fail; the request must transparently fail over to providerB
  // WITHOUT the client changing anything.
  await adminPut('/virtual-models/coding-fast', {
    enabled: true, strategy: 'priority',
    candidates: [
      { provider: 'providerA', model: 'glm-5.2', priority: 1, weight: 1 },
      { provider: 'providerB', model: 'deepseek-v3', priority: 2, weight: 1 },
    ],
  });
  mockA.setFail(true);
  const r = await chat('coding-fast');
  record('failover: 200 returned despite first candidate failing', r.status === 200, `status=${r.status}`);
  record('failover: served by second candidate (providerB)', /served-by:providerB/.test(JSON.stringify(r.body)), servedBy(r.body));
  mockA.setFail(false);
}

async function testFailoverNeverLeavesVirtualModel() {
  // coding-fast maps to {A, B}; coding-premium maps to {C}. When A and B
  // both fail, the gateway must NOT silently fall over to providerC/ coding-premium.
  await adminPut('/virtual-models/coding-fast', {
    enabled: true, strategy: 'priority',
    candidates: [
      { provider: 'providerA', model: 'glm-5.2', priority: 1 },
      { provider: 'providerB', model: 'deepseek-v3', priority: 2 },
    ],
  });
  await adminPost('/virtual-models', {
    id: 'coding-premium', enabled: true, strategy: 'priority',
    candidates: [{ provider: 'providerC', model: 'qwen-coder', priority: 1 }],
  });
  mockA.setFail(true);
  mockB.setFail(true);
  const r = await chat('coding-fast');
  record('failover contract: NOT 200 when all coding-fast candidates fail (no cross-vm leak)', r.status !== 200, `status=${r.status}`);
  // Despite coding-premium using providerC's real model, gateway did not
  // route coding-fast there: confirm providerC saw no POST for /chat/completions
  // for this request by checking the response is an error (not served-by:providerC).
  record('failover contract: not served by providerC (no cross-vm leakage)', !/served-by:providerC/.test(JSON.stringify(r.body)), servedBy(r.body));
  mockA.setFail(false);
  mockB.setFail(false);
}

async function testModelsCatalog() {
  const r = await modelsList();
  const ids = (r.data || []).map((m) => m.id);
  record('GET /v1/models lists virtual models', ids.includes('coding-fast') && ids.includes('coding-premium'), 'ids=' + ids.slice(0, 12).join(','));
  record('GET /v1/models lists real models alongside virtual', ids.includes('glm-5.2'), 'ids=' + ids.slice(0, 12).join(','));
  const vm = (r.data || []).find((m) => m.id === 'coding-fast');
  record('GET /v1/models shape for virtual id is OpenAI-compatible',
    vm && vm.object === 'model' && typeof vm.created === 'number' && typeof vm.owned_by === 'string',
    JSON.stringify(vm).slice(0, 100));
}

async function testMetrics() {
  // Trigger at least one success + one fallback + check the per-vm metrics.
  // Reset coding-fast to a known state.
  await adminPut('/virtual-models/coding-fast', {
    enabled: true, strategy: 'priority',
    candidates: [
      { provider: 'providerA', model: 'glm-5.2', priority: 1 },
      { provider: 'providerB', model: 'deepseek-v3', priority: 2 },
    ],
  });
  await chat('coding-fast'); // success on A
  mockA.setFail(true);
  await chat('coding-fast'); // failover to B
  mockA.setFail(false);

  const snap = await adminGet('/monitoring');
  const vmMetrics = (snap.body && snap.body.virtualModels) || {};
  const cf = vmMetrics['coding-fast'] || {};
  record('metrics: virtual model usage tracked (coding-fast has totalRequests>0)', cf.totalRequests > 0, 'tr=' + cf.totalRequests);
  record('metrics: provider chosen tracked (providerSelections present)', cf.providerSelections && Object.keys(cf.providerSelections).length > 0, 'keys=' + Object.keys(cf.providerSelections || {}).join(','));
  record('metrics: fallback count tracked', cf.fallbackCount > 0, 'fb=' + cf.fallbackCount);
  record('metrics: latency tracked', typeof cf.averageLatencyMs === 'number', 'avg=' + cf.averageLatencyMs);
  record('metrics: success rate tracked', typeof cf.successRate === 'number', 'sr=' + cf.successRate);

  // routing decision recorded (providerSelections has both A and B)
  const selKeys = Object.keys(cf.providerSelections || {});
  record('metrics: routing decision recorded for both providers', selKeys.includes('providerA') && selKeys.includes('providerB'), 'sel=' + selKeys.join(','));
}

async function testDelete() {
  const before = (await adminGet('/virtual-models')).body.virtualModels.length;
  const r = await adminDelete('/virtual-models/coding-premium');
  record('DELETE /virtual-models/:id succeeds', r.status === 200, `status=${r.status}`);
  const after = (await adminGet('/virtual-models')).body.virtualModels.length;
  record('DELETE removed one virtual model', after === before - 1, `before=${before} after=${after}`);
  const onDisk = JSON.parse(fs.readFileSync(process.env.VIRTUAL_MODELS_CONFIG_FILE, 'utf8'));
  record('DELETE persisted to disk', !onDisk.virtualModels['coding-premium'], 'keys=' + Object.keys(onDisk.virtualModels).join(','));
}

// ---------------------------------------------------------------
// tiny assert helpers
// ---------------------------------------------------------------
function servedBy(body) {
  const m = JSON.stringify(body).match(/served-by:(provider\w+)/);
  return m ? m[1] : '<err:' + (body && body.error && body.error.message ? body.error.message.slice(0, 30) : '?') + '>';
}
function eqshape(actual, expected, name) {
  const checks = [];
  if (expected.enabled !== undefined) checks.push(['enabled', actual.enabled === expected.enabled]);
  if (expected.strategy !== undefined) checks.push(['strategy', actual.strategy === expected.strategy]);
  if (expected.candidates !== undefined) checks.push(['candidates', Array.isArray(actual.candidates) && actual.candidates.length === expected.candidates]);
  const ok = checks.every((c) => c[1]);
  record(name, ok, ok ? '' : checks.map((c) => c[0] + '=' + c[1]).join(','));
}

// ============================================================
// Runner
// ============================================================
(async function () {
  try {
    await setup();
    await testBackwardCompat();
    await testCreateAndResolveVirtualModel();
    await testValidationBeforeSave();
    await testPersistenceRoundTrip();
    await testHotReload();
    await testRoutingStrategies();
    await testEnableDisableCandidateAndVirtualModel();
    await testAutomaticFailover();
    await testFailoverNeverLeavesVirtualModel();
    await testModelsCatalog();
    await testMetrics();
    await testDelete();
  } catch (e) {
    console.error('TEST CRASH:', e && e.stack || e);
    process.exitCode = 1;
  } finally {
    await teardown();
    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Virtual Models — Integration: ${passed}/${results.length} passed, ${failed} failed`);
    if (failed > 0) {
      results.filter((r) => !r.passed).forEach((r) => console.log('  FAIL: ' + r.name + (r.detail ? ' — ' + r.detail : '')));
      process.exitCode = 1;
    }
  }
})();
