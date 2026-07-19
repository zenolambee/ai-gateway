/**
 * Integration test for the Provider Adapter system.
 *
 * Run:  node examples/providerAdapter.integration.js
 *
 * Spins up two mock providers:
 *   - one that speaks OpenAI Chat Completions ("openai-compat")
 *   - one that speaks Anthropic Messages ("anthropic-style")
 *
 * Verifies that:
 *   - the adapter registry auto-selects the correct adapter per provider
 *   - OpenAI-compat provider: request/response pass-through
 *   - Anthropic provider: OpenAI -> Anthropic request mapping (system
 *     message lifted out, max_tokens injected), Anthropic -> OpenAI response
 *     mapping (content blocks -> choices, stop_reason -> finish_reason)
 *   - Responses API works on top of both adapters (translates to chat
 *     completions for the provider, then back to responses shape)
 *   - the Anthropic streaming format is translated into OpenAI
 *     chat.completion.chunk events
 *   - capability checks work
 *   - adding a new provider via config alone works (no source changes)
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

// Records of what the mock provider received
let lastOpenAIRequest = null;
let lastAnthropicRequest = null;
let lastAnthropicStreamRequest = null;

function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const url = req.url;

        // --- OpenAI-compatible endpoints ---
        if (url === '/chat/completions') {
          lastOpenAIRequest = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-openai',
            object: 'chat.completion',
            created: 1700000000,
            model: lastOpenAIRequest.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'Hello from OpenAI-compat!' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
          }));
          return;
        }
        if (url === '/responses') {
          lastOpenAIRequest = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'resp-openai',
            object: 'response',
            created_at: 1700000000,
            model: lastOpenAIRequest.model,
            status: 'completed',
            output: [{
              type: 'message',
              id: 'msg-1',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Hello from Responses!' }],
            }],
            usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
          }));
          return;
        }

        // --- Anthropic-style endpoints ---
        if (url === '/messages') {
          const isStream = body.includes('"stream":true');
          lastAnthropicRequest = JSON.parse(body);
          if (isStream) {
            lastAnthropicStreamRequest = lastAnthropicRequest;
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[],"model":"claude-3","stop_reason":null}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"from Anthropic!"}}\n\n');
            res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n');
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_anthropic',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello from Anthropic!' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 8, output_tokens: 6 },
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
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-adapters-'));
  const openaiCompat = {
    id: 'openai-compat',
    name: 'OpenAI Compatible',
    enabled: true,
    adapter: 'generic-openai',
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['oai-key'],
    supportedModels: ['oai-model'],
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
    supportedModels: ['claude-model'],
    priority: 2,
    timeout: 5000,
    anthropicVersion: '2023-06-01',
  };
  fs.writeFileSync(path.join(tmpProvidersDir, 'openai.json'), JSON.stringify(openaiCompat));
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
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function streamRequest(pathStr, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'POST', path: pathStr,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function parseSSEEvents(raw) {
  const events = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length) {
      const joined = dataLines.join('\n');
      events.push(joined === '[DONE]' ? '[DONE]' : (() => { try { return JSON.parse(joined); } catch { return joined; } })());
    }
  }
  return events;
}

async function testRegistryAutoSelect() {
  const { adapterRegistry } = require('../src/services');
  const { providerManager } = require('../src/services');
  const providers = providerManager.listProviders();
  const oaiProvider = providers.find((p) => p.id === 'openai-compat');
  const anthropicProvider = providers.find((p) => p.id === 'anthropic-style');
  const oaiAdapter = adapterRegistry.getAdapter(oaiProvider);
  const anthropicAdapter = adapterRegistry.getAdapter(anthropicProvider);
  record('registry selects generic-openai adapter', oaiAdapter.__adapterId === 'generic-openai', `id=${oaiAdapter.__adapterId}`);
  record('registry selects anthropic adapter', anthropicAdapter.__adapterId === 'anthropic', `id=${anthropicAdapter.__adapterId}`);
  record('anthropic adapter declares supportsReasoning', anthropicAdapter.supports('supportsReasoning'));
  record('openai adapter declares supportsStreaming', oaiAdapter.supports('supportsStreaming'));
}

async function testOpenAICompatChat() {
  lastOpenAIRequest = null;
  const res = await request('/v1/chat/completions', {
    model: 'oai-model', messages: [{ role: 'user', content: 'Hi' }], temperature: 0.5,
  });
  const ok = res.status === 200 && res.body.object === 'chat.completion' && res.body.choices[0].message.content === 'Hello from OpenAI-compat!';
  record('OpenAI-compat chat: 200 + correct response', ok, `status=${res.status}`);
  record('OpenAI-compat chat: temperature forwarded', lastOpenAIRequest && lastOpenAIRequest.temperature === 0.5, `temp=${lastOpenAIRequest && lastOpenAIRequest.temperature}`);
}

async function testOpenAICompatResponses() {
  lastOpenAIRequest = null;
  const res = await request('/v1/responses', {
    model: 'oai-model', input: 'Hi', instructions: 'Be helpful.',
  });
  const ok = res.status === 200 && res.body.object === 'response' && Array.isArray(res.body.output);
  record('OpenAI-compat responses: 200 + correct shape', ok, `status=${res.status}`);
}

async function testAnthropicChat() {
  lastAnthropicRequest = null;
  const res = await request('/v1/chat/completions', {
    model: 'claude-model',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ],
    max_tokens: 100,
  });
  // Verify Anthropic-specific request mapping
  const reqOk = lastAnthropicRequest
    && lastAnthropicRequest.system === 'You are helpful.'
    && !lastAnthropicRequest.messages.some((m) => m.role === 'system')
    && lastAnthropicRequest.max_tokens === 100;
  record('Anthropic: system message lifted to top-level system field', reqOk, `system=${lastAnthropicRequest && lastAnthropicRequest.system}`);
  // Verify Anthropic -> OpenAI response mapping
  const resOk = res.status === 200
    && res.body.object === 'chat.completion'
    && res.body.choices[0].message.content === 'Hello from Anthropic!'
    && res.body.choices[0].finish_reason === 'stop'
    && res.body.usage.prompt_tokens === 8;
  record('Anthropic: response mapped to OpenAI shape', resOk, `status=${res.status}, content=${res.body && res.body.choices && res.body.choices[0] && res.body.choices[0].message && res.body.choices[0].message.content}`);
}

async function testAnthropicResponses() {
  lastAnthropicRequest = null;
  const res = await request('/v1/responses', {
    model: 'claude-model', input: 'Hi', instructions: 'Be brief.',
  });
  // Verify the responses adapter sent a chat completions request to Anthropic
  const sentChat = lastAnthropicRequest && Array.isArray(lastAnthropicRequest.messages);
  record('Anthropic responses: sent as chat to /messages', sentChat, `messages=${lastAnthropicRequest && lastAnthropicRequest.messages && lastAnthropicRequest.messages.length}`);
  const ok = res.status === 200 && res.body.object === 'response' && res.body.output[0].content[0].text === 'Hello from Anthropic!';
  record('Anthropic responses: normalized to response shape', ok, `status=${res.status}`);
}

async function testAnthropicStreaming() {
  lastAnthropicStreamRequest = null;
  const res = await streamRequest('/v1/chat/completions', {
    model: 'claude-model',
    messages: [{ role: 'user', content: 'Hi' }],
    stream: true,
  });
  const ctOk = res.headers['content-type'] && res.headers['content-type'].includes('text/event-stream');
  const events = parseSSEEvents(res.body);
  // Anthropic text_delta "Hi " + "from Anthropic!" -> OpenAI delta content
  const deltas = events.filter((e) => e && e.choices && e.choices[0] && e.choices[0].delta && typeof e.choices[0].delta.content === 'string').map((e) => e.choices[0].delta.content).join('');
  const hasFinish = events.some((e) => e && e.choices && e.choices[0] && e.choices[0].finish_reason === 'stop');
  const hasDone = events.includes('[DONE]');
  record('Anthropic stream: text/event-stream', ctOk, `ct=${res.headers['content-type']}`);
  record('Anthropic stream: deltas translated to OpenAI chunks', deltas === 'Hi from Anthropic!', `deltas="${deltas}"`);
  record('Anthropic stream: finish_reason emitted', hasFinish);
  record('Anthropic stream: [DONE] terminator', hasDone);
  record('Anthropic stream: sent to /messages', lastAnthropicStreamRequest !== null, `stream=${lastAnthropicStreamRequest && lastAnthropicStreamRequest.stream}`);
}

async function testNewProviderViaConfigOnly() {
  // Add a brand-new provider config mid-run and verify it works without
  // touching any source code — just config.
  const { providerManager, apiKeyManager, adapterRegistry } = require('../src/services');
  const newProvider = {
    id: 'custom-nim',
    name: 'Custom NIM',
    enabled: true,
    adapter: 'nvidia',
    baseURL: `http://127.0.0.1:${mockPort}`,
    apiKeys: ['nim-key'],
    supportedModels: ['nim-custom-model'],
    priority: 1,
    timeout: 5000,
  };
  fs.writeFileSync(path.join(tmpProvidersDir, 'custom-nim.json'), JSON.stringify(newProvider));
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());
  adapterRegistry.reset();

  const res = await request('/v1/chat/completions', {
    model: 'nim-custom-model', messages: [{ role: 'user', content: 'Hi' }],
  });
  // The mock server only responds to /chat/completions and /messages, so the
  // nvidia adapter (which uses /chat/completions) should hit the OpenAI-compat
  // mock and succeed.
  const ok = res.status === 200 && res.body.object === 'chat.completion';
  record('new provider via config only (no source changes)', ok, `status=${res.status}`);
}

async function testModelsEndpoint() {
  const res = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: expressPort, path: '/v1/models' }, (r) => {
      let c = ''; r.on('data', (d) => (c += d)); r.on('end', () => resolve({ status: r.statusCode, body: c }));
    }).on('error', reject);
  });
  record('GET /v1/models still works', res.status === 200, `status=${res.status}`);
}

async function main() {
  console.log('=== Provider Adapter Integration Tests ===\n');
  await startMockProvider();
  writeProviderConfigs();

  const { providerManager, apiKeyManager, adapterRegistry } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());
  adapterRegistry.reset();

  await startExpressServer();

  try {
    await testRegistryAutoSelect();
    await testOpenAICompatChat();
    await testOpenAICompatResponses();
    await testAnthropicChat();
    await testAnthropicResponses();
    await testAnthropicStreaming();
    await testNewProviderViaConfigOnly();
    await testModelsEndpoint();
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
