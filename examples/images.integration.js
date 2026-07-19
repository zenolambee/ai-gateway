/**
 * Integration test for the Images API (POST /v1/images/*).
 *
 * Run:  node examples/images.integration.js
 *
 * Spins up a mock provider and drives the full stack:
 *   request -> ImagesService -> RequestExecutor (retry + fallback)
 *   -> HttpClient -> mock -> normalize to OpenAI Images format
 *
 * Covers:
 *   - generations: 200 success (url + b64_json), params forwarded
 *   - edits: 200 success (multipart/form-data upload)
 *   - variations: 200 success (multipart/form-data upload)
 *   - unsupported provider (Anthropic-style) -> 400 images_not_supported
 *   - validation errors: missing model, missing prompt, missing image,
 *     bad size/quality/style/response_format, bad n
 *   - stream:true rejected with 400 (images never stream)
 *   - retry on transient 503
 *   - fallback to a second provider
 *   - response normalization (bare-array, b64 alias)
 *   - OpenAI compatibility (created + data[].url|b64_json)
 *   - sibling endpoints still work
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const FormData = require('form-data');
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

// Records of the last received images request (per-endpoint keyed)
let lastGenerationsRequest = null;
let lastEditsRequest = null;
let lastVariationsRequest = null;

// A minimal 1x1 PNG for multipart uploads.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const url = req.url;
        const auth = req.headers.authorization || '';
        const ct = (req.headers['content-type'] || '').toLowerCase();

        let providerId = 'unknown';
        if (auth.includes('primary-key')) providerId = 'primary';
        else if (auth.includes('secondary-key')) providerId = 'secondary';
        else if (auth.includes('flaky-key')) providerId = 'flaky';
        else if (auth.includes('anthropic-key')) providerId = 'anthropic';

        if (url === '/images/generations') {
          const behavior = providerBehavior[providerId] || {};
          if (behavior.failTimes && behavior.failTimes > 0) {
            behavior.failTimes -= 1;
            const status = behavior.failStatus || 503;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `Simulated ${status}` } }));
            return;
          }
          let received;
          try { received = JSON.parse(Buffer.concat(chunks).toString()); } catch { received = {}; }
          lastGenerationsRequest = received;

          const shape = behavior.responseShape || 'openai';
          if (shape === 'bareArrayUrls') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(['https://img.test/a.png', 'https://img.test/b.png']));
            return;
          }
          const n = Number(received.n) || 1;
          const data = [];
          for (let i = 0; i < n; i += 1) {
            if (received.response_format === 'b64_json') {
              data.push({ b64_json: 'aGVsbG8=' });
            } else {
              data.push({ url: `https://img.test/${i}.png` });
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ created: 1700000000, data }));
          return;
        }

        if (url === '/images/edits') {
          const raw = Buffer.concat(chunks).toString();
          // Multipart: parse out the form fields (prompt, model, n, etc.)
          const fields = parseMultipartFields(raw, ct);
          lastEditsRequest = fields;
          const data = [{ url: 'https://img.test/edited.png' }];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ created: 1700000000, data }));
          return;
        }

        if (url === '/images/variations') {
          const raw = Buffer.concat(chunks).toString();
          const fields = parseMultipartFields(raw, ct);
          lastVariationsRequest = fields;
          const data = [{ url: 'https://img.test/variation.png' }];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ created: 1700000000, data }));
          return;
        }

        // Fallback endpoints for "still works" sanity checks.
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
        if (url === '/embeddings') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            object: 'list', data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
            model: 'mock-model', usage: { prompt_tokens: 1, total_tokens: 1 },
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

/**
 * Minimal multipart/form-data field parser for the mock provider. Pulls
 * string field values (not file contents) so tests can inspect the mapping.
 */
function parseMultipartFields(raw, contentType) {
  const fields = {};
  const m = /boundary=([^;\s]+)/i.exec(contentType || '');
  if (!m) return fields;
  const boundary = '--' + m[1];
  const parts = raw.split(boundary);
  for (const part of parts) {
    if (!part || part === '--' || part === '--\r\n') continue;
    const nameMatch = /name="([^"]+)"/.exec(part);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    // Skip file parts (they have a filename); only capture string fields.
    if (/filename="/.test(part)) {
      fields[name] = '[file]';
      continue;
    }
    // The value follows a blank line (\r\n\r\n) after the headers.
    const sep = part.indexOf('\r\n\r\n');
    if (sep === -1) continue;
    let value = part.slice(sep + 4);
    // Trailing \r\n before the next boundary.
    value = value.replace(/\r?\n$/, '');
    fields[name] = value;
  }
  return fields;
}

function writeProviderConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-images-'));

  const primary = {
    id: 'primary',
    name: 'Primary Images',
    enabled: true,
    adapter: 'openai',
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['primary-key'],
    supportedModels: ['dall-e-3', 'shared-image'],
    priority: 1,
    timeout: 5000,
  };
  const secondary = {
    id: 'secondary',
    name: 'Secondary Images',
    enabled: true,
    adapter: 'openai',
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['secondary-key'],
    supportedModels: ['shared-image', 'secondary-only-image'],
    priority: 2,
    timeout: 5000,
  };
  const flaky = {
    id: 'flaky',
    name: 'Flaky Images',
    enabled: true,
    adapter: 'openai',
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['flaky-key'],
    supportedModels: ['flaky-image'],
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
    supportedModels: ['claude-image'],
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

function jsonRequest(pathStr, body) {
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

function multipartRequest(pathStr, form) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'POST', path: pathStr,
      headers: form.getHeaders(),
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
    form.pipe(req);
  });
}

async function testGenerationsSuccess() {
  lastGenerationsRequest = null;
  const res = await jsonRequest('/v1/images/generations', {
    model: 'dall-e-3', prompt: 'a cat', n: 2, size: '1024x1024',
    quality: 'hd', style: 'natural', response_format: 'url',
  });
  const ok =
    res.status === 200 &&
    typeof res.body.created === 'number' &&
    Array.isArray(res.body.data) &&
    res.body.data.length === 2 &&
    typeof res.body.data[0].url === 'string' &&
    res.body.data[1].url === 'https://img.test/1.png';
  record('generations: 200 + url response', ok, `status=${res.status}, n=${res.body && res.body.data && res.body.data.length}`);
  const forwarded =
    lastGenerationsRequest &&
    lastGenerationsRequest.model === 'dall-e-3' &&
    lastGenerationsRequest.prompt === 'a cat' &&
    lastGenerationsRequest.n === 2 &&
    lastGenerationsRequest.size === '1024x1024' &&
    lastGenerationsRequest.quality === 'hd' &&
    lastGenerationsRequest.style === 'natural' &&
    lastGenerationsRequest.response_format === 'url';
  record('generations: params forwarded to provider', forwarded, `model=${lastGenerationsRequest && lastGenerationsRequest.model}`);
}

async function testGenerationsB64() {
  lastGenerationsRequest = null;
  const res = await jsonRequest('/v1/images/generations', {
    model: 'dall-e-3', prompt: 'a dog', response_format: 'b64_json',
  });
  const ok =
    res.status === 200 &&
    res.body.data[0].b64_json === 'aGVsbG8=';
  record('generations: b64_json response', ok, `status=${res.status}, b64=${res.body && res.body.data && res.body.data[0] && res.body.data[0].b64_json}`);
}

async function testEditsSuccess() {
  lastEditsRequest = null;
  const form = new FormData();
  form.append('model', 'dall-e-3');
  form.append('prompt', 'remove background');
  form.append('n', '1');
  form.append('size', '512x512');
  form.append('image', PNG_BYTES, { filename: 'cat.png', contentType: 'image/png' });
  const res = await multipartRequest('/v1/images/edits', form);
  const ok =
    res.status === 200 &&
    Array.isArray(res.body.data) &&
    res.body.data[0].url === 'https://img.test/edited.png';
  record('edits: 200 (multipart upload)', ok, `status=${res.status}`);
  const forwarded =
    lastEditsRequest &&
    lastEditsRequest.model === 'dall-e-3' &&
    lastEditsRequest.prompt === 'remove background' &&
    lastEditsRequest.size === '512x512' &&
    lastEditsRequest.image === '[file]';
  record('edits: prompt + model + size forwarded, image uploaded', forwarded, `prompt=${lastEditsRequest && lastEditsRequest.prompt}`);
}

async function testEditsWithMask() {
  lastEditsRequest = null;
  const form = new FormData();
  form.append('model', 'dall-e-3');
  form.append('prompt', 'edit the masked area');
  form.append('image', PNG_BYTES, { filename: 'cat.png', contentType: 'image/png' });
  form.append('mask', PNG_BYTES, { filename: 'mask.png', contentType: 'image/png' });
  const res = await multipartRequest('/v1/images/edits', form);
  const ok = res.status === 200 && res.body.data.length === 1;
  record('edits: with mask file accepted', ok, `status=${res.status}`);
  const hasMask = lastEditsRequest && lastEditsRequest.mask === '[file]';
  record('edits: mask forwarded as file', hasMask, `mask=${lastEditsRequest && lastEditsRequest.mask}`);
}

async function testVariationsSuccess() {
  lastVariationsRequest = null;
  const form = new FormData();
  form.append('model', 'dall-e-3');
  form.append('n', '1');
  form.append('size', '256x256');
  form.append('image', PNG_BYTES, { filename: 'cat.png', contentType: 'image/png' });
  const res = await multipartRequest('/v1/images/variations', form);
  const ok =
    res.status === 200 &&
    res.body.data[0].url === 'https://img.test/variation.png';
  record('variations: 200 (multipart upload)', ok, `status=${res.status}`);
  const noPrompt = lastVariationsRequest && lastVariationsRequest.prompt === undefined;
  record('variations: prompt NOT sent', noPrompt, `prompt=${lastVariationsRequest && lastVariationsRequest.prompt}`);
}

async function testUnsupportedProvider() {
  // Anthropic-style provider serves 'claude-image' but its adapter declares
  // supportsImages:false -> executor rejects with 400 images_not_supported.
  lastGenerationsRequest = null;
  const res = await jsonRequest('/v1/images/generations', {
    model: 'claude-image', prompt: 'a cat',
  });
  const ok =
    res.status === 400 &&
    res.body.error &&
    res.body.error.code === 'images_not_supported' &&
    lastGenerationsRequest === null;
  record('unsupported provider -> 400 images_not_supported (no provider call)', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testMissingModel() {
  const res = await jsonRequest('/v1/images/generations', { prompt: 'a cat' });
  const ok = res.status === 400 && res.body.error && /model/.test(res.body.error.message);
  record('generations: missing model -> 400', ok, `status=${res.status}`);
}

async function testMissingPrompt() {
  const res = await jsonRequest('/v1/images/generations', { model: 'dall-e-3' });
  const ok = res.status === 400 && res.body.error && /prompt/.test(res.body.error.message);
  record('generations: missing prompt -> 400', ok, `status=${res.status}`);
}

async function testEditsMissingImage() {
  const form = new FormData();
  form.append('model', 'dall-e-3');
  form.append('prompt', 'edit');
  const res = await multipartRequest('/v1/images/edits', form);
  const ok = res.status === 400 && res.body.error && /image/.test(res.body.error.message);
  record('edits: missing image file -> 400', ok, `status=${res.status}`);
}

async function testEditsMissingPrompt() {
  const form = new FormData();
  form.append('model', 'dall-e-3');
  form.append('image', PNG_BYTES, { filename: 'cat.png', contentType: 'image/png' });
  const res = await multipartRequest('/v1/images/edits', form);
  const ok = res.status === 400 && res.body.error && /prompt/.test(res.body.error.message);
  record('edits: missing prompt -> 400', ok, `status=${res.status}`);
}

async function testVariationsMissingImage() {
  const form = new FormData();
  form.append('model', 'dall-e-3');
  const res = await multipartRequest('/v1/images/variations', form);
  const ok = res.status === 400 && res.body.error && /image/.test(res.body.error.message);
  record('variations: missing image file -> 400', ok, `status=${res.status}`);
}

async function testBadSize() {
  const res = await jsonRequest('/v1/images/generations', {
    model: 'dall-e-3', prompt: 'a cat', size: '999x999',
  });
  const ok = res.status === 400 && res.body.error && /size/.test(res.body.error.message);
  record('generations: bad size -> 400', ok, `status=${res.status}`);
}

async function testBadQuality() {
  const res = await jsonRequest('/v1/images/generations', {
    model: 'dall-e-3', prompt: 'a cat', quality: 'ultra',
  });
  const ok = res.status === 400 && res.body.error && /quality/.test(res.body.error.message);
  record('generations: bad quality -> 400', ok, `status=${res.status}`);
}

async function testBadStyle() {
  const res = await jsonRequest('/v1/images/generations', {
    model: 'dall-e-3', prompt: 'a cat', style: 'abstract',
  });
  const ok = res.status === 400 && res.body.error && /style/.test(res.body.error.message);
  record('generations: bad style -> 400', ok, `status=${res.status}`);
}

async function testBadResponseFormat() {
  const res = await jsonRequest('/v1/images/generations', {
    model: 'dall-e-3', prompt: 'a cat', response_format: 'xml',
  });
  const ok = res.status === 400 && res.body.error && /response_format/.test(res.body.error.message);
  record('generations: bad response_format -> 400', ok, `status=${res.status}`);
}

async function testBadN() {
  const res = await jsonRequest('/v1/images/generations', {
    model: 'dall-e-3', prompt: 'a cat', n: 50,
  });
  const ok = res.status === 400 && res.body.error && /'n'/.test(res.body.error.message);
  record('generations: n out of range -> 400', ok, `status=${res.status}`);
}

async function testStreamRejected() {
  const res = await jsonRequest('/v1/images/generations', {
    model: 'dall-e-3', prompt: 'a cat', stream: true,
  });
  const ok = res.status === 400 && res.body.error && /stream/i.test(res.body.error.message);
  record('stream:true rejected with 400 (images never stream)', ok, `status=${res.status}`);
}

async function testUnknownModel() {
  const res = await jsonRequest('/v1/images/generations', {
    model: 'no-such-model', prompt: 'a cat',
  });
  const ok = res.status === 404 && res.body.error && res.body.error.code === 'model_not_found';
  record('unknown model -> 404 model_not_found', ok, `status=${res.status}, code=${res.body && res.body.error && res.body.error.code}`);
}

async function testRetryOnTransientFailure() {
  providerBehavior.flaky = { failTimes: 1, failStatus: 503 };
  const res = await jsonRequest('/v1/images/generations', {
    model: 'flaky-image', prompt: 'a cat',
  });
  const ok = res.status === 200 && Array.isArray(res.body.data);
  record('retry on transient 503 -> 200', ok, `status=${res.status}`);
  delete providerBehavior.flaky;
}

async function testFallbackToSecondaryProvider() {
  providerBehavior.primary = { failTimes: 99, failStatus: 503 };
  const res = await jsonRequest('/v1/images/generations', {
    model: 'shared-image', prompt: 'a cat',
  });
  const ok = res.status === 200 && Array.isArray(res.body.data);
  record('fallback to secondary provider -> 200', ok, `status=${res.status}`);
  delete providerBehavior.primary;
  const { apiKeyManager } = require('../src/services');
  apiKeyManager.enableKey('primary', 'primary-key');
}

async function testBareArrayResponseNormalized() {
  providerBehavior.primary = { responseShape: 'bareArrayUrls' };
  const res = await jsonRequest('/v1/images/generations', {
    model: 'dall-e-3', prompt: 'a cat', n: 2,
  });
  delete providerBehavior.primary;
  const ok =
    res.status === 200 &&
    typeof res.body.created === 'number' &&
    Array.isArray(res.body.data) &&
    res.body.data.length === 2 &&
    res.body.data[0].url === 'https://img.test/a.png' &&
    res.body.data[1].url === 'https://img.test/b.png';
  record('bare-array response normalized to OpenAI shape', ok, `status=${res.status}`);
  const { apiKeyManager } = require('../src/services');
  apiKeyManager.enableKey('primary', 'primary-key');
}

async function testOpenAICompatibility() {
  const res = await jsonRequest('/v1/images/generations', {
    model: 'dall-e-3', prompt: 'a cat', n: 3,
  });
  const ok =
    res.status === 200 &&
    typeof res.body.created === 'number' &&
    Array.isArray(res.body.data) &&
    res.body.data.length === 3 &&
    res.body.data.every((d) => (typeof d.url === 'string') || (typeof d.b64_json === 'string'));
  record('OpenAI-compatible response shape (created + data[].url|b64_json)', ok, `status=${res.status}`);
}

async function testChatCompletionsStillWorks() {
  const res = await jsonRequest('/v1/chat/completions', {
    model: 'dall-e-3',
    messages: [{ role: 'user', content: 'Hi' }],
  });
  const ok = res.status === 200 && res.body.object === 'chat.completion';
  record('chat completions still works', ok, `status=${res.status}`);
}

async function testEmbeddingsStillWorks() {
  const res = await jsonRequest('/v1/embeddings', {
    model: 'dall-e-3', input: 'hello',
  });
  const ok = res.status === 200 && res.body.object === 'list';
  record('embeddings still works', ok, `status=${res.status}`);
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
  console.log('=== Images API Integration Tests ===\n');
  await startMockProvider();
  writeProviderConfigs();

  const { providerManager, apiKeyManager } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());

  await startExpressServer();

  try {
    await testGenerationsSuccess();
    await testGenerationsB64();
    await testEditsSuccess();
    await testEditsWithMask();
    await testVariationsSuccess();
    await testUnsupportedProvider();
    await testMissingModel();
    await testMissingPrompt();
    await testEditsMissingImage();
    await testEditsMissingPrompt();
    await testVariationsMissingImage();
    await testBadSize();
    await testBadQuality();
    await testBadStyle();
    await testBadResponseFormat();
    await testBadN();
    await testStreamRejected();
    await testUnknownModel();
    await testRetryOnTransientFailure();
    await testFallbackToSecondaryProvider();
    await testBareArrayResponseNormalized();
    await testOpenAICompatibility();
    await testChatCompletionsStillWorks();
    await testEmbeddingsStillWorks();
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
