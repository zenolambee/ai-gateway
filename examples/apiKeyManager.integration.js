/**
 * Integration test: Chat Completions + ApiKeyManager rotation/cooldown.
 *
 * Run:  node examples/apiKeyManager.integration.js
 *
 * Spins up a mock provider that records the Authorization header on every
 * request and can be switched to return 429 for specific keys to trigger
 * cooldown. Then drives the full stack through the real Chat Completions
 * endpoint and asserts that:
 *   - keys rotate round-robin across requests
 *   - a 429 response puts the used key in cooldown
 *   - subsequent requests skip the cooling-down key
 *   - stats are tracked
 *   - manual disable/enable is honored
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

let mockProviderServer;
let mockProviderPort;
let expressServer;
let expressPort;
let tmpProvidersDir;

const seenAuthorizations = [];
let rateLimitedKeys = new Set();

function startMockProvider() {
  return new Promise((resolve) => {
    mockProviderServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const auth = req.headers.authorization || '';
        seenAuthorizations.push(auth);

        // If this key is flagged to return 429, do so
        const key = auth.replace('Bearer ', '');
        if (rateLimitedKeys.has(key)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Too many requests' } }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: 1700000000,
          model: 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    mockProviderServer.listen(0, '127.0.0.1', () => {
      mockProviderPort = mockProviderServer.address().port;
      resolve();
    });
  });
}

function writeProviderConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-keys-'));
  const provider = {
    id: 'mock',
    name: 'Mock Provider',
    enabled: true,
    baseURL: `http://127.0.0.1:${mockProviderPort}`,
    apiKeys: ['alpha', 'beta', 'gamma'],
    supportedModels: ['mock-model'],
    priority: 1,
    timeout: 5000,
  };
  fs.writeFileSync(path.join(tmpProvidersDir, 'mock.json'), JSON.stringify(provider));
}

function startExpressServer() {
  return new Promise((resolve) => {
    expressServer = app.listen(0, '127.0.0.1', () => {
      expressPort = expressServer.address().port;
      resolve();
    });
  });
}

function chat() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });
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

async function testRoundRobinAcrossRequests() {
  seenAuthorizations.length = 0;
  await chat(); await chat(); await chat(); await chat();
  const keys = seenAuthorizations.map((a) => a.replace('Bearer ', ''));
  record(
    'keys rotate round-robin across requests',
    keys[0] === 'alpha' && keys[1] === 'beta' && keys[2] === 'gamma' && keys[3] === 'alpha',
    `keys=${keys.join(',')}`
  );
}

async function testCooldownOn429() {
  const { apiKeyManager, providerManager } = require('../src/services');
  // Reset key state so alpha is the first key in the round-robin cycle.
  apiKeyManager.load(providerManager.listProviders());

  // Flag 'alpha' to return 429. Because the gateway retries on a different
  // key after a 429, the client typically still receives a 200 — but alpha
  // ends up RATE_LIMITED in the manager and is skipped on subsequent calls.
  rateLimitedKeys.add('alpha');
  seenAuthorizations.length = 0;

  let clientSaw429 = false;
  for (let i = 0; i < 6; i += 1) {
    const res = await chat();
    if (res.status === 429) clientSaw429 = true;
  }
  record('client receives 200 (retry masks 429)', !clientSaw429, `clientSaw429=${clientSaw429}`);

  const status = apiKeyManager.getKeyStatus('mock');
  const alpha = status.find((k) => k.key === '****alpha'.slice(-4) || k.key.endsWith('lpha'));
  record('alpha key is RATE_LIMITED after 429', alpha && alpha.status === 'RATE_LIMITED', `status=${alpha && alpha.status}`);

  // Subsequent requests should skip alpha (it is RATE_LIMITED, not ACTIVE)
  rateLimitedKeys.delete('alpha');
  seenAuthorizations.length = 0;
  await chat(); await chat(); await chat();
  const keys = seenAuthorizations.map((a) => a.replace('Bearer ', ''));
  record('rate-limited key is skipped', !keys.includes('alpha'), `keys=${keys.join(',')}`);
}

async function testStatsTracked() {
  const { apiKeyManager } = require('../src/services');
  const status = apiKeyManager.getKeyStatus('mock');
  const totalReqs = status.reduce((s, k) => s + k.stats.totalRequests, 0);
  const totalSuccess = status.reduce((s, k) => s + k.stats.successCount, 0);
  const totalFail = status.reduce((s, k) => s + k.stats.failureCount, 0);
  record('stats.totalRequests > 0', totalReqs > 0, `total=${totalReqs}`);
  record('stats.successCount > 0', totalSuccess > 0, `ok=${totalSuccess}`);
  record('stats.failureCount > 0', totalFail > 0, `fail=${totalFail}`);
}

async function testManualDisableEnable() {
  const { apiKeyManager } = require('../src/services');
  apiKeyManager.disableKey('mock', 'beta');
  seenAuthorizations.length = 0;
  await chat(); await chat(); await chat();
  const keys = seenAuthorizations.map((a) => a.replace('Bearer ', ''));
  record('manually disabled key is skipped', !keys.includes('beta'), `keys=${keys.join(',')}`);

  apiKeyManager.enableKey('mock', 'beta');
  seenAuthorizations.length = 0;
  await chat(); await chat(); await chat();
  const keys2 = seenAuthorizations.map((a) => a.replace('Bearer ', ''));
  record('re-enabled key is used again', keys2.includes('beta'), `keys=${keys2.join(',')}`);
}

async function main() {
  console.log('=== ApiKeyManager Integration Tests ===\n');
  await startMockProvider();
  writeProviderConfigs();

  const { providerManager, apiKeyManager } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());

  await startExpressServer();

  try {
    await testRoundRobinAcrossRequests();
    await testCooldownOn429();
    await testStatsTracked();
    await testManualDisableEnable();
  } finally {
    await new Promise((r) => expressServer.close(r));
    await new Promise((r) => mockProviderServer.close(r));
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
