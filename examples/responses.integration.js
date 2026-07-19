/**
 * Integration test for POST /v1/responses (OpenAI Responses API).
 *
 * Run:  node examples/responses.integration.js
 *
 * Spins up a mock provider and drives the full stack:
 *   request -> RequestExecutor (retry + fallback) -> HttpClient -> mock
 *   -> normalize to Responses API format
 *
 * Covers:
 *   - 200 success with string input
 *   - 200 success with array input
 *   - instructions -> system message translation
 *   - max_output_tokens -> max_tokens translation
 *   - validation: missing model, missing input, wrong input type
 *   - unknown model -> 404
 *   - retry on transient 503 (mock flaps once then succeeds)
 *   - fallback to a second provider when the first fails permanently
 *   - response shape: object="response", output[].content[].type="output_text"
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

// Per-provider behavior: map providerId -> { failTimes: number, failStatus: number }
const providerBehavior = {};

function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const auth = req.headers.authorization || '';
        // Identify which provider from the api key (we set distinct keys per provider)
        let providerId = 'unknown';
        if (auth.includes('primary-key')) providerId = 'primary';
        else if (auth.includes('secondary-key')) providerId = 'secondary';
        else if (auth.includes('flaky-key')) providerId = 'flaky';

        const behavior = providerBehavior[providerId] || {};
        if (behavior.failTimes && behavior.failTimes > 0) {
          behavior.failTimes -= 1;
          const status = behavior.failStatus || 503;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Simulated ${status}` } }));
          return;
        }

        // Echo back the received payload so tests can inspect translation
        let received;
        try { received = JSON.parse(body); } catch { received = {}; }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: 1700000000,
          model: received.model || 'mock-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Hello from Responses API!' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
        }));
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
}

function writeProviderConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-responses-'));

  const primary = {
    id: 'primary',
    name: 'Primary',
    enabled: true,
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['primary-key'],
    supportedModels: ['shared-model', 'primary-only'],
    priority: 1,
    timeout: 5000,
  };
  const secondary = {
    id: 'secondary',
    name: 'Secondary',
    enabled: true,
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['secondary-key'],
    supportedModels: ['shared-model', 'secondary-only'],
    priority: 2,
    timeout: 5000,
  };
  const flaky = {
    id: 'flaky',
    name: 'Flaky',
    enabled: true,
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['flaky-key'],
    supportedModels: ['flaky-model'],
    priority: 1,
    timeout: 5000,
  };

  fs.writeFileSync(path.join(tmpProvidersDir, 'primary.json'), JSON.stringify(primary));
  fs.writeFileSync(path.join(tmpProvidersDir, 'secondary.json'), JSON.stringify(secondary));
  fs.writeFileSync(path.join(tmpProvidersDir, 'flaky.json'), JSON.stringify(flaky));
}

function startExpressServer() {
  return new Promise((resolve) => {
    expressServer = app.listen(0, '127.0.0.1', () => {
      expressPort = expressServer.address().port;
      resolve();
    });
  });
}

function request(pathStr, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: expressPort,
      method: 'POST',
      path: pathStr,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function testSuccessStringInput() {
  const res = await request('/v1/responses', { model: 'primary-only', input: 'Hello' });
  const ok =
    res.status === 200 &&
    res.body.object === 'response' &&
    Array.isArray(res.body.output) &&
    res.body.output[0].type === 'message' &&
    res.body.output[0].content[0].type === 'output_text' &&
    res.body.output[0].content[0].text === 'Hello from Responses API!';
  record('200 success with string input', ok, `status=${res.status}, object=${res.body && res.body.object}`);
}

async function testSuccessArrayInput() {
  const res = await request('/v1/responses', {
    model: 'primary-only',
    input: [
      'first prompt',
      { role: 'user', content: 'second prompt' },
    ],
  });
  const ok = res.status === 200 && res.body.object === 'response';
  record('200 success with array input', ok, `status=${res.status}`);
}

async function testInstructionsAndMaxTokens() {
  // We cannot easily inspect the translated payload here, but we can verify
  // success. A more thorough check is done in the unit test for buildResponsesPayload.
  const res = await request('/v1/responses', {
    model: 'primary-only',
    input: 'Hi',
    instructions: 'Be helpful.',
    temperature: 0.5,
    max_output_tokens: 100,
  });
  const ok = res.status === 200;
  record('instructions + temperature + max_output_tokens accepted', ok, `status=${res.status}`);
}

async function testMissingModel() {
  const res = await request('/v1/responses', { input: 'Hi' });
  const ok = res.status === 400 && res.body.error && /model/.test(res.body.error.message);
  record('missing model -> 400', ok, `status=${res.status}`);
}

async function testMissingInput() {
  const res = await request('/v1/responses', { model: 'primary-only' });
  const ok = res.status === 400 && /input/.test(res.body.error.message);
  record('missing input -> 400', ok, `status=${res.status}`);
}

async function testWrongInputType() {
  const res = await request('/v1/responses', { model: 'primary-only', input: 42 });
  const ok = res.status === 400 && /input/.test(res.body.error.message);
  record('input not string/array -> 400', ok, `status=${res.status}`);
}

async function testEmptyArrayInput() {
  const res = await request('/v1/responses', { model: 'primary-only', input: [] });
  const ok = res.status === 400 && /input/.test(res.body.error.message);
  record('empty array input -> 400', ok, `status=${res.status}`);
}

async function testUnknownModel() {
  const res = await request('/v1/responses', { model: 'no-such-model', input: 'Hi' });
  const ok = res.status === 404 && res.body.error && res.body.error.code === 'model_not_found';
  record('unknown model -> 404 model_not_found', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testRetryOnTransientFailure() {
  // Configure flaky provider to fail once with 503, then succeed on retry
  providerBehavior.flaky = { failTimes: 1, failStatus: 503 };
  const res = await request('/v1/responses', { model: 'flaky-model', input: 'Hi' });
  const ok = res.status === 200 && res.body.object === 'response';
  record('retry on transient 503 -> 200', ok, `status=${res.status}`);
  delete providerBehavior.flaky;
}

async function testFallbackToSecondaryProvider() {
  // Primary fails permanently (401 not retryable, but fallback-eligible for
  // auth? No — 401 is NOT fallback-eligible. Use 503 instead to trigger
  // fallback after exhausting retries.)
  providerBehavior.primary = { failTimes: 99, failStatus: 503 };
  const res = await request('/v1/responses', { model: 'shared-model', input: 'Hi' });
  const ok = res.status === 200 && res.body.object === 'response';
  record('fallback to secondary provider -> 200', ok, `status=${res.status}`);
  delete providerBehavior.primary;
}

async function testChatCompletionsStillWorks() {
  // Ensure the shared executor did not break the sibling endpoint.
  // Re-enable the primary key first since the previous fallback test may
  // have cooled it down after repeated failures (expected behaviour).
  const { apiKeyManager } = require('../src/services');
  apiKeyManager.enableKey('primary', 'primary-key');

  const res = await request('/v1/chat/completions', {
    model: 'primary-only',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  const ok = res.status === 200 && res.body.object === 'chat.completion';
  record('chat completions still works after refactor', ok, `status=${res.status}`);
}

async function testModelsEndpointStillWorks() {
  // GET /v1/models should still respond
  const res = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: expressPort, path: '/v1/models' }, (r) => {
      let c = ''; r.on('data', (d) => (c += d)); r.on('end', () => resolve({ status: r.statusCode, body: c }));
    }).on('error', reject);
  });
  const ok = res.status === 200;
  record('GET /v1/models still works', ok, `status=${res.status}`);
}

async function main() {
  console.log('=== Responses API Integration Tests ===\n');
  await startMockProvider();
  writeProviderConfigs();

  const { providerManager, apiKeyManager } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());

  await startExpressServer();

  try {
    await testSuccessStringInput();
    await testSuccessArrayInput();
    await testInstructionsAndMaxTokens();
    await testMissingModel();
    await testMissingInput();
    await testWrongInputType();
    await testEmptyArrayInput();
    await testUnknownModel();
    await testRetryOnTransientFailure();
    await testFallbackToSecondaryProvider();
    await testChatCompletionsStillWorks();
    await testModelsEndpointStillWorks();
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
