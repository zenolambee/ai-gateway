/**
 * Security regression tests for Prompt 26 — Final Production Audit.
 *
 * Covers the permission-bypass gaps closed in this audit:
 *   1. Streaming path (stream:true) MUST enforce provider permission — a key
 *      restricted to a provider that does NOT serve the requested model must
 *      be rejected (403 provider_forbidden) BEFORE any upstream call, on the
 *      streaming path just like the non-streaming path.
 *   2. Model permission MUST be enforced at the executor chokepoint too, so a
 *      denied model is rejected on both streaming and non-streaming paths.
 *   3. Non-streaming provider/model permission remains enforced (no regression).
 *
 * Run:  node examples/permissionEnforcement.integration.js
 *
 * Uses the full Express stack against a mock provider (no real provider, no
 * secrets). Reuses the existing architecture — no second permission system.
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const logger = require('../src/utils/logger');
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

let mockServer, mockPort, expressServer, expressPort, tmpDir;
let providerRequests = [];

function startMock() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => (body += c));
      req.on('end', () => {
        providerRequests.push({ url: req.url });
        // Non-streaming JSON response (sufficient — permission checks happen
        // before we ever reach the upstream on the denied paths).
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-p26', object: 'chat.completion', created: 1700000000, model: 'p26-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
      });
    });
    mockServer.listen(0, '127.0.0.1', () => { mockPort = mockServer.address().port; resolve(); });
  });
}

function req(method, p, body, key) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = {};
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (key) headers.Authorization = 'Bearer ' + key;
    const r = http.request({ host: '127.0.0.1', port: expressPort, method, path: p, headers }, (res) => {
      let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(c), raw: c }); }
        catch { resolve({ status: res.statusCode, body: c, raw: c }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const ADMIN_KEY = 'sk-admin-p26-0000';

async function run() {
  console.log('='.repeat(60));
  console.log('Permission Enforcement (streaming + model) — Integration');
  console.log('='.repeat(60));

  await startMock();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p26-'));
  const base = `http://127.0.0.1:${mockPort}`;

  const services = require('../src/services');
  const { providerManager, apiKeyManager, apiKeyStore } = services;
  // prov-x serves p26-model + shared; prov-y serves y-model + shared.
  providerManager.updateProviders([
    { id: 'prov-x', name: 'Prov X', enabled: true, adapter: 'openai', baseURL: base, apiKeys: ['xkey'], supportedModels: ['p26-model', 'shared'], priority: 1, timeout: 3000 },
    { id: 'prov-y', name: 'Prov Y', enabled: true, adapter: 'openai', baseURL: base, apiKeys: ['ykey'], supportedModels: ['y-model', 'shared'], priority: 2, timeout: 3000 },
  ]);
  apiKeyManager.load(providerManager.listProviders());

  const cfgFile = path.join(tmpDir, 'apiKeys.json');
  fs.writeFileSync(cfgFile, JSON.stringify([{ id: 'admin', key: ADMIN_KEY, name: 'Admin', status: 'active', role: 'admin' }]));
  apiKeyStore.load(cfgFile);
  await apiKeyStore.hydrate();

  expressServer = app.listen(0, '127.0.0.1');
  await new Promise((r) => expressServer.once('listening', r));
  expressPort = expressServer.address().port;

  // Key restricted to prov-y ONLY (which does not serve p26-model).
  const provYGen = await req('POST', '/admin/api/keys', { name: 'Prov Y only', allowedProviders: ['prov-y'] }, ADMIN_KEY);
  const provYKey = provYGen.body.apiKey;

  // Key allowed on prov-x but restricted to model p26-model only.
  const modelGen = await req('POST', '/admin/api/keys', { name: 'Model limited', allowedProviders: ['prov-x'], allowedModels: ['p26-model'] }, ADMIN_KEY);
  const modelKey = modelGen.body.apiKey;

  // ---- 1. STREAMING provider permission: must be DENIED, no upstream ----
  providerRequests = [];
  const streamDenyProv = await req('POST', '/v1/chat/completions',
    { model: 'p26-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }, provYKey);
  record('stream: provider-denied -> 403 provider_forbidden',
    streamDenyProv.status === 403 && streamDenyProv.body.error && streamDenyProv.body.error.code === 'provider_forbidden',
    `status=${streamDenyProv.status}/${streamDenyProv.body.error && streamDenyProv.body.error.code}`);
  record('stream: NO upstream call on provider-denied (no bypass)', providerRequests.length === 0, `calls=${providerRequests.length}`);

  // ---- 2. STREAMING model permission: must be DENIED, no upstream ----
  providerRequests = [];
  const streamDenyModel = await req('POST', '/v1/chat/completions',
    { model: 'shared', stream: true, messages: [{ role: 'user', content: 'hi' }] }, modelKey);
  record('stream: model-denied -> 403 model_forbidden',
    streamDenyModel.status === 403 && streamDenyModel.body.error && streamDenyModel.body.error.code === 'model_forbidden',
    `status=${streamDenyModel.status}/${streamDenyModel.body.error && streamDenyModel.body.error.code}`);
  record('stream: NO upstream call on model-denied (no bypass)', providerRequests.length === 0, `calls=${providerRequests.length}`);

  // ---- 3. NON-STREAMING provider permission (no regression) ----
  providerRequests = [];
  const nsDenyProv = await req('POST', '/v1/chat/completions',
    { model: 'p26-model', messages: [{ role: 'user', content: 'hi' }] }, provYKey);
  record('non-stream: provider-denied -> 403 provider_forbidden',
    nsDenyProv.status === 403 && nsDenyProv.body.error && nsDenyProv.body.error.code === 'provider_forbidden',
    `status=${nsDenyProv.status}`);
  record('non-stream: NO upstream call on provider-denied', providerRequests.length === 0);

  // ---- 4. NON-STREAMING model permission (no regression) ----
  providerRequests = [];
  const nsDenyModel = await req('POST', '/v1/chat/completions',
    { model: 'shared', messages: [{ role: 'user', content: 'hi' }] }, modelKey);
  record('non-stream: model-denied -> 403 model_forbidden',
    nsDenyModel.status === 403 && nsDenyModel.body.error && nsDenyModel.body.error.code === 'model_forbidden',
    `status=${nsDenyModel.status}`);

  // ---- 5. ALLOWED request still works (positive control) ----
  providerRequests = [];
  const ok = await req('POST', '/v1/chat/completions',
    { model: 'p26-model', messages: [{ role: 'user', content: 'hi' }] }, modelKey);
  record('allowed provider+model still works', ok.status === 200 && ok.body.object === 'chat.completion', `status=${ok.status}`);
  record('allowed request reaches upstream exactly once', providerRequests.length === 1, `calls=${providerRequests.length}`);

  // ---- 6. No secret leakage in any 403 error body ----
  const bodies = [streamDenyProv, streamDenyModel, nsDenyProv, nsDenyModel].map((r) => r.raw).join('\n');
  const leaks = /keyHash|sk-gw-|xkey|ykey|Bearer\s+sk/.test(bodies);
  record('no secret leaked in error bodies', leaks === false);

  await new Promise((r) => expressServer.close(r));
  await new Promise((r) => mockServer.close(r));
  providerManager.updateProviders([]);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(60));
  console.log(`Permission Enforcement — Integration: ${passed}/${results.length} passed, ${failed} failed`);
  console.log('='.repeat(60));
  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) console.log('  FAIL: ' + r.name + ' — ' + (r.detail || ''));
    process.exit(1);
  }
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
