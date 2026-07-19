/**
 * Integration test for Rate Limiting & Quota Management.
 *
 * Run:  node examples/rateLimit.integration.js
 *
 * Verifies:
 *   - burst limit (token bucket exhaustion -> 429)
 *   - per-key rate limit (requests exceed per-key RPM -> 429)
 *   - per-provider rate limit
 *   - concurrency limit (in-flight requests exceed concurrent cap -> 429)
 *   - daily request quota exhaustion -> 429
 *   - Retry-After header on 429
 *   - OpenAI-compatible headers (X-RateLimit-Limit/Remaining/Reset)
 *   - OpenAI-compatible error envelope on 429
 *   - metrics integration (rateLimitRejections counter)
 *   - disabled limiter passes through
 *   - public endpoints not rate-limited
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const app = require('../src/app');
const logger = require('../src/utils/logger');
const RateLimiter = require('../src/services/rateLimiter');

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

const VALID_KEY = 'sk-rl-valid-key';
const SECOND_KEY = 'sk-rl-second-key';

function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/chat/completions') {
          // Add a small delay to allow concurrency testing
          setTimeout(() => {
            let received;
            try { received = JSON.parse(body); } catch { received = {}; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'chatcmpl-mock', object: 'chat.completion', created: 1700000000,
              model: received.model || 'mock',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
            }));
          }, 100);
          return;
        }
        res.writeHead(404); res.end('{}');
      });
    });
    mockServer.listen(0, '127.0.0.1', () => { mockPort = mockServer.address().port; resolve(); });
  });
}

function writeConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-rl-'));
  const base = `http://127.0.0.1:${mockPort}`;
  const provider = {
    id: 'test-provider', name: 'Test Provider', enabled: true,
    adapter: 'openai', baseURL: base, apiKeys: ['prov-key'],
    supportedModels: ['test-model'], priority: 1, timeout: 5000,
  };
  fs.writeFileSync(path.join(tmpProvidersDir, 'p.json'), JSON.stringify(provider));

  tmpApiKeysFile = path.join(tmpProvidersDir, 'apiKeys.json');
  const keys = [
    { id: 'valid', key: VALID_KEY, name: 'Valid', status: 'active' },
    { id: 'second', key: SECOND_KEY, name: 'Second', status: 'active' },
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

function post(pathStr, body, key) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (key) headers.Authorization = `Bearer ${key}`;
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'POST', path: pathStr, headers,
    }, (res) => {
      let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(c) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: c }); }
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function get(pathStr) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: expressPort, path: pathStr }, (res) => {
      let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(c) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: c }); }
      });
    }).on('error', reject);
  });
}

// Helper: configure the live RateLimiter with specific limits
function configureRateLimiter(config) {
  const { rateLimiter } = require('../src/services');
  // Replace internal state by constructing a fresh limiter with new config
  const fresh = new RateLimiter(config);
  Object.assign(rateLimiter, fresh);
  return rateLimiter;
}

async function testBurstLimit() {
  configureRateLimiter({
    enabled: true,
    algorithm: 'token_bucket',
    global: { requestsPerMinute: 100, burst: 3 },
    perKey: {}, perProvider: {}, perModel: {},
  });
  const { apiKeyStore } = require('../src/services');
  apiKeyStore.load(tmpApiKeysFile);

  const req = () => post('/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, VALID_KEY);

  const r1 = await req();
  const r2 = await req();
  const r3 = await req();
  const r4 = await req();
  const ok = r1.status === 200 && r2.status === 200 && r3.status === 200 && r4.status === 429;
  record('burst limit: 3 requests succeed, 4th -> 429', ok, `r1=${r1.status}, r2=${r2.status}, r3=${r3.status}, r4=${r4.status}`);
}

async function testPerKeyRateLimit() {
  configureRateLimiter({
    enabled: true,
    algorithm: 'fixed_window',
    global: {},
    perKey: { requestsPerMinute: 2 },
    perProvider: {}, perModel: {},
  });
  const { apiKeyStore } = require('../src/services');
  apiKeyStore.load(tmpApiKeysFile);

  const req = (key) => post('/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, key);

  // Two requests from the valid key -> both succeed
  const r1 = await req(VALID_KEY);
  const r2 = await req(VALID_KEY);
  // Third from the same key -> 429
  const r3 = await req(VALID_KEY);
  // A request from a different key should succeed (independent limit)
  const r4 = await req(SECOND_KEY);
  const ok = r1.status === 200 && r2.status === 200 && r3.status === 429 && r4.status === 200;
  record('per-key rate limit: 2 per key, 3rd -> 429, different key works', ok, `r1=${r1.status}, r3=${r3.status}, r4=${r4.status}`);
}

async function testConcurrencyLimit() {
  configureRateLimiter({
    enabled: true,
    algorithm: 'token_bucket',
    global: { requestsPerMinute: 1000, burst: 100 },
    perKey: { requestsPerMinute: 1000, burst: 100, concurrent: 1 },
    perProvider: {}, perModel: {},
  });
  const { apiKeyStore } = require('../src/services');
  apiKeyStore.load(tmpApiKeysFile);

  // Send 2 concurrent requests with the same key (concurrent limit = 1).
  // The mock provider delays 100ms, so the first request holds the slot.
  const p1 = post('/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, VALID_KEY);
  // Small delay to ensure p1 acquires the slot first
  await new Promise((r) => setTimeout(r, 20));
  const r2 = await post('/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, VALID_KEY);
  const r1 = await p1;

  const ok = r1.status === 200 && r2.status === 429;
  record('concurrency limit: 2nd concurrent request -> 429', ok, `r1=${r1.status}, r2=${r2.status}`);
  // Wait for r1 to finish so the slot is released
  await new Promise((r) => setTimeout(r, 150));
}

async function testDailyRequestQuota() {
  configureRateLimiter({
    enabled: true,
    algorithm: 'token_bucket',
    global: { requestsPerMinute: 1000, burst: 100 },
    perKey: { requestsPerMinute: 1000, burst: 100, dailyRequestQuota: 2 },
    perProvider: {}, perModel: {},
  });
  const { apiKeyStore } = require('../src/services');
  apiKeyStore.load(tmpApiKeysFile);

  const req = () => post('/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, VALID_KEY);
  const r1 = await req();
  const r2 = await req();
  const r3 = await req();
  const ok = r1.status === 200 && r2.status === 200 && r3.status === 429;
  record('daily request quota: 2 allowed, 3rd -> 429', ok, `r1=${r1.status}, r2=${r2.status}, r3=${r3.status}`);
}

async function testRetryAfterHeader() {
  configureRateLimiter({
    enabled: true,
    algorithm: 'fixed_window',
    global: { requestsPerMinute: 1 },
    perKey: {}, perProvider: {}, perModel: {},
  });
  const { apiKeyStore } = require('../src/services');
  apiKeyStore.load(tmpApiKeysFile);

  const req = () => post('/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, VALID_KEY);
  await req(); // consume the 1 allowed request
  const r = await req(); // should be 429
  const hasRetryAfter = r.headers['retry-after'] !== undefined;
  const ok = r.status === 429 && hasRetryAfter;
  record('Retry-After header on 429', ok, `status=${r.status}, retry-after=${r.headers['retry-after']}`);
}

async function testRateLimitHeaders() {
  configureRateLimiter({
    enabled: true,
    algorithm: 'fixed_window',
    global: { requestsPerMinute: 10 },
    perKey: {}, perProvider: {}, perModel: {},
  });
  const { apiKeyStore } = require('../src/services');
  apiKeyStore.load(tmpApiKeysFile);

  const r = await post('/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, VALID_KEY);
  const hasLimit = r.headers['x-ratelimit-limit'] !== undefined;
  const hasRemaining = r.headers['x-ratelimit-remaining'] !== undefined;
  const hasReset = r.headers['x-ratelimit-reset'] !== undefined;
  const ok = r.status === 200 && hasLimit && hasRemaining && hasReset;
  record('OpenAI-compatible rate-limit headers', ok, `limit=${r.headers['x-ratelimit-limit']}, remaining=${r.headers['x-ratelimit-remaining']}, reset=${r.headers['x-ratelimit-reset']}`);
}

async function testOpenAIErrorEnvelope() {
  configureRateLimiter({
    enabled: true,
    algorithm: 'fixed_window',
    global: { requestsPerMinute: 1 },
    perKey: {}, perProvider: {}, perModel: {},
  });
  const { apiKeyStore } = require('../src/services');
  apiKeyStore.load(tmpApiKeysFile);

  const req = () => post('/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, VALID_KEY);
  await req();
  const r = await req();
  const ok =
    r.status === 429 &&
    r.body.error &&
    typeof r.body.error.message === 'string' &&
    r.body.error.type === 'rate_limit_exceeded' &&
    r.body.error.code === 'rate_limit_exceeded';
  record('OpenAI-compatible error envelope on 429', ok, `status=${r.status}, type=${r.body && r.body.error && r.body.error.type}, code=${r.body && r.body.error && r.body.error.code}`);
}

async function testMetricsIntegration() {
  configureRateLimiter({
    enabled: true,
    algorithm: 'fixed_window',
    global: { requestsPerMinute: 1 },
    perKey: {}, perProvider: {}, perModel: {},
  });
  const { apiKeyStore, metricsCollector } = require('../src/services');
  apiKeyStore.load(tmpApiKeysFile);
  metricsCollector.reset();

  const req = () => post('/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, VALID_KEY);
  await req(); // succeed
  await req(); // 429

  const snap = metricsCollector.getSnapshot();
  const ok = snap.global.rateLimitRejections >= 1;
  record('metrics: rateLimitRejections incremented', ok, `rejections=${snap.global.rateLimitRejections}`);
}

async function testDisabledLimiter() {
  configureRateLimiter({ enabled: false, algorithm: 'token_bucket', global: {}, perKey: {}, perProvider: {}, perModel: {} });
  const { apiKeyStore } = require('../src/services');
  apiKeyStore.load(tmpApiKeysFile);

  // Send many requests — all should succeed
  let allOk = true;
  for (let i = 0; i < 10; i += 1) {
    const r = await post('/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, VALID_KEY);
    if (r.status !== 200) allOk = false;
  }
  record('disabled limiter: all requests pass through', allOk, `10 requests all 200`);
}

async function testPublicEndpointsNotRateLimited() {
  configureRateLimiter({
    enabled: true,
    algorithm: 'fixed_window',
    global: { requestsPerMinute: 1 },
    perKey: {}, perProvider: {}, perModel: {},
  });

  // Public endpoints should not be rate limited
  for (let i = 0; i < 5; i += 1) {
    const r = await get('/health');
    if (r.status !== 200) {
      record('public endpoints not rate limited', false, `health #${i} status=${r.status}`);
      return;
    }
  }
  record('public endpoints not rate limited', true, `5 health checks all 200`);
}

async function testPerProviderRateLimit() {
  // Test the RateLimiter directly (per-provider scope)
  const rl = new RateLimiter({
    enabled: true,
    algorithm: 'fixed_window',
    global: { requestsPerMinute: 1000 },
    perKey: { requestsPerMinute: 1000 },
    perProvider: { requestsPerMinute: 2 },
    perModel: {},
  });

  const now = Date.now();
  const r1 = rl.check({ apiKeyId: 'k1', providerId: 'p1', now });
  const r2 = rl.check({ apiKeyId: 'k1', providerId: 'p1', now });
  const r3 = rl.check({ apiKeyId: 'k1', providerId: 'p1', now });
  // Release concurrency between checks
  rl.release({ apiKeyId: 'k1', providerId: 'p1' });
  rl.release({ apiKeyId: 'k1', providerId: 'p1' });

  const ok = r1.allowed && r2.allowed && !r3.allowed;
  record('per-provider rate limit: 2 per provider, 3rd -> 429', ok, `r1=${r1.allowed}, r2=${r2.allowed}, r3=${r3.allowed}`);
}

async function testTokenBucketRefill() {
  const rl = new RateLimiter({
    enabled: true,
    algorithm: 'token_bucket',
    global: { requestsPerMinute: 60, burst: 2 }, // 1 token/sec
    perKey: {}, perProvider: {}, perModel: {},
  });

  const now1 = Date.now();
  const r1 = rl.check({ now: now1 });
  const r2 = rl.check({ now: now1 });
  const r3 = rl.check({ now: now1 }); // exhausted
  rl.release({});
  rl.release({});
  // Wait for 1.2 seconds -> 1 token refilled
  const now2 = now1 + 1200;
  const r4 = rl.check({ now: now2 });
  rl.release({});

  const ok = r1.allowed && r2.allowed && !r3.allowed && r4.allowed;
  record('token bucket: refill after delay', ok, `r1=${r1.allowed}, r3=${r3.allowed}, r4(after 1.2s)=${r4.allowed}`);
}

async function main() {
  console.log('=== Rate Limiting Integration Tests ===\n');
  await startMockProvider();
  writeConfigs();

  const { providerManager, apiKeyManager, apiKeyStore, rateLimiter } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());
  apiKeyStore.load(tmpApiKeysFile);

  await startExpressServer();

  try {
    await testBurstLimit();
    await testPerKeyRateLimit();
    await testConcurrencyLimit();
    await testDailyRequestQuota();
    await testRetryAfterHeader();
    await testRateLimitHeaders();
    await testOpenAIErrorEnvelope();
    await testMetricsIntegration();
    await testDisabledLimiter();
    await testPublicEndpointsNotRateLimited();
    await testPerProviderRateLimit();
    await testTokenBucketRefill();
  } finally {
    // Reset the global rate limiter to disabled so it doesn't affect other tests
    configureRateLimiter({ enabled: false, algorithm: 'token_bucket', global: {}, perKey: {}, perProvider: {}, perModel: {} });
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
