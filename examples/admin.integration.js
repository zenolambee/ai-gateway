/**
 * Integration test for the Admin Dashboard API.
 *
 * Run:  node examples/admin.integration.js
 *
 * Verifies:
 *   - GET /admin (HTML dashboard)
 *   - GET /admin/api/overview (dashboard cards)
 *   - GET /admin/api/providers (list)
 *   - PUT /admin/api/providers/:id (enable/disable)
 *   - POST /admin/api/providers/:id/test (connectivity test)
 *   - POST /admin/api/reload (manual reload)
 *   - GET /admin/api/keys (list with usage)
 *   - POST /admin/api/keys (create)
 *   - DELETE /admin/api/keys/:id (delete)
 *   - PUT /admin/api/keys/:id (enable/disable)
 *   - GET /admin/api/keys/:id/usage (per-key usage)
 *   - GET /admin/api/models (model registry)
 *   - GET /admin/api/monitoring (metrics)
 *   - GET /admin/api/logs (request log)
 *   - GET /admin/api/health (provider health)
 *   - GET /admin/api/config (current config)
 *   - admin auth: non-admin key -> 403 admin_forbidden
 *   - admin auth: missing key -> 401
 *   - admin auth: admin key -> 200
 *   - open-gateway mode (no keys): admin API accessible
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
let tmpApiKeysFile;

const ADMIN_KEY = 'sk-admin-test-key-0000';
const USER_KEY = 'sk-user-test-key-1111';

function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/chat/completions') {
          let received;
          try { received = JSON.parse(body); } catch { received = {}; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion', created: 1700000000,
            model: received.model || 'mock',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }));
          return;
        }
        if (req.url === '/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
          return;
        }
        res.writeHead(404); res.end('{}');
      });
    });
    mockServer.listen(0, '127.0.0.1', () => { mockPort = mockServer.address().port; resolve(); });
  });
}

function writeConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-admin-'));
  const base = `http://127.0.0.1:${mockPort}`;
  const provider = {
    id: 'test-provider', name: 'Test Provider', enabled: true,
    adapter: 'openai', baseURL: base, apiKeys: ['prov-key'],
    supportedModels: ['test-model'], priority: 1, timeout: 5000,
  };
  fs.writeFileSync(path.join(tmpProvidersDir, 'p.json'), JSON.stringify(provider));

  tmpApiKeysFile = path.join(tmpProvidersDir, 'apiKeys.json');
  const keys = [
    { id: 'admin', key: ADMIN_KEY, name: 'Admin', status: 'active', role: 'admin' },
    { id: 'user', key: USER_KEY, name: 'User', status: 'active', role: 'user' },
  ];
  fs.writeFileSync(tmpApiKeysFile, JSON.stringify(keys));
}

function startExpressServer() {
  return new Promise((resolve) => {
    expressServer = app.listen(0, '127.0.0.1', () => {
      expressPort = expressServer.address().port;
      resolve();
    });
  });
}

function adminGet(pathStr, key) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    http.get({ host: '127.0.0.1', port: expressPort, path: pathStr, headers }, (res) => {
      let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(c) }); } catch { resolve({ status: res.statusCode, body: c }); }
      });
    }).on('error', reject);
  });
}

function adminReq(method, pathStr, body, key) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = {};
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (key) headers.Authorization = `Bearer ${key}`;
    const req = http.request({ host: '127.0.0.1', port: expressPort, method, path: pathStr, headers }, (res) => {
      let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(c) }); } catch { resolve({ status: res.statusCode, body: c }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function testAdminHTML() {
  const res = await adminGet('/admin', ADMIN_KEY);
  const ok = res.status === 200 && typeof res.body === 'string' && res.body.includes('<html');
  record('GET /admin (HTML dashboard)', ok, `status=${res.status}`);
}

async function testOverview() {
  const res = await adminGet('/admin/api/overview', ADMIN_KEY);
  const ok = res.status === 200 && typeof res.body.requests === 'number';
  record('GET /admin/api/overview', ok, `status=${res.status}, requests=${res.body && res.body.requests}`);
}

async function testProvidersList() {
  const res = await adminGet('/admin/api/providers', ADMIN_KEY);
  const ok = res.status === 200 && Array.isArray(res.body.providers) && res.body.providers.length > 0;
  record('GET /admin/api/providers', ok, `status=${res.status}, count=${res.body && res.body.providers && res.body.providers.length}`);
}

async function testProviderToggle() {
  const res = await adminReq('PUT', '/admin/api/providers/test-provider', {
    id: 'test-provider', name: 'Test Provider', enabled: false,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['prov-key'],
    supportedModels: ['test-model'], priority: 1, timeout: 5000,
  }, ADMIN_KEY);
  const ok = res.status === 200 && res.body.success === true;
  record('PUT /admin/api/providers/:id (disable)', ok, `status=${res.status}`);

  // Re-enable
  await adminReq('PUT', '/admin/api/providers/test-provider', {
    id: 'test-provider', name: 'Test Provider', enabled: true,
    adapter: 'openai', baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['prov-key'],
    supportedModels: ['test-model'], priority: 1, timeout: 5000,
  }, ADMIN_KEY);
}

async function testProviderTest() {
  const res = await adminReq('POST', '/admin/api/providers/test-provider/test', null, ADMIN_KEY);
  const ok = res.status === 200 && typeof res.body.success === 'boolean';
  record('POST /admin/api/providers/:id/test', ok, `status=${res.status}, success=${res.body && res.body.success}`);
}

async function testManualReload() {
  const res = await adminReq('POST', '/admin/api/reload', null, ADMIN_KEY);
  const ok = res.status === 200 && typeof res.body.success === 'boolean';
  record('POST /admin/api/reload', ok, `status=${res.status}, success=${res.body && res.body.success}`);
}

async function testKeysList() {
  const res = await adminGet('/admin/api/keys', ADMIN_KEY);
  const ok = res.status === 200 && Array.isArray(res.body.keys) && res.body.keys.length >= 2;
  record('GET /admin/api/keys', ok, `status=${res.status}, count=${res.body && res.body.keys && res.body.keys.length}`);
}

async function testKeyCreate() {
  const res = await adminReq('POST', '/admin/api/keys', {
    key: 'sk-new-admin-key-9999', name: 'New Key', role: 'user',
  }, ADMIN_KEY);
  const ok = res.status === 200 && res.body.success === true;
  record('POST /admin/api/keys (create)', ok, `status=${res.status}`);

  // Delete it
  await adminReq('DELETE', '/admin/api/keys/sk-new-admin-key-9999', null, ADMIN_KEY);
}

async function testKeyDelete() {
  // Create then delete
  await adminReq('POST', '/admin/api/keys', {
    key: 'sk-delete-me-8888', name: 'Delete Me',
  }, ADMIN_KEY);
  const res = await adminReq('DELETE', '/admin/api/keys/sk-delete-me-8888', null, ADMIN_KEY);
  const ok = res.status === 200 && res.body.success === true;
  record('DELETE /admin/api/keys/:id', ok, `status=${res.status}`);
}

async function testKeyUpdate() {
  const res = await adminReq('PUT', '/admin/api/keys/user', { status: 'inactive' }, ADMIN_KEY);
  const ok = res.status === 200 && res.body.success === true;
  record('PUT /admin/api/keys/:id (disable)', ok, `status=${res.status}`);

  // Re-enable
  await adminReq('PUT', '/admin/api/keys/user', { status: 'active' }, ADMIN_KEY);
}

async function testKeyUsage() {
  const res = await adminGet('/admin/api/keys/admin/usage', ADMIN_KEY);
  const ok = res.status === 200 && res.body.keyId === 'admin';
  record('GET /admin/api/keys/:id/usage', ok, `status=${res.status}`);
}

async function testModels() {
  const res = await adminGet('/admin/api/models', ADMIN_KEY);
  const ok = res.status === 200 && Array.isArray(res.body.models);
  record('GET /admin/api/models', ok, `status=${res.status}, count=${res.body && res.body.models && res.body.models.length}`);
}

async function testMonitoring() {
  const res = await adminGet('/admin/api/monitoring', ADMIN_KEY);
  const ok = res.status === 200 && res.body.global;
  record('GET /admin/api/monitoring', ok, `status=${res.status}`);
}

async function testLogs() {
  // First make a request so the log isn't empty
  await adminReq('POST', '/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, USER_KEY);
  const res = await adminGet('/admin/api/logs?limit=10', ADMIN_KEY);
  const ok = res.status === 200 && Array.isArray(res.body.entries);
  record('GET /admin/api/logs', ok, `status=${res.status}, count=${res.body && res.body.entries && res.body.entries.length}`);
}

async function testHealth() {
  const res = await adminGet('/admin/api/health', ADMIN_KEY);
  const ok = res.status === 200 && res.body.providers;
  record('GET /admin/api/health', ok, `status=${res.status}`);
}

async function testConfig() {
  const res = await adminGet('/admin/api/config', ADMIN_KEY);
  const ok = res.status === 200 && Array.isArray(res.body.providers);
  record('GET /admin/api/config', ok, `status=${res.status}`);
}

async function testSystem() {
  const res = await adminGet('/admin/api/system', ADMIN_KEY);
  const ok = res.status === 200 && typeof res.body.version === 'string' && res.body.memory;
  record('GET /admin/api/system', ok, `status=${res.status}, version=${res.body && res.body.version}`);
}

async function testAdminAuthForbidden() {
  const res = await adminGet('/admin/api/overview', USER_KEY);
  const ok = res.status === 403 && res.body.error && res.body.error.code === 'admin_forbidden';
  record('non-admin key -> 403 admin_forbidden', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testAdminAuthMissing() {
  const res = await adminGet('/admin/api/overview', null);
  const ok = res.status === 401;
  record('missing key -> 401', ok, `status=${res.status}`);
}

async function testAdminAuthAdminOK() {
  const res = await adminGet('/admin/api/overview', ADMIN_KEY);
  const ok = res.status === 200;
  record('admin key -> 200', ok, `status=${res.status}`);
}

async function testOpenGatewayMode() {
  const { apiKeyStore } = require('../src/services');
  // Save and clear keys
  const savedKeys = apiKeyStore.keys;
  const savedMap = apiKeyStore.keysByKey;
  apiKeyStore.keys = [];
  apiKeyStore.keysByKey = new Map();

  const res = await adminGet('/admin/api/overview', null);
  const ok = res.status === 200;

  // Restore
  apiKeyStore.keys = savedKeys;
  apiKeyStore.keysByKey = savedMap;

  record('open-gateway mode: admin API accessible without key', ok, `status=${res.status}`);
}

async function main() {
  console.log('=== Admin Dashboard Integration Tests ===\n');
  await startMockProvider();
  writeConfigs();

  const { providerManager, apiKeyManager, apiKeyStore, requestLog, metricsCollector } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());
  apiKeyStore.load(tmpApiKeysFile);
  requestLog.reset();
  metricsCollector.reset();

  await startExpressServer();

  try {
    await testAdminHTML();
    await testOverview();
    await testProvidersList();
    await testProviderToggle();
    await testProviderTest();
    await testManualReload();
    await testKeysList();
    await testKeyCreate();
    await testKeyDelete();
    await testKeyUpdate();
    await testKeyUsage();
    await testModels();
    await testMonitoring();
    await testLogs();
    await testHealth();
    await testConfig();
    await testSystem();
    await testAdminAuthForbidden();
    await testAdminAuthMissing();
    await testAdminAuthAdminOK();
    await testOpenGatewayMode();
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
