/**
 * Integration test for authentication & authorization.
 *
 * Run:  node examples/auth.integration.js
 *
 * Verifies:
 *   - valid key -> 200
 *   - invalid key -> 401 invalid_api_key
 *   - missing key -> 401 missing_api_key
 *   - disabled key -> 401 disabled_api_key
 *   - expired key -> 401 expired_api_key
 *   - public endpoints (/, /health, /ready) accessible without auth
 *   - protected endpoint without auth -> 401
 *   - model restriction (allowedModels) enforced
 *   - model restriction: allowed model works
 *   - provider restriction (allowedProviders) enforced
 *   - provider restriction: allowed provider works
 *   - usage tracking (request count, tokens, provider, model)
 *   - multiple active keys simultaneously
 *   - OpenAI-compatible error envelope
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

const VALID_KEY = 'sk-valid-test-key-1234';
const INVALID_KEY = 'sk-invalid-key-9999';
const DISABLED_KEY = 'sk-disabled-test-key-0000';
const EXPIRED_KEY = 'sk-expired-test-key-1111';
const MODEL_RESTRICTED_KEY = 'sk-model-restricted-key-2222';
const PROVIDER_RESTRICTED_KEY = 'sk-provider-restricted-key-3333';
const FULL_ACCESS_KEY = 'sk-full-access-key-4444';

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
        res.writeHead(404); res.end('{}');
      });
    });
    mockServer.listen(0, '127.0.0.1', () => { mockPort = mockServer.address().port; resolve(); });
  });
}

function writeConfigs() {
  // Provider configs: two providers serving different models.
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-auth-'));
  const base = `http://127.0.0.1:${mockPort}`;

  const providerA = {
    id: 'provider-a', name: 'Provider A', enabled: true,
    adapter: 'openai', baseURL: base, apiKeys: ['prov-a-key'],
    supportedModels: ['alpha-model', 'shared-model'], priority: 1, timeout: 5000,
  };
  const providerB = {
    id: 'provider-b', name: 'Provider B', enabled: true,
    adapter: 'openai', baseURL: base, apiKeys: ['prov-b-key'],
    supportedModels: ['beta-model', 'shared-model'], priority: 2, timeout: 5000,
  };
  fs.writeFileSync(path.join(tmpProvidersDir, 'a.json'), JSON.stringify(providerA));
  fs.writeFileSync(path.join(tmpProvidersDir, 'b.json'), JSON.stringify(providerB));

  // API keys config
  tmpApiKeysFile = path.join(tmpProvidersDir, 'apiKeys.json');
  const keys = [
    { id: 'valid', key: VALID_KEY, name: 'Valid', status: 'active', createdAt: 1700000000 },
    { id: 'disabled', key: DISABLED_KEY, name: 'Disabled', status: 'inactive', createdAt: 1700000000 },
    { id: 'expired', key: EXPIRED_KEY, name: 'Expired', status: 'active', expiresAt: 1000000000, createdAt: 999999999 },
    { id: 'model-restricted', key: MODEL_RESTRICTED_KEY, name: 'Model-restricted', status: 'active', allowedModels: ['alpha-model'], createdAt: 1700000000 },
    { id: 'provider-restricted', key: PROVIDER_RESTRICTED_KEY, name: 'Provider-restricted', status: 'active', allowedProviders: ['provider-a'], createdAt: 1700000000 },
    { id: 'full-access', key: FULL_ACCESS_KEY, name: 'Full', status: 'active', createdAt: 1700000000 },
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

function authedGet(pathStr, key) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'GET', path: pathStr,
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    }, (res) => {
      let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(c) }); } catch { resolve({ status: res.statusCode, body: c }); }
      });
    });
    req.on('error', reject); req.end();
  });
}

function authedPost(pathStr, body, key) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (key) headers.Authorization = `Bearer ${key}`;
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'POST', path: pathStr, headers,
    }, (res) => {
      let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(c) }); } catch { resolve({ status: res.statusCode, body: c }); }
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function testValidKey() {
  const res = await authedGet('/v1/models', VALID_KEY);
  record('valid key -> 200', res.status === 200, `status=${res.status}`);
}

async function testInvalidKey() {
  const res = await authedGet('/v1/models', INVALID_KEY);
  const ok = res.status === 401 && res.body.error && res.body.error.code === 'invalid_api_key';
  record('invalid key -> 401 invalid_api_key', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testMissingKey() {
  const res = await authedGet('/v1/models', null);
  const ok = res.status === 401 && res.body.error && res.body.error.code === 'missing_api_key';
  record('missing key -> 401 missing_api_key', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testDisabledKey() {
  const res = await authedGet('/v1/models', DISABLED_KEY);
  const ok = res.status === 401 && res.body.error && res.body.error.code === 'disabled_api_key';
  record('disabled key -> 401 disabled_api_key', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testExpiredKey() {
  const res = await authedGet('/v1/models', EXPIRED_KEY);
  const ok = res.status === 401 && res.body.error && res.body.error.code === 'expired_api_key';
  record('expired key -> 401 expired_api_key', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testPublicEndpointsNoAuth() {
  const rootRes = await authedGet('/', null);
  const healthRes = await authedGet('/health', null);
  const readyRes = await authedGet('/ready', null);
  const ok = rootRes.status === 200 && healthRes.status === 200 && readyRes.status === 200;
  record('public endpoints (/, /health, /ready) accessible without auth', ok, `root=${rootRes.status}, health=${healthRes.status}, ready=${readyRes.status}`);
}

async function testProtectedEndpointWithoutAuth() {
  const res = await authedGet('/v1/models', null);
  const ok = res.status === 401;
  record('protected endpoint without auth -> 401', ok, `status=${res.status}`);
}

async function testModelRestrictionAllowed() {
  const res = await authedPost('/v1/chat/completions', {
    model: 'alpha-model', messages: [{ role: 'user', content: 'hi' }],
  }, MODEL_RESTRICTED_KEY);
  record('model-restricted key: allowed model works', res.status === 200, `status=${res.status}`);
}

async function testModelRestrictionForbidden() {
  const res = await authedPost('/v1/chat/completions', {
    model: 'beta-model', messages: [{ role: 'user', content: 'hi' }],
  }, MODEL_RESTRICTED_KEY);
  const ok = res.status === 403 && res.body.error && res.body.error.code === 'model_forbidden';
  record('model-restricted key: forbidden model -> 403 model_forbidden', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testProviderRestrictionAllowed() {
  // alpha-model is served by provider-a (allowed) -> should work
  const res = await authedPost('/v1/chat/completions', {
    model: 'alpha-model', messages: [{ role: 'user', content: 'hi' }],
  }, PROVIDER_RESTRICTED_KEY);
  record('provider-restricted key: allowed provider works', res.status === 200, `status=${res.status}`);
}

async function testProviderRestrictionForbidden() {
  // beta-model is only served by provider-b (not allowed) -> 403
  const res = await authedPost('/v1/chat/completions', {
    model: 'beta-model', messages: [{ role: 'user', content: 'hi' }],
  }, PROVIDER_RESTRICTED_KEY);
  const ok = res.status === 403 && res.body.error && res.body.error.code === 'provider_forbidden';
  record('provider-restricted key: forbidden provider -> 403 provider_forbidden', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testProviderRestrictionFallbackAllowed() {
  // shared-model is served by provider-a (allowed, priority 1) AND provider-b
  // (not allowed, priority 2). The key can access provider-a, so it should
  // work.
  const res = await authedPost('/v1/chat/completions', {
    model: 'shared-model', messages: [{ role: 'user', content: 'hi' }],
  }, PROVIDER_RESTRICTED_KEY);
  record('provider-restricted key: shared model (allowed provider) works', res.status === 200, `status=${res.status}`);
}

async function testUsageTracking() {
  const { usageTracker } = require('../src/services');
  // The full-access key should have recorded at least one request.
  // Send a chat completions request to record tokens + provider + model.
  await authedPost('/v1/chat/completions', {
    model: 'alpha-model', messages: [{ role: 'user', content: 'hi' }],
  }, FULL_ACCESS_KEY);

  const stats = usageTracker.getUsage('full-access');
  const ok =
    stats &&
    stats.totalRequests >= 1 &&
    stats.totalTokens >= 8 &&
    stats.providerUsage['provider-a'] >= 1 &&
    stats.modelUsage['alpha-model'] >= 1 &&
    typeof stats.lastUsed === 'number' &&
    typeof stats.createdAt === 'number';
  record('usage tracking (requests, tokens, provider, model)', ok, `requests=${stats && stats.totalRequests}, tokens=${stats && stats.totalTokens}, provider=${stats && JSON.stringify(stats.providerUsage)}, model=${stats && JSON.stringify(stats.modelUsage)}`);
}

async function testMultipleActiveKeys() {
  const res1 = await authedGet('/v1/models', VALID_KEY);
  const res2 = await authedGet('/v1/models', FULL_ACCESS_KEY);
  const ok = res1.status === 200 && res2.status === 200;
  record('multiple active keys work simultaneously', ok, `valid=${res1.status}, full=${res2.status}`);
}

async function testOpenAIErrorEnvelope() {
  const res = await authedGet('/v1/models', INVALID_KEY);
  const ok =
    res.body.error &&
    typeof res.body.error.message === 'string' &&
    typeof res.body.error.type === 'string' &&
    res.body.error.type === 'invalid_request_error' &&
    typeof res.body.error.code === 'string';
  record('OpenAI-compatible error envelope', ok, `type=${res.body && res.body.error && res.body.error.type}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testOpenGatewayMode() {
  // When the store has no keys, the gateway should run in open mode.
  const { apiKeyStore } = require('../src/services');
  // Save current state, clear keys, test, restore.
  const savedKeys = apiKeyStore.keys;
  const savedMap = apiKeyStore.keysByKey;
  apiKeyStore.keys = [];
  apiKeyStore.keysByKey = new Map();

  const res = await authedGet('/v1/models', null);
  const ok = res.status === 200;

  // Restore
  apiKeyStore.keys = savedKeys;
  apiKeyStore.keysByKey = savedMap;

  record('open-gateway mode when no keys configured', ok, `status=${res.status}`);
}

async function main() {
  console.log('=== Authentication Integration Tests ===\n');
  await startMockProvider();
  writeConfigs();

  const { providerManager, apiKeyManager, apiKeyStore, usageTracker } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());
  apiKeyStore.load(tmpApiKeysFile);
  usageTracker.reset();

  await startExpressServer();

  try {
    await testValidKey();
    await testInvalidKey();
    await testMissingKey();
    await testDisabledKey();
    await testExpiredKey();
    await testPublicEndpointsNoAuth();
    await testProtectedEndpointWithoutAuth();
    await testModelRestrictionAllowed();
    await testModelRestrictionForbidden();
    await testProviderRestrictionAllowed();
    await testProviderRestrictionForbidden();
    await testProviderRestrictionFallbackAllowed();
    await testUsageTracking();
    await testMultipleActiveKeys();
    await testOpenAIErrorEnvelope();
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
