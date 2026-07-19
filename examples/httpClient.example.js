/**
 * Example / smoke test for HttpClient.
 *
 * Run:  node examples/httpClient.example.js
 *
 * This script demonstrates:
 *   - POST with JSON body
 *   - GET with query parameters
 *   - Custom provider headers
 *   - Authorization Bearer header construction
 *   - Provider timeout usage
 *   - Error normalization (timeout, 401, 403, 404, 429, 500, 503, connection
 *     refused, DNS error, invalid JSON)
 *
 * It does NOT make real network calls to AI providers. Instead it uses a
 * local HTTP server (http.createServer) to simulate provider responses and a
 * set of unreachable hosts to trigger network-level errors.
 */

const http = require('http');
const HttpClient = require('../src/services/httpClient');
const { ErrorCode } = require('../src/services/httpClientError');

let server;
let serverPort;
let lastRequestHeaders = {};

const results = [];

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function startMockServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      lastRequestHeaders = req.headers;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const url = req.url;
        if (url.startsWith('/ok')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path: url, method: req.method }));
          return;
        }
        if (url === '/echo-headers') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ headers: req.headers }));
          return;
        }
        if (url.startsWith('/unauthorized')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
          return;
        }
        if (url.startsWith('/forbidden')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Forbidden' } }));
          return;
        }
        if (url.startsWith('/rate-limited')) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Too many requests' } }));
          return;
        }
        if (url.startsWith('/server-error')) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Internal server error' } }));
          return;
        }
        if (url.startsWith('/unavailable')) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Service unavailable' } }));
          return;
        }
        if (url.startsWith('/bad-json')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{ not valid json');
          return;
        }
        if (url.startsWith('/slow')) {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{}');
          }, 3000);
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Not found' } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}

function mockProvider(overrides = {}) {
  return {
    id: 'mock',
    name: 'Mock Provider',
    enabled: true,
    baseURL: `http://127.0.0.1:${serverPort}`,
    apiKeys: ['test-key-123'],
    supportedModels: ['mock-model'],
    priority: 1,
    timeout: 5000,
    ...overrides,
  };
}

async function testPostSuccess() {
  const client = new HttpClient({ logEnabled: false });
  const res = await client.sendRequest(mockProvider(), '/ok', {
    method: 'POST',
    body: { hello: 'world' },
  });
  record(
    'POST returns 200',
    res.status === 200 && res.data.ok === true,
    `status=${res.status}`
  );
}

async function testGetWithQuery() {
  const client = new HttpClient({ logEnabled: false });
  const res = await client.sendRequest(mockProvider(), '/ok', {
    method: 'GET',
    query: { foo: 'bar', n: 42 },
  });
  record(
    'GET with query params',
    res.status === 200 && res.data.path.includes('foo=bar') && res.data.path.includes('n=42'),
    `path=${res.data.path}`
  );
}

async function testAuthorizationHeader() {
  const client = new HttpClient({ logEnabled: false });
  await client.sendRequest(mockProvider(), '/echo-headers', { method: 'GET' });
  record(
    'Authorization Bearer header',
    lastRequestHeaders.authorization === 'Bearer test-key-123',
    `auth=${lastRequestHeaders.authorization}`
  );
}

async function testCustomHeaders() {
  const client = new HttpClient({ logEnabled: false });
  const provider = mockProvider({
    headers: { 'X-Custom-Header': 'my-value' },
  });
  await client.sendRequest(provider, '/echo-headers', { method: 'GET' });
  record(
    'Custom provider headers',
    lastRequestHeaders['x-custom-header'] === 'my-value',
    `x-custom-header=${lastRequestHeaders['x-custom-header']}`
  );
}

async function testPerRequestHeaders() {
  const client = new HttpClient({ logEnabled: false });
  await client.sendRequest(mockProvider(), '/echo-headers', {
    method: 'GET',
    headers: { 'X-Request-Id': 'abc-123' },
  });
  record(
    'Per-request headers',
    lastRequestHeaders['x-request-id'] === 'abc-123',
    `x-request-id=${lastRequestHeaders['x-request-id']}`
  );
}

async function test401() {
  const client = new HttpClient({ logEnabled: false });
  try {
    await client.sendRequest(mockProvider(), '/unauthorized', { method: 'GET' });
    record('401 normalized', false, 'no error thrown');
  } catch (err) {
    record(
      '401 normalized',
      err.statusCode === 401 && err.info?.code === ErrorCode.UNAUTHORIZED,
      `status=${err.statusCode}, code=${err.info?.code}`
    );
  }
}

async function test403() {
  const client = new HttpClient({ logEnabled: false });
  try {
    await client.sendRequest(mockProvider(), '/forbidden', { method: 'GET' });
    record('403 normalized', false, 'no error thrown');
  } catch (err) {
    record(
      '403 normalized',
      err.statusCode === 403 && err.info?.code === ErrorCode.FORBIDDEN,
      `status=${err.statusCode}, code=${err.info?.code}`
    );
  }
}

async function test404() {
  const client = new HttpClient({ logEnabled: false });
  try {
    await client.sendRequest(mockProvider(), '/does-not-exist', { method: 'GET' });
    record('404 normalized', false, 'no error thrown');
  } catch (err) {
    record(
      '404 normalized',
      err.statusCode === 404 && err.info?.code === ErrorCode.NOT_FOUND,
      `status=${err.statusCode}, code=${err.info?.code}`
    );
  }
}

async function test429() {
  const client = new HttpClient({ logEnabled: false });
  try {
    await client.sendRequest(mockProvider(), '/rate-limited', { method: 'GET' });
    record('429 normalized', false, 'no error thrown');
  } catch (err) {
    record(
      '429 normalized',
      err.statusCode === 429 && err.info?.code === ErrorCode.RATE_LIMITED,
      `status=${err.statusCode}, code=${err.info?.code}`
    );
  }
}

async function test500() {
  const client = new HttpClient({ logEnabled: false });
  try {
    await client.sendRequest(mockProvider(), '/server-error', { method: 'GET' });
    record('500 normalized', false, 'no error thrown');
  } catch (err) {
    record(
      '500 normalized',
      err.statusCode === 500 && err.info?.code === ErrorCode.SERVER_ERROR,
      `status=${err.statusCode}, code=${err.info?.code}`
    );
  }
}

async function test503() {
  const client = new HttpClient({ logEnabled: false });
  try {
    await client.sendRequest(mockProvider(), '/unavailable', { method: 'GET' });
    record('503 normalized', false, 'no error thrown');
  } catch (err) {
    record(
      '503 normalized',
      err.statusCode === 503 && err.info?.code === ErrorCode.SERVICE_UNAVAILABLE,
      `status=${err.statusCode}, code=${err.info?.code}`
    );
  }
}

async function testTimeout() {
  const client = new HttpClient({ logEnabled: false });
  const provider = mockProvider({ timeout: 50 });
  try {
    await client.sendRequest(provider, '/slow', { method: 'GET' });
    record('Timeout normalized', false, 'no error thrown');
  } catch (err) {
    record(
      'Timeout normalized',
      err.info?.code === ErrorCode.TIMEOUT,
      `status=${err.statusCode}, code=${err.info?.code}`
    );
  }
}

async function testConnectionRefused() {
  const client = new HttpClient({ logEnabled: false });
  const provider = mockProvider({
    baseURL: 'http://127.0.0.1:1',
    timeout: 2000,
  });
  try {
    await client.sendRequest(provider, '/ok', { method: 'GET' });
    record('Connection refused normalized', false, 'no error thrown');
  } catch (err) {
    record(
      'Connection refused normalized',
      err.info?.code === ErrorCode.CONNECTION_REFUSED,
      `status=${err.statusCode}, code=${err.info?.code}`
    );
  }
}

async function testDnsError() {
  const client = new HttpClient({ logEnabled: false });
  const provider = mockProvider({
    baseURL: 'http://this-host-does-not-exist-99999.invalid',
    timeout: 5000,
  });
  try {
    await client.sendRequest(provider, '/ok', { method: 'GET' });
    record('DNS error normalized', false, 'no error thrown');
  } catch (err) {
    record(
      'DNS error normalized',
      err.info?.code === ErrorCode.DNS_ERROR,
      `status=${err.statusCode}, code=${err.info?.code}`
    );
  }
}

async function testInvalidJson() {
  const client = new HttpClient({ logEnabled: false });
  try {
    await client.sendRequest(mockProvider(), '/bad-json', { method: 'GET' });
    record('Invalid JSON normalized', false, 'no error thrown');
  } catch (err) {
    record(
      'Invalid JSON normalized',
      err.info?.code === ErrorCode.INVALID_JSON,
      `status=${err.statusCode}, code=${err.info?.code}, msg=${err.message}`
    );
  }
}

(async function main() {
  console.log('=== HttpClient Examples ===\n');
  await startMockServer();
  try {
    await testPostSuccess();
    await testGetWithQuery();
    await testAuthorizationHeader();
    await testCustomHeaders();
    await testPerRequestHeaders();
    await test401();
    await test403();
    await test404();
    await test429();
    await test500();
    await test503();
    await testTimeout();
    await testConnectionRefused();
    await testDnsError();
    await testInvalidJson();
  } finally {
    server.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length > 0) {
    console.error('FAILED TESTS:');
    failed.forEach((f) => console.error(`  - ${f.name}: ${f.detail}`));
    process.exit(1);
  }
})();
