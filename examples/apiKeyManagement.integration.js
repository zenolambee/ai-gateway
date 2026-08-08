/**
 * Integration tests for Prompt 23 — API Key Management, Quota runtime,
 * Backup/Restore admin endpoints, and runtime integration.
 *
 * Run:  node examples/apiKeyManagement.integration.js
 *
 * Exercises the full Express stack against a mock provider:
 *   - POST /admin/api/keys (generate → one-time plaintext, no secret stored)
 *   - generated key works for /v1/chat/completions (API key → runtime)
 *   - provider permission enforced at runtime
 *   - model permission enforced at runtime
 *   - quota exhaustion blocks BEFORE provider call (429 QUOTA_EXCEEDED)
 *   - usage recorded per key
 *   - POST /admin/api/keys/:id/revoke → revoked key rejected at runtime
 *   - POST /admin/api/keys/:id/rotate → new key works, old rejected
 *   - GET /admin/api/keys/:id/quota
 *   - POST /admin/api/backup (secret-free) + validate + restore
 *   - security: list keys never leaks secret
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
        providerRequests.push({ url: req.url, auth: req.headers.authorization });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-p23', object: 'chat.completion', created: 1700000000, model: 'p23-model',
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
        try { resolve({ status: res.statusCode, body: JSON.parse(c) }); } catch { resolve({ status: res.statusCode, body: c }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const ADMIN_KEY = 'sk-admin-p23-0000';

async function run() {
  console.log('='.repeat(60));
  console.log('API Key Management & Backup — Integration');
  console.log('='.repeat(60));

  await startMock();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p23-'));
  const base = `http://127.0.0.1:${mockPort}`;

  const services = require('../src/services');
  const { providerManager, apiKeyManager, apiKeyStore } = services;
  providerManager.updateProviders([
    { id: 'prov-x', name: 'Prov X', enabled: true, adapter: 'openai', baseURL: base, apiKeys: ['xkey'], supportedModels: ['p23-model', 'shared'], priority: 1, timeout: 3000 },
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

  // ---- Generate a key (secure path) ----
  const gen = await req('POST', '/admin/api/keys', { name: 'Runtime Key', allowedProviders: ['prov-x'], allowedModels: ['p23-model'] }, ADMIN_KEY);
  record('generate: 200 + one-time apiKey', gen.status === 200 && typeof gen.body.apiKey === 'string' && gen.body.apiKey.startsWith('sk-gw-'));
  record('generate: response key metadata has no secret', gen.body.key && gen.body.key.key === undefined && gen.body.key.keyHash === undefined);
  const runtimeKey = gen.body.apiKey;
  const runtimeKeyId = gen.body.key.id;

  // ---- List keys: no secrets ----
  const list = await req('GET', '/admin/api/keys', null, ADMIN_KEY);
  const leak = list.body.keys.some((k) => k.key !== undefined || k.keyHash !== undefined);
  record('list: no secrets leaked', list.status === 200 && leak === false);

  // ---- API key → runtime (allowed provider + model) ----
  providerRequests = [];
  const chat = await req('POST', '/v1/chat/completions', { model: 'p23-model', messages: [{ role: 'user', content: 'hi' }] }, runtimeKey);
  record('runtime: generated key works', chat.status === 200 && chat.body.object === 'chat.completion', `status=${chat.status}`);
  record('runtime: routed to allowed provider', providerRequests.length === 1);

  // ---- model permission denied ----
  const denyModel = await req('POST', '/v1/chat/completions', { model: 'shared', messages: [{ role: 'user', content: 'hi' }] }, runtimeKey);
  record('model perm: denied model -> 403', denyModel.status === 403 && denyModel.body.error.code === 'model_forbidden', `status=${denyModel.status}`);

  // ---- provider permission denied ----
  // A key allowed ONLY on prov-y, requesting p23-model (served only by prov-x):
  // every candidate provider is filtered out → 403 provider_forbidden.
  const provDenyGen = await req('POST', '/admin/api/keys', { name: 'Prov Y only', allowedProviders: ['prov-y'] }, ADMIN_KEY);
  const provDenyKey = provDenyGen.body.apiKey;
  const denyProv = await req('POST', '/v1/chat/completions', { model: 'p23-model', messages: [{ role: 'user', content: 'hi' }] }, provDenyKey);
  record('provider perm: denied provider -> 403', denyProv.status === 403 && denyProv.body.error.code === 'provider_forbidden', `status=${denyProv.status}/${denyProv.body.error && denyProv.body.error.code}`);

  // ---- usage recorded per key ----
  const usage = await req('GET', `/admin/api/keys/${runtimeKeyId}/usage`, null, ADMIN_KEY);
  record('usage: recorded for key', usage.status === 200 && usage.body.usage && usage.body.usage.totalRequests >= 1);

  // ---- quota: exhaust and block before provider ----
  const qGen = await req('POST', '/admin/api/keys', { name: 'Quota Key', quota: { limit: 10 } }, ADMIN_KEY);
  const qKey = qGen.body.apiKey;
  const qId = qGen.body.key.id;
  // Consume the quota directly to exhaustion (limit=10, one request uses 15 tokens).
  const first = await req('POST', '/v1/chat/completions', { model: 'p23-model', messages: [{ role: 'user', content: 'hi' }] }, qKey);
  record('quota: first request allowed', first.status === 200);
  // Now used(15) >= limit(10) → next request rejected pre-provider.
  providerRequests = [];
  const blocked = await req('POST', '/v1/chat/completions', { model: 'p23-model', messages: [{ role: 'user', content: 'hi' }] }, qKey);
  record('quota: exhausted -> 429 quota_exceeded', blocked.status === 429 && blocked.body.error.code === 'quota_exceeded', `status=${blocked.status}/${blocked.body.error && blocked.body.error.code}`);
  record('quota: no provider call when exhausted', providerRequests.length === 0);
  const qStatus = await req('GET', `/admin/api/keys/${qId}/quota`, null, ADMIN_KEY);
  record('quota: status endpoint remaining=0', qStatus.status === 200 && qStatus.body.quota.remaining === 0, `remaining=${qStatus.body.quota && qStatus.body.quota.remaining}`);

  // ---- revoke ----
  const revoke = await req('POST', `/admin/api/keys/${runtimeKeyId}/revoke`, null, ADMIN_KEY);
  record('revoke: 200 status revoked', revoke.status === 200 && revoke.body.key.status === 'revoked');
  const afterRevoke = await req('POST', '/v1/chat/completions', { model: 'p23-model', messages: [{ role: 'user', content: 'hi' }] }, runtimeKey);
  record('revoke: revoked key rejected at runtime', afterRevoke.status === 401 && afterRevoke.body.error.code === 'revoked_api_key', `status=${afterRevoke.status}/${afterRevoke.body.error && afterRevoke.body.error.code}`);

  // ---- rotate ----
  const rGen = await req('POST', '/admin/api/keys', { name: 'Rotate Key', allowedModels: ['p23-model'] }, ADMIN_KEY);
  const oldKey = rGen.body.apiKey;
  const rId = rGen.body.key.id;
  const rot = await req('POST', `/admin/api/keys/${rId}/rotate`, null, ADMIN_KEY);
  record('rotate: returns new apiKey', rot.status === 200 && rot.body.apiKey && rot.body.apiKey !== oldKey);
  const newKey = rot.body.apiKey;
  const oldFail = await req('POST', '/v1/chat/completions', { model: 'p23-model', messages: [{ role: 'user', content: 'hi' }] }, oldKey);
  record('rotate: old key rejected', oldFail.status === 401);
  const newOk = await req('POST', '/v1/chat/completions', { model: 'p23-model', messages: [{ role: 'user', content: 'hi' }] }, newKey);
  record('rotate: new key works', newOk.status === 200);

  // ---- backup ----
  const backup = await req('POST', '/admin/api/backup', {}, ADMIN_KEY);
  record('backup: 200 versioned', backup.status === 200 && backup.body.backup.backupVersion === 1);
  record('backup: no plaintext key in apiKeys', backup.body.backup.data.apiKeys.every((k) => k.key === undefined && k.keyHash === undefined));
  record('backup: provider secrets stripped', backup.body.backup.data.providers.every((p) => p.apiKeys === undefined && p.apiKey === undefined));

  const validate = await req('POST', '/admin/api/backup/validate', { backup: backup.body.backup }, ADMIN_KEY);
  record('backup: validate ok', validate.status === 200 && validate.body.valid === true);

  const dry = await req('POST', '/admin/api/backup/restore', { backup: backup.body.backup, dryRun: true }, ADMIN_KEY);
  record('backup: restore dry-run ok', dry.status === 200 && dry.body.dryRun === true);

  const restore = await req('POST', '/admin/api/backup/restore', { backup: backup.body.backup }, ADMIN_KEY);
  record('backup: restore apply ok', restore.status === 200 && restore.body.success === true);

  // ---- backup validate rejects tampered ----
  const tampered = JSON.parse(JSON.stringify(backup.body.backup));
  tampered.data.apiKeys.push({ id: 'x', keyHash: 'leak' });
  const badValidate = await req('POST', '/admin/api/backup/validate', { backup: tampered }, ADMIN_KEY);
  record('backup: tampered/secret rejected', badValidate.status === 200 && badValidate.body.valid === false);

  await new Promise((r) => expressServer.close(r));
  await new Promise((r) => mockServer.close(r));
  providerManager.updateProviders([]);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(60));
  console.log(`API Key Management & Backup — Integration: ${passed}/${results.length} passed, ${failed} failed`);
  console.log('='.repeat(60));
  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) console.log('  FAIL: ' + r.name + ' — ' + (r.detail || ''));
    process.exit(1);
  }
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
