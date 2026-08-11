/**
 * Startup & provider-credential tests (Prompt 28).
 *
 * Verifies the Gateway starts and serves requests with ZERO provider
 * credentials configured — no mandatory AI_API_KEY, no NVIDIA/OpenAI/… env
 * keys — and that a request for an unconfigured provider returns a clean
 * PROVIDER_NOT_CONFIGURED-style error instead of crashing the process.
 *
 * Run:  node examples/startupNoCredentials.integration.js
 *
 * This boots the real Express app in-process (NODE_ENV=test) after stripping
 * all provider credential env vars, and drives it over a live socket.
 */

// Strip every provider credential + the legacy AI_API_KEY BEFORE requiring the
// app so config.js and the services see an unconfigured environment.
for (const k of [
  'AI_API_KEY',
  'NVIDIA_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'TOKENFAUCET_API_KEY',
  'DATABRICKS_TOKEN',
]) {
  delete process.env[k];
}
process.env.NODE_ENV = 'test';
// Point provider config at an empty temp dir so no bundled provider configs
// (which reference env credentials) are loaded — a truly zero-credential boot.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p28-providers-'));
process.env.PROVIDERS_CONFIG_DIR = emptyDir;

const logger = require('../src/utils/logger');
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

function req(server, method, p, body) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = {};
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let c = '';
      res.on('data', (d) => (c += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(c), raw: c }); }
        catch { resolve({ status: res.statusCode, body: c, raw: c }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  console.log('='.repeat(60));
  console.log('Startup without provider credentials — Integration');
  console.log('='.repeat(60));

  // 1. The app module must load without throwing (no fatal AI_API_KEY check).
  let app;
  try {
    app = require('../src/app');
    record('app module loads without AI_API_KEY', !!app);
  } catch (err) {
    record('app module loads without AI_API_KEY', false, err.message);
    process.exit(1);
  }

  // 2. Core registries/services initialize.
  const services = require('../src/services');
  record('Provider Registry initialized', !!services.providerManager && typeof services.providerManager.listProviders === 'function');
  record('Model Registry initialized', !!services.modelRegistry);
  record('ConnectionManager initialized', !!services.connectionManager);
  record('API Key Management initialized', !!services.apiKeyStore && !!services.apiKeyManager);

  // 3. Zero provider credentials configured at boot.
  services.apiKeyManager.load(services.providerManager.listProviders());
  const providers = services.providerManager.listProviders();
  record('boots with zero configured providers', providers.length === 0, `providers=${providers.length}`);

  // 4. Server listens (process stays alive).
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  record('API server listening', !!server.address());

  const health = await req(server, 'GET', '/health');
  record('GET /health -> 200 (process alive)', health.status === 200 && health.body.status === 'ok', `status=${health.status}`);

  // 5. Request for an unconfigured provider/model returns a clean error, no crash.
  const chat = await req(server, 'POST', '/v1/chat/completions', {
    model: 'some-unconfigured-model',
    messages: [{ role: 'user', content: 'hi' }],
  });
  const codeOk = chat.body && chat.body.error &&
    ['model_not_found', 'provider_not_configured', 'no_api_keys'].includes(chat.body.error.code);
  record('unconfigured model -> clean error (no crash)', chat.status >= 400 && chat.status < 600 && codeOk,
    `status=${chat.status}/${chat.body && chat.body.error && chat.body.error.code}`);

  // 6. Error body leaks no credential material / stack / path.
  const leak = /sk-[A-Za-z0-9]|Bearer\s|\/root\/|node_modules|at Object\.<anonymous>/.test(chat.raw || '');
  record('error body leaks no secrets/stack/path', leak === false);

  // 7. Process is still alive after the failed request.
  const health2 = await req(server, 'GET', '/health');
  record('process alive after provider error', health2.status === 200);

  await new Promise((r) => server.close(r));
  try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch (_) {}

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(60));
  console.log(`Startup without provider credentials: ${passed}/${results.length} passed, ${failed} failed`);
  console.log('='.repeat(60));
  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) console.log('  FAIL: ' + r.name + ' — ' + (r.detail || ''));
    process.exit(1);
  }
  // Force-exit: background schedulers may keep the event loop alive.
  process.exit(0);
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
