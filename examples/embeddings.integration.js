/**
 * Integration test for POST /v1/embeddings (OpenAI Embeddings API).
 *
 * Run:  node examples/embeddings.integration.js
 *
 * Spins up a mock provider and drives the full stack:
 *   request -> EmbeddingsService -> RequestExecutor (retry + fallback)
 *   -> HttpClient -> mock -> normalize to OpenAI Embeddings format
 *
 * Covers:
 *   - 200 success with string input (OpenAI-compatible response shape)
 *   - 200 success with multiple inputs (array)
 *   - encoding_format + dimensions forwarded to the provider
 *   - bare-array provider response normalized into OpenAI list shape
 *   - unsupported provider (Anthropic-style) -> 400 embeddings_not_supported
 *   - validation errors: missing model, missing input, wrong input type,
 *     empty array, non-string array item, bad encoding_format, bad dimensions
 *   - stream:true rejected with 400 (embeddings never stream)
 *   - retry on transient 503 (mock flaps once then succeeds)
 *   - fallback to a second provider when the first fails permanently
 *   - unknown model -> 404 model_not_found
 *   - chat completions + responses + models endpoints still work
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

// Per-provider behavior: map providerId -> { failTimes, failStatus, responseShape }
const providerBehavior = {};

// Record of the last received embeddings request (per-provider keyed)
let lastEmbeddingsRequest = null;
let lastEmbeddingsProvider = null;

function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const url = req.url;
        const auth = req.headers.authorization || '';

        let providerId = 'unknown';
        if (auth.includes('primary-key')) providerId = 'primary';
        else if (auth.includes('secondary-key')) providerId = 'secondary';
        else if (auth.includes('flaky-key')) providerId = 'flaky';
        else if (auth.includes('anthropic-key')) providerId = 'anthropic';

        if (url === '/embeddings') {
          const behavior = providerBehavior[providerId] || {};
          if (behavior.failTimes && behavior.failTimes > 0) {
            behavior.failTimes -= 1;
            const status = behavior.failStatus || 503;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `Simulated ${status}` } }));
            return;
          }

          let received;
          try { received = JSON.parse(body); } catch { received = {}; }
          lastEmbeddingsRequest = received;
          lastEmbeddingsProvider = providerId;

          // Determine input count to size the response.
          const inputs = Array.isArray(received.input) ? received.input : [received.input];
          const n = inputs.length;

          if (behavior.responseShape === 'bareArray') {
            // Bare array of vectors (not OpenAI-shaped) — the adapter must
            // normalize this into the list shape.
            const data = inputs.map(() => [0.1, 0.2, 0.3]);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            return;
          }

          // OpenAI-shaped response
          const data = [];
          for (let i = 0; i < n; i += 1) {
            data.push({ object: 'embedding', embedding: [0.1 * i, 0.2, 0.3], index: i });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            object: 'list',
            data,
            model: received.model || 'mock-embed',
            usage: { prompt_tokens: 5, total_tokens: 5 },
          }));
          return;
        }

        // Fallback chat completions / messages / responses endpoints for the
        // "still works" sanity checks.
        if (url === '/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion', created: 1700000000,
            model: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
          return;
        }
        if (url === '/responses') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'resp-mock', object: 'response', created_at: 1700000000,
            model: 'mock-model', status: 'completed',
            output: [{ type: 'message', id: 'msg-1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }));
          return;
        }
        if (url === '/messages') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_mock', type: 'message', role: 'assistant',
            content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Not found' } }));
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
}

function writeProviderConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-embeddings-'));

  const primary = {
    id: 'primary',
    name: 'Primary Embeddings',
    enabled: true,
    adapter: 'openai',
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['primary-key'],
    supportedModels: ['embed-model', 'shared-embed'],
    priority: 1,
    timeout: 5000,
  };
  const secondary = {
    id: 'secondary',
    name: 'Secondary Embeddings',
    enabled: true,
    adapter: 'openai',
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['secondary-key'],
    supportedModels: ['shared-embed', 'secondary-only-embed'],
    priority: 2,
    timeout: 5000,
  };
  const flaky = {
    id: 'flaky',
    name: 'Flaky Embeddings',
    enabled: true,
    adapter: 'openai',
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['flaky-key'],
    supportedModels: ['flaky-embed'],
    priority: 1,
    timeout: 5000,
  };
  const anthropicStyle = {
    id: 'anthropic-style',
    name: 'Anthropic Style',
    enabled: true,
    adapter: 'anthropic',
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['anthropic-key'],
    supportedModels: ['claude-embed'],
    priority: 1,
    timeout: 5000,
    anthropicVersion: '2023-06-01',
  };

  fs.writeFileSync(path.join(tmpProvidersDir, 'primary.json'), JSON.stringify(primary));
  fs.writeFileSync(path.join(tmpProvidersDir, 'secondary.json'), JSON.stringify(secondary));
  fs.writeFileSync(path.join(tmpProvidersDir, 'flaky.json'), JSON.stringify(flaky));
  fs.writeFileSync(path.join(tmpProvidersDir, 'anthropic.json'), JSON.stringify(anthropicStyle));
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
      host: '127.0.0.1', port: expressPort, method: 'POST', path: pathStr,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function testSuccessStringInput() {
  lastEmbeddingsRequest = null;
  const res = await request('/v1/embeddings', { model: 'embed-model', input: 'hello world' });
  const ok =
    res.status === 200 &&
    res.body.object === 'list' &&
    Array.isArray(res.body.data) &&
    res.body.data.length === 1 &&
    res.body.data[0].object === 'embedding' &&
    Array.isArray(res.body.data[0].embedding) &&
    res.body.data[0].index === 0 &&
    res.body.model === 'embed-model' &&
    res.body.usage && typeof res.body.usage.prompt_tokens === 'number';
  record('200 success with string input (OpenAI shape)', ok, `status=${res.status}, object=${res.body && res.body.object}`);
}

async function testSuccessMultipleInputs() {
  lastEmbeddingsRequest = null;
  const res = await request('/v1/embeddings', {
    model: 'embed-model', input: ['first', 'second', 'third'],
  });
  const ok =
    res.status === 200 &&
    res.body.data.length === 3 &&
    res.body.data[0].index === 0 &&
    res.body.data[1].index === 1 &&
    res.body.data[2].index === 2;
  record('200 success with multiple inputs (array)', ok, `status=${res.status}, n=${res.body && res.body.data && res.body.data.length}`);
}

async function testParamsForwarded() {
  lastEmbeddingsRequest = null;
  await request('/v1/embeddings', {
    model: 'embed-model', input: 'hi',
    encoding_format: 'base64', dimensions: 256,
  });
  const ok =
    lastEmbeddingsRequest &&
    lastEmbeddingsRequest.encoding_format === 'base64' &&
    lastEmbeddingsRequest.dimensions === 256;
  record('encoding_format + dimensions forwarded to provider', ok, `enc=${lastEmbeddingsRequest && lastEmbeddingsRequest.encoding_format}, dim=${lastEmbeddingsRequest && lastEmbeddingsRequest.dimensions}`);
}

async function testBareArrayResponseNormalized() {
  providerBehavior.primary = { responseShape: 'bareArray' };
  const res = await request('/v1/embeddings', { model: 'embed-model', input: ['a', 'b'] });
  delete providerBehavior.primary;
  const ok =
    res.status === 200 &&
    res.body.object === 'list' &&
    res.body.data.length === 2 &&
    res.body.data[0].object === 'embedding' &&
    Array.isArray(res.body.data[0].embedding) &&
    res.body.data[1].index === 1;
  record('bare-array provider response normalized to OpenAI list shape', ok, `status=${res.status}, object=${res.body && res.body.object}`);
}

async function testUnsupportedProvider() {
  // Anthropic-style provider serves 'claude-embed' but its adapter declares
  // supportsEmbeddings:false, so the executor must reject with 400
  // embeddings_not_supported — no provider call is made.
  lastEmbeddingsProvider = null;
  const res = await request('/v1/embeddings', { model: 'claude-embed', input: 'hi' });
  const ok =
    res.status === 400 &&
    res.body.error &&
    res.body.error.code === 'embeddings_not_supported' &&
    lastEmbeddingsProvider === null;
  record('unsupported provider -> 400 embeddings_not_supported (no provider call)', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testMissingModel() {
  const res = await request('/v1/embeddings', { input: 'hi' });
  const ok = res.status === 400 && res.body.error && /model/.test(res.body.error.message);
  record('missing model -> 400', ok, `status=${res.status}`);
}

async function testMissingInput() {
  const res = await request('/v1/embeddings', { model: 'embed-model' });
  const ok = res.status === 400 && res.body.error && /input/.test(res.body.error.message);
  record('missing input -> 400', ok, `status=${res.status}`);
}

async function testWrongInputType() {
  const res = await request('/v1/embeddings', { model: 'embed-model', input: 42 });
  const ok = res.status === 400 && res.body.error && /input/.test(res.body.error.message);
  record('input not string/array -> 400', ok, `status=${res.status}`);
}

async function testEmptyArrayInput() {
  const res = await request('/v1/embeddings', { model: 'embed-model', input: [] });
  const ok = res.status === 400 && res.body.error && /input/.test(res.body.error.message);
  record('empty array input -> 400', ok, `status=${res.status}`);
}

async function testNonStringArrayItem() {
  const res = await request('/v1/embeddings', { model: 'embed-model', input: ['ok', 7] });
  const ok = res.status === 400 && res.body.error && /input\[1\]/.test(res.body.error.message);
  record('non-string array item -> 400', ok, `status=${res.status}`);
}

async function testBadEncodingFormat() {
  const res = await request('/v1/embeddings', {
    model: 'embed-model', input: 'hi', encoding_format: 'binary',
  });
  const ok = res.status === 400 && res.body.error && /encoding_format/.test(res.body.error.message);
  record('invalid encoding_format -> 400', ok, `status=${res.status}`);
}

async function testBadDimensions() {
  const res = await request('/v1/embeddings', {
    model: 'embed-model', input: 'hi', dimensions: -3,
  });
  const ok = res.status === 400 && res.body.error && /dimensions/.test(res.body.error.message);
  record('non-positive dimensions -> 400', ok, `status=${res.status}`);
}

async function testStreamRejected() {
  const res = await request('/v1/embeddings', {
    model: 'embed-model', input: 'hi', stream: true,
  });
  const ok = res.status === 400 && res.body.error && /stream/i.test(res.body.error.message);
  record('stream:true rejected with 400 (embeddings never stream)', ok, `status=${res.status}`);
}

async function testUnknownModel() {
  const res = await request('/v1/embeddings', { model: 'no-such-model', input: 'hi' });
  const ok = res.status === 404 && res.body.error && res.body.error.code === 'model_not_found';
  record('unknown model -> 404 model_not_found', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testRetryOnTransientFailure() {
  providerBehavior.flaky = { failTimes: 1, failStatus: 503 };
  const res = await request('/v1/embeddings', { model: 'flaky-embed', input: 'hi' });
  const ok = res.status === 200 && res.body.object === 'list';
  record('retry on transient 503 -> 200', ok, `status=${res.status}`);
  delete providerBehavior.flaky;
}

async function testFallbackToSecondaryProvider() {
  // Primary fails permanently (all retries exhausted with 503) -> fallback
  // to the secondary provider which also serves 'shared-embed'.
  providerBehavior.primary = { failTimes: 99, failStatus: 503 };
  const res = await request('/v1/embeddings', { model: 'shared-embed', input: 'hi' });
  const ok = res.status === 200 && res.body.object === 'list';
  record('fallback to secondary provider -> 200', ok, `status=${res.status}`);
  delete providerBehavior.primary;
  // Re-enable the primary key (it was cooled down by the ApiKeyManager after
  // repeated failures) so subsequent tests can use it.
  const { apiKeyManager } = require('../src/services');
  apiKeyManager.enableKey('primary', 'primary-key');
}

async function testOpenAICompatibility() {
  // Verify the full response matches the OpenAI embeddings spec field-by-field.
  const res = await request('/v1/embeddings', { model: 'embed-model', input: ['one', 'two'] });
  const b = res.body;
  const ok =
    res.status === 200 &&
    b.object === 'list' &&
    Array.isArray(b.data) &&
    b.data.every((d) => d.object === 'embedding' && Array.isArray(d.embedding) && typeof d.index === 'number') &&
    typeof b.model === 'string' &&
    b.usage && typeof b.usage.prompt_tokens === 'number' && typeof b.usage.total_tokens === 'number';
  record('OpenAI-compatible response shape (object/embedding/index/usage)', ok, `status=${res.status}`);
}

async function testChatCompletionsStillWorks() {
  const res = await request('/v1/chat/completions', {
    model: 'embed-model',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  const ok = res.status === 200 && res.body.object === 'chat.completion';
  record('chat completions still works', ok, `status=${res.status}`);
}

async function testResponsesStillWorks() {
  const res = await request('/v1/responses', { model: 'embed-model', input: 'Hi' });
  const ok = res.status === 200 && res.body.object === 'response';
  record('responses API still works', ok, `status=${res.status}`);
}

async function testModelsEndpointStillWorks() {
  const res = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: expressPort, path: '/v1/models' }, (r) => {
      let c = ''; r.on('data', (d) => (c += d)); r.on('end', () => resolve({ status: r.statusCode, body: c }));
    }).on('error', reject);
  });
  const ok = res.status === 200;
  record('GET /v1/models still works', ok, `status=${res.status}`);
}

async function main() {
  console.log('=== Embeddings API Integration Tests ===\n');
  await startMockProvider();
  writeProviderConfigs();

  const { providerManager, apiKeyManager } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());

  await startExpressServer();

  try {
    await testSuccessStringInput();
    await testSuccessMultipleInputs();
    await testParamsForwarded();
    await testBareArrayResponseNormalized();
    await testUnsupportedProvider();
    await testMissingModel();
    await testMissingInput();
    await testWrongInputType();
    await testEmptyArrayInput();
    await testNonStringArrayItem();
    await testBadEncodingFormat();
    await testBadDimensions();
    await testStreamRejected();
    await testUnknownModel();
    await testRetryOnTransientFailure();
    await testFallbackToSecondaryProvider();
    await testOpenAICompatibility();
    await testChatCompletionsStillWorks();
    await testResponsesStillWorks();
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
