/**
 * Integration tests for Prompt 24 — Usage & Quota Analytics over the full
 * runtime path (Prompt 22 executor + Prompt 23 API keys).
 *
 * Run:  node examples/usageAnalytics.integration.js
 *
 * Verifies analytics data is populated by REAL runtime requests (not synthetic
 * counters), owner-scoped self-service endpoints, admin aggregate endpoints,
 * authorization isolation, concurrency safety, and secret-free responses.
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const logger = require('../src/utils/logger');
logger.info = () => {}; logger.warn = () => {}; logger.error = () => {};

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

let mockServer, mockPort, expressServer, expressPort, tmpDir;

function startMock() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-ua', object: 'chat.completion', created: 1700000000, model: 'ua-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
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

const ADMIN_KEY = 'sk-admin-ua-0000';

async function run() {
  console.log('='.repeat(60));
  console.log('Usage & Quota Analytics — Integration');
  console.log('='.repeat(60));

  await startMock();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-int-'));
  const base = `http://127.0.0.1:${mockPort}`;

  const services = require('../src/services');
  const { providerManager, apiKeyManager, apiKeyStore, usageAccountant } = services;
  usageAccountant.reset();
  providerManager.updateProviders([
    { id: 'prov-a', name: 'Prov A', enabled: true, adapter: 'openai', baseURL: base, apiKeys: ['akey'], supportedModels: ['ua-model'], priority: 1, timeout: 3000 },
  ]);
  apiKeyManager.load(providerManager.listProviders());

  const cfgFile = path.join(tmpDir, 'apiKeys.json');
  fs.writeFileSync(cfgFile, JSON.stringify([{ id: 'admin', key: ADMIN_KEY, name: 'Admin', status: 'active', role: 'admin' }]));
  apiKeyStore.load(cfgFile);
  await apiKeyStore.hydrate();

  expressServer = app.listen(0, '127.0.0.1');
  await new Promise((r) => expressServer.once('listening', r));
  expressPort = expressServer.address().port;

  // Two user keys.
  const genA = await req('POST', '/admin/api/keys', { name: 'User A', quota: { limit: 1000 } }, ADMIN_KEY);
  const genB = await req('POST', '/admin/api/keys', { name: 'User B' }, ADMIN_KEY);
  const keyA = genA.body.apiKey; const idA = genA.body.key.id;
  const keyB = genB.body.apiKey; const idB = genB.body.key.id;

  // ---- Drive REAL runtime requests with key A ----
  for (let i = 0; i < 3; i += 1) {
    await req('POST', '/v1/chat/completions', { model: 'ua-model', messages: [{ role: 'user', content: 'hi' }] }, keyA);
  }
  // One request with key B.
  await req('POST', '/v1/chat/completions', { model: 'ua-model', messages: [{ role: 'user', content: 'hi' }] }, keyB);

  // ---- self-service usage (owner-scoped) reflects runtime ----
  const selfA = await req('GET', '/v1/usage', null, keyA);
  record('runtime→analytics: key A usage populated', selfA.status === 200 && selfA.body.usage.requests === 3, `req=${selfA.body.usage && selfA.body.usage.requests}`);
  record('runtime→analytics: tokens from provider response', selfA.body.usage.totalTokens === 90, `tokens=${selfA.body.usage.totalTokens}`);
  record('runtime→analytics: non-stream counted', selfA.body.usage.nonStreamRequests === 3);

  // ---- self-service quota ----
  const selfQ = await req('GET', '/v1/usage/quota', null, keyA);
  record('self quota: used reflects consumed tokens', selfQ.status === 200 && selfQ.body.quota.used === 90 && selfQ.body.quota.remaining === 910, `used=${selfQ.body.quota && selfQ.body.quota.used}`);
  record('self quota: percentageUsed', selfQ.body.quota.percentageUsed === 9);

  // ---- authorization isolation: key A cannot read key B via self-service ----
  // Self-service always scopes to the caller — verify A's data != B's data.
  const selfB = await req('GET', '/v1/usage', null, keyB);
  record('isolation: key B sees only its own 1 request', selfB.body.usage.requests === 1);
  record('isolation: self-service ignores other keys', selfA.body.apiKeyId === idA && selfB.body.apiKeyId === idB);

  // ---- non-admin cannot reach admin aggregate endpoints ----
  const forbid = await req('GET', '/admin/api/usage/summary', null, keyA);
  record('authz: non-admin blocked from admin usage', forbid.status === 403, `status=${forbid.status}`);

  // ---- admin aggregate endpoints ----
  const summary = await req('GET', '/admin/api/usage/summary', null, ADMIN_KEY);
  record('admin summary: total requests >= 4', summary.status === 200 && summary.body.summary.requests >= 4);
  const provUsage = await req('GET', '/admin/api/usage/providers', null, ADMIN_KEY);
  record('admin providers: prov-a present', provUsage.status === 200 && provUsage.body.providers.some((p) => p.providerId === 'prov-a' && p.requests >= 4));
  const modelUsage = await req('GET', '/admin/api/usage/models', null, ADMIN_KEY);
  record('admin models: ua-model present', modelUsage.body.models.some((m) => m.model === 'ua-model'));
  const daily = await req('GET', '/admin/api/usage/daily', null, ADMIN_KEY);
  record('admin daily: bucket present', daily.body.daily.length >= 1);
  const monthly = await req('GET', '/admin/api/usage/monthly', null, ADMIN_KEY);
  record('admin monthly: bucket present', monthly.body.monthly.length >= 1);

  // ---- admin detail: pagination + filter ----
  const detail = await req('GET', `/admin/api/usage/detail?apiKeyId=${idA}&page=1&limit=2`, null, ADMIN_KEY);
  record('admin detail: pagination', detail.body.items.length === 2 && detail.body.total === 3);
  record('admin detail: filtered by key', detail.body.items.every((i) => i.apiKeyId === idA));

  // ---- admin per-key usage/quota ----
  const keyUsage = await req('GET', `/admin/api/keys/${idA}/usage`, null, ADMIN_KEY);
  record('admin key usage: analytics present', keyUsage.body.analytics && keyUsage.body.analytics.usage.requests === 3);
  const keyQuota = await req('GET', `/admin/api/keys/${idA}/quota`, null, ADMIN_KEY);
  record('admin key quota: remaining', keyQuota.body.quota.remaining === 910);

  // ---- security: no secrets anywhere ----
  const dump = JSON.stringify([selfA.body, selfQ.body, summary.body, provUsage.body, detail.body, keyUsage.body]);
  record('security: no raw key in responses', dump.includes('sk-gw-') === false && dump.includes(keyA) === false);
  record('security: no keyHash/authorization in responses', dump.includes('keyHash') === false && dump.toLowerCase().includes('authorization') === false);

  // ---- concurrency: 100 concurrent requests, exact counting + quota ----
  const genC = await req('POST', '/admin/api/keys', { name: 'User C', quota: { limit: 100000 } }, ADMIN_KEY);
  const keyC = genC.body.apiKey; const idC = genC.body.key.id;
  const N = 100;
  const batch = [];
  for (let i = 0; i < N; i += 1) batch.push(req('POST', '/v1/chat/completions', { model: 'ua-model', messages: [{ role: 'user', content: 'x' }] }, keyC));
  const done = await Promise.all(batch);
  const okCount = done.filter((r) => r.status === 200).length;
  record('concurrency: all 100 requests succeeded', okCount === N, `ok=${okCount}`);
  // allow async quota persistence to settle
  await new Promise((r) => setTimeout(r, 100));
  const cUsage = await req('GET', '/v1/usage', null, keyC);
  record('concurrency: usage count exact (no lost/double)', cUsage.body.usage.requests === N, `req=${cUsage.body.usage.requests}`);
  record('concurrency: token total exact', cUsage.body.usage.totalTokens === N * 30, `tokens=${cUsage.body.usage.totalTokens}`);
  const cQuota = await req('GET', '/v1/usage/quota', null, keyC);
  record('concurrency: quota used exact (atomic)', cQuota.body.quota.used === N * 30, `used=${cQuota.body.quota.used}`);
  record('concurrency: no negative remaining', cQuota.body.quota.remaining >= 0);

  await new Promise((r) => expressServer.close(r));
  await new Promise((r) => mockServer.close(r));
  providerManager.updateProviders([]);
  usageAccountant.reset();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(60));
  console.log(`Usage & Quota Analytics — Integration: ${passed}/${results.length} passed, ${failed} failed`);
  console.log('='.repeat(60));
  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) console.log('  FAIL: ' + r.name + ' — ' + (r.detail || ''));
    process.exit(1);
  }
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
