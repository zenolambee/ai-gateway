/**
 * Integration test for Metrics & Monitoring.
 *
 * Run:  node examples/metrics.integration.js
 *
 * Verifies:
 *   - metrics update after a successful request (global + per-provider)
 *   - metrics update after a failed request
 *   - retry count tracked after a transient failure + retry
 *   - fallback count tracked when the primary provider fails
 *   - latency tracked (average, p50, p95, p99)
 *   - token tracking (prompt + completion)
 *   - provider health: circuit opens after consecutive failures
 *   - provider health: circuit recovers (half-open -> closed) on success
 *   - GET /metrics endpoint response
 *   - GET /stats endpoint response
 *   - GET /health/providers endpoint response
 *   - metrics endpoints are accessible without auth (public)
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

// Per-provider behavior: map providerId -> { failTimes, failStatus, delayMs }
const providerBehavior = {};

function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const auth = req.headers.authorization || '';
        let providerId = 'unknown';
        if (auth.includes('primary-key')) providerId = 'primary';
        else if (auth.includes('secondary-key')) providerId = 'secondary';

        const behavior = providerBehavior[providerId] || {};
        if (behavior.failTimes && behavior.failTimes > 0) {
          behavior.failTimes -= 1;
          const status = behavior.failStatus || 503;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Simulated ${status}` } }));
          return;
        }

        if (behavior.delayMs) {
          setTimeout(() => respond(), behavior.delayMs);
        } else {
          respond();
        }

        function respond() {
          if (req.url === '/chat/completions') {
            let received;
            try { received = JSON.parse(body); } catch { received = {}; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'chatcmpl-mock', object: 'chat.completion', created: 1700000000,
              model: received.model || 'mock',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
            return;
          }
          if (req.url === '/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
            return;
          }
          res.writeHead(404); res.end('{}');
        }
      });
    });
    mockServer.listen(0, '127.0.0.1', () => { mockPort = mockServer.address().port; resolve(); });
  });
}

function writeProviderConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-metrics-'));
  const base = `http://127.0.0.1:${mockPort}`;

  const primary = {
    id: 'primary', name: 'Primary', enabled: true,
    adapter: 'openai', baseURL: base, apiKeys: ['primary-key'],
    supportedModels: ['mock-model', 'shared-model'], priority: 1, timeout: 5000,
  };
  const secondary = {
    id: 'secondary', name: 'Secondary', enabled: true,
    adapter: 'openai', baseURL: base, apiKeys: ['secondary-key'],
    supportedModels: ['shared-model', 'secondary-only'], priority: 2, timeout: 5000,
  };
  fs.writeFileSync(path.join(tmpProvidersDir, 'primary.json'), JSON.stringify(primary));
  fs.writeFileSync(path.join(tmpProvidersDir, 'secondary.json'), JSON.stringify(secondary));
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

async function testMetricsAfterSuccess() {
  const { metricsCollector } = require('../src/services');
  metricsCollector.reset();
  await post('/v1/chat/completions', { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });
  const snap = metricsCollector.getSnapshot();
  const ok =
    snap.global.totalRequests >= 1 &&
    snap.global.successfulRequests >= 1 &&
    snap.providers['primary'] && snap.providers['primary'].totalRequests >= 1;
  record('metrics: updated after success (global + provider)', ok, `total=${snap.global.totalRequests}, success=${snap.global.successfulRequests}`);
}

async function testTokenTracking() {
  const { metricsCollector } = require('../src/services');
  metricsCollector.reset();
  await post('/v1/chat/completions', { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });
  const snap = metricsCollector.getSnapshot();
  const ok =
    snap.global.promptTokens >= 10 &&
    snap.global.completionTokens >= 5 &&
    snap.global.totalTokens >= 15;
  record('metrics: token tracking (prompt + completion)', ok, `prompt=${snap.global.promptTokens}, completion=${snap.global.completionTokens}`);
}

async function testMetricsAfterFailure() {
  const { metricsCollector, healthMonitor, apiKeyManager } = require('../src/services');
  metricsCollector.reset();
  healthMonitor.reset();
  providerBehavior.primary = { failTimes: 99, failStatus: 500 };
  await post('/v1/chat/completions', { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });
  delete providerBehavior.primary;
  apiKeyManager.enableKey('primary', 'primary-key');

  const snap = metricsCollector.getSnapshot();
  const ok =
    snap.global.failedRequests >= 1 &&
    snap.providers['primary'] && snap.providers['primary'].failedRequests >= 1;
  record('metrics: updated after failure', ok, `failed=${snap.global.failedRequests}, provider failed=${snap.providers['primary'] && snap.providers['primary'].failedRequests}`);
}

async function testRetryTracking() {
  const { metricsCollector, healthMonitor, apiKeyManager } = require('../src/services');
  metricsCollector.reset();
  healthMonitor.reset();
  apiKeyManager.enableKey('primary', 'primary-key');
  apiKeyManager.reportSuccess('primary', 'primary-key'); // reset consecutive failures
  // Fail once then succeed (retry)
  providerBehavior.primary = { failTimes: 1, failStatus: 503 };
  await post('/v1/chat/completions', { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });
  delete providerBehavior.primary;
  apiKeyManager.enableKey('primary', 'primary-key');

  const snap = metricsCollector.getSnapshot();
  const ok =
    snap.global.successfulRequests >= 1 &&
    snap.global.retryCount >= 1;
  record('metrics: retry count tracked', ok, `success=${snap.global.successfulRequests}, retries=${snap.global.retryCount}`);
}

async function testFallbackTracking() {
  const { metricsCollector, healthMonitor, apiKeyManager } = require('../src/services');
  metricsCollector.reset();
  healthMonitor.reset();
  apiKeyManager.enableKey('primary', 'primary-key'); // ensure key is active
  apiKeyManager.reportSuccess('primary', 'primary-key'); // reset consecutive failures
  apiKeyManager.enableKey('secondary', 'secondary-key'); // ensure key is active
  apiKeyManager.reportSuccess('secondary', 'secondary-key'); // reset consecutive failures
  // Primary fails permanently, secondary succeeds (fallback)
  providerBehavior.primary = { failTimes: 99, failStatus: 503 };
  await post('/v1/chat/completions', { model: 'shared-model', messages: [{ role: 'user', content: 'hi' }] });
  delete providerBehavior.primary;
  apiKeyManager.enableKey('primary', 'primary-key');
  apiKeyManager.enableKey('secondary', 'secondary-key');

  const snap = metricsCollector.getSnapshot();
  const ok =
    snap.global.successfulRequests >= 1 &&
    snap.global.fallbackCount >= 1 &&
    snap.providers['secondary'] && snap.providers['secondary'].successfulRequests >= 1;
  record('metrics: fallback count tracked', ok, `success=${snap.global.successfulRequests}, fallback=${snap.global.fallbackCount}`);
}

async function testLatencyTracking() {
  const { metricsCollector, healthMonitor } = require('../src/services');
  metricsCollector.reset();
  healthMonitor.reset();
  // Send a few requests to collect latency samples
  for (let i = 0; i < 5; i += 1) {
    await post('/v1/chat/completions', { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });
  }
  const snap = metricsCollector.getSnapshot();
  const ok =
    typeof snap.global.averageLatencyMs === 'number' && snap.global.averageLatencyMs >= 0 &&
    typeof snap.global.p50LatencyMs === 'number' &&
    typeof snap.global.p95LatencyMs === 'number' &&
    typeof snap.global.p99LatencyMs === 'number' &&
    snap.global.sampleCount >= 5;
  record('metrics: latency tracked (average, p50, p95, p99)', ok, `avg=${snap.global.averageLatencyMs}, p50=${snap.global.p50LatencyMs}, p95=${snap.global.p95LatencyMs}, samples=${snap.global.sampleCount}`);
}

async function testProviderHealthCircuitOpen() {
  const { healthMonitor, metricsCollector, apiKeyManager } = require('../src/services');
  healthMonitor.reset();
  metricsCollector.reset();
  // Create a fresh health monitor with a low threshold for the test.
  const { ProviderHealthMonitor } = require('../src/services');
  const hm = new ProviderHealthMonitor({ failureThreshold: 3, resetTimeoutMs: 100 });

  // Simulate 3 consecutive failures
  for (let i = 0; i < 3; i += 1) {
    hm.recordFailure({ providerId: 'test-prov' });
  }
  const health = hm.getHealth('test-prov');
  const ok = health && health.circuitState === 'open' && health.consecutiveFailures === 3;
  record('health: circuit opens after threshold failures', ok, `state=${health && health.circuitState}, failures=${health && health.consecutiveFailures}`);
}

async function testProviderHealthRecovery() {
  const { ProviderHealthMonitor } = require('../src/services');
  const hm = new ProviderHealthMonitor({ failureThreshold: 3, resetTimeoutMs: 50 });

  // Open the circuit
  for (let i = 0; i < 3; i += 1) {
    hm.recordFailure({ providerId: 'test-prov' });
  }
  let health = hm.getHealth('test-prov');
  const openedOk = health.circuitState === 'open';

  // Wait for reset timeout, then isAvailable should transition to half-open
  await new Promise((r) => setTimeout(r, 60));
  const available = hm.isAvailable('test-prov'); // should return true (half-open probe)
  health = hm.getHealth('test-prov');
  const halfOpenOk = health.circuitState === 'half-open' || available;

  // A success closes the circuit
  hm.recordSuccess({ providerId: 'test-prov' });
  health = hm.getHealth('test-prov');
  const closedOk = health.circuitState === 'closed' && health.consecutiveFailures === 0;

  const ok = openedOk && halfOpenOk && closedOk;
  record('health: circuit recovers (open -> half-open -> closed)', ok, `opened=${openedOk}, halfOpen=${halfOpenOk}, closed=${closedOk}`);
}

async function testHealthSuccessRate() {
  const { ProviderHealthMonitor } = require('../src/services');
  const hm = new ProviderHealthMonitor({});
  hm.recordSuccess({ providerId: 'p1', latencyMs: 100 });
  hm.recordSuccess({ providerId: 'p1', latencyMs: 200 });
  hm.recordFailure({ providerId: 'p1' });
  const health = hm.getHealth('p1');
  // 2 success / 3 total = 66.67%
  const ok = health && health.successRate === 66.67 && health.averageLatencyMs === 150;
  record('health: success rate + average latency', ok, `rate=${health && health.successRate}, avg=${health && health.averageLatencyMs}`);
}

async function testMetricsEndpoint() {
  // Ensure at least one request has been made
  await post('/v1/chat/completions', { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });
  const res = await get('/metrics');
  const ok =
    res.status === 200 &&
    res.body.global &&
    typeof res.body.global.totalRequests === 'number' &&
    res.body.providers &&
    typeof res.body.activeApiKeys === 'number' &&
    typeof res.body.activeProviders === 'number';
  record('GET /metrics endpoint', ok, `status=${res.status}, total=${res.body && res.body.global && res.body.global.totalRequests}`);
}

async function testStatsEndpoint() {
  const res = await get('/stats');
  const ok =
    res.status === 200 &&
    res.body.global &&
    typeof res.body.global.p50LatencyMs === 'number' &&
    res.body.providers;
  record('GET /stats endpoint', ok, `status=${res.status}`);
}

async function testHealthProvidersEndpoint() {
  const res = await get('/health/providers');
  const ok =
    res.status === 200 &&
    res.body.providers;
  record('GET /health/providers endpoint', ok, `status=${res.status}`);
}

async function testMetricsEndpointsNoAuth() {
  // The metrics endpoints should be accessible without auth even when
  // auth is enabled. We test in open-gateway mode (no keys configured),
  // but verify the endpoints respond without an Authorization header.
  const res = await get('/metrics');
  record('metrics endpoints accessible without auth', res.status === 200, `status=${res.status}`);
}

async function testActiveProvidersCount() {
  const res = await get('/metrics');
  // We have 2 enabled providers in the test config
  const ok = res.body.activeProviders === 2;
  record('metrics: activeProviders count', ok, `count=${res.body && res.body.activeProviders}`);
}

async function main() {
  console.log('=== Metrics & Monitoring Integration Tests ===\n');
  await startMockProvider();
  writeProviderConfigs();

  const { providerManager, apiKeyManager } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());

  await startExpressServer();

  try {
    await testMetricsAfterSuccess();
    await testTokenTracking();
    await testMetricsAfterFailure();
    await testRetryTracking();
    await testFallbackTracking();
    await testLatencyTracking();
    await testProviderHealthCircuitOpen();
    await testProviderHealthRecovery();
    await testHealthSuccessRate();
    await testMetricsEndpoint();
    await testStatsEndpoint();
    await testHealthProvidersEndpoint();
    await testMetricsEndpointsNoAuth();
    await testActiveProvidersCount();
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
