/**
 * Integration test for SSE streaming (POST /v1/chat/completions and
 * POST /v1/responses with "stream": true).
 *
 * Run:  node examples/streaming.integration.js
 *
 * Spins up a mock provider that emits OpenAI Chat Completions SSE chunks and
 * verifies that:
 *   - the gateway forwards SSE events to the client
 *   - [DONE] terminates the stream
 *   - the Content-Type is text/event-stream
 *   - Chat Completions pass-through preserves the chunk shape
 *   - Responses API translates chunks into response.* events
 *   - validation errors (before stream start) return JSON
 *   - pre-stream provider error (e.g. 401) returns JSON
 *   - streaming still works alongside non-streaming endpoints
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

// Per-provider behavior: providerId -> { failPreStream: status }
const providerBehavior = {};

function sseChunk(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

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
        if (behavior.failPreStream) {
          res.writeHead(behavior.failPreStream, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Simulated ${behavior.failPreStream}` } }));
          return;
        }

        // Emit a small OpenAI Chat Completions SSE stream
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const chunks = [
          { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700000000, model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
          { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700000000, model: 'mock-model', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
          { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700000000, model: 'mock-model', choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] },
          { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700000000, model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
        ];
        for (const c of chunks) {
          res.write(sseChunk(c));
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
}

function writeProviderConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-stream-'));
  const primary = {
    id: 'primary', name: 'Primary', enabled: true,
    baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['primary-key'],
    supportedModels: ['mock-model', 'shared-model'], priority: 1, timeout: 5000,
  };
  const secondary = {
    id: 'secondary', name: 'Secondary', enabled: true,
    baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['secondary-key'],
    supportedModels: ['shared-model'], priority: 2, timeout: 5000,
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

/**
 * Issue a streaming request and collect the raw SSE response body.
 */
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

/**
 * Parse an SSE response body into an array of data events (JSON-parsed).
 */
function parseSSEEvents(raw) {
  const events = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length) {
      const joined = dataLines.join('\n');
      events.push(joined === '[DONE]' ? '[DONE]' : (() => { try { return JSON.parse(joined); } catch { return joined; } })());
    }
  }
  return events;
}

async function testChatStreamSuccess() {
  const res = await streamRequest('/v1/chat/completions', {
    model: 'mock-model', messages: [{ role: 'user', content: 'Hi' }], stream: true,
  });
  const ctOk = res.headers['content-type'] && res.headers['content-type'].includes('text/event-stream');
  const events = parseSSEEvents(res.body);
  const hasDeltaContent = events.some((e) => e && e.choices && e.choices[0] && e.choices[0].delta && e.choices[0].delta.content === 'Hello');
  const hasDone = events.includes('[DONE]');
  const hasFinishReason = events.some((e) => e && e.choices && e.choices[0] && e.choices[0].finish_reason === 'stop');
  record('chat stream: 200 + text/event-stream', res.status === 200 && ctOk, `status=${res.status}, ct=${res.headers['content-type']}`);
  record('chat stream: forwards delta content', hasDeltaContent);
  record('chat stream: forwards finish_reason', hasFinishReason);
  record('chat stream: terminates with [DONE]', hasDone);
}

async function testChatStreamValidation() {
  const res = await streamRequest('/v1/chat/completions', {
    messages: [{ role: 'user', content: 'Hi' }], stream: true,
  });
  const ok = res.status === 400 && res.headers['content-type'].includes('application/json');
  record('chat stream: validation error returns JSON', ok, `status=${res.status}, ct=${res.headers['content-type']}`);
}

async function testChatStreamPreStreamError() {
  providerBehavior.primary = { failPreStream: 401 };
  const res = await streamRequest('/v1/chat/completions', {
    model: 'mock-model', messages: [{ role: 'user', content: 'Hi' }], stream: true,
  });
  const ok = res.status === 401 && res.headers['content-type'].includes('application/json') && res.body.includes('invalid_api_key');
  record('chat stream: pre-stream 401 returns JSON error', ok, `status=${res.status}`);
  delete providerBehavior.primary;
}

async function testResponsesStream() {
  const res = await streamRequest('/v1/responses', {
    model: 'mock-model', input: 'Hi', stream: true,
  });
  const ctOk = res.headers['content-type'] && res.headers['content-type'].includes('text/event-stream');
  const events = parseSSEEvents(res.body);
  const hasCreated = events.some((e) => e && e.type === 'response.created');
  const hasDelta = events.some((e) => e && e.type === 'response.output_text.delta');
  const hasCompleted = events.some((e) => e && e.type === 'response.completed');
  const hasDone = events.includes('[DONE]');
  // delta text should reconstruct "Hello world"
  const deltas = events.filter((e) => e && e.type === 'response.output_text.delta').map((e) => e.delta).join('');
  record('responses stream: 200 + text/event-stream', res.status === 200 && ctOk, `status=${res.status}`);
  record('responses stream: response.created event', hasCreated);
  record('responses stream: response.output_text.delta events', hasDelta);
  record('responses stream: delta reconstructs content', deltas === 'Hello world', `deltas="${deltas}"`);
  record('responses stream: response.completed event', hasCompleted);
  record('responses stream: terminates with [DONE]', hasDone);
}

async function testResponsesStreamValidation() {
  const res = await streamRequest('/v1/responses', { model: 'mock-model', stream: true });
  const ok = res.status === 400 && res.headers['content-type'].includes('application/json');
  record('responses stream: validation error returns JSON', ok, `status=${res.status}`);
}

async function testNonStreamingStillWorks() {
  const res = await streamRequest('/v1/chat/completions', {
    model: 'mock-model', messages: [{ role: 'user', content: 'Hi' }],
  });
  const ok = res.status === 200 && res.headers['content-type'].includes('application/json');
  record('non-streaming still returns JSON', ok, `status=${res.status}, ct=${res.headers['content-type']}`);
}

async function testModelsEndpoint() {
  const res = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: expressPort, path: '/v1/models' }, (r) => {
      let c = ''; r.on('data', (d) => (c += d)); r.on('end', () => resolve({ status: r.statusCode, body: c }));
    }).on('error', reject);
  });
  record('GET /v1/models still works', res.status === 200, `status=${res.status}`);
}

async function testStreamFallback() {
  // Primary fails pre-stream; secondary should serve the stream (fallback).
  providerBehavior.primary = { failPreStream: 503 };
  const res = await streamRequest('/v1/chat/completions', {
    model: 'shared-model', messages: [{ role: 'user', content: 'Hi' }], stream: true,
  });
  const events = parseSSEEvents(res.body);
  const hasDone = events.includes('[DONE]');
  const ok = res.status === 200 && res.headers['content-type'].includes('text/event-stream') && hasDone;
  record('stream fallback to secondary provider -> 200 SSE', ok, `status=${res.status}`);
  delete providerBehavior.primary;
}

async function main() {
  console.log('=== Streaming Integration Tests ===\n');
  await startMockProvider();
  writeProviderConfigs();

  const { providerManager, apiKeyManager } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());

  await startExpressServer();

  try {
    await testChatStreamSuccess();
    await testChatStreamValidation();
    await testChatStreamPreStreamError();
    await testResponsesStream();
    await testResponsesStreamValidation();
    await testStreamFallback();
    await testNonStreamingStillWorks();
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
