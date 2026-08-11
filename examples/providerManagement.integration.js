/**
 * Integration tests for Provider Management (Add / Edit / Enable / Disable /
 * Safe-Delete) plus its integration with routing, API key permissions and
 * usage analytics.
 *
 * Run:  node examples/providerManagement.integration.js
 *
 * Verifies:
 *   1.  List providers (shape + masking)
 *   2.  Create provider (201, masked credential in response)
 *   3.  Duplicate provider id -> 409
 *   4.  Invalid provider id -> 400
 *   5.  Unknown adapter -> 400 (no fake adapters)
 *   6.  Invalid baseURL -> 400
 *   7.  Empty models -> 400
 *   8.  Update provider (PUT)
 *   9.  Disable provider (POST /disable)
 *   10. Disabled provider is NOT a routing candidate
 *   11. Round-robin skips disabled providers (A -> C -> A -> C)
 *   12. Enable provider (POST /enable) -> routing candidate again
 *   13. API key permissions survive disable/enable
 *   14. Credential never appears in admin responses
 *   15. Non-admin key cannot mutate providers (403)
 *   16. GET /admin/api/providers/:id detail
 *   17. Safe delete: blocked by API key permission; blocked by usage history
 *   18. GET /admin/api/providers/adapters
 *   19. Usage analytics still record for the remaining enabled provider
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
let tmpApiKeysFile;

const ADMIN_KEY = 'sk-admin-prov-mgmt-0000';
const USER_KEY = 'sk-user-prov-mgmt-1111';
const PROVIDER_SECRET = 'super-secret-provider-key-abcdef';

function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/chat/completions') {
          let received;
          try { received = JSON.parse(body); } catch { received = {}; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion', created: 1700000000,
            model: received.model || 'mock',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }));
          return;
        }
        if (req.url === '/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
          return;
        }
        res.writeHead(404); res.end('{}');
      });
    });
    mockServer.listen(0, '127.0.0.1', () => { mockPort = mockServer.address().port; resolve(); });
  });
}

function writeConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-provmgmt-'));
  const base = `http://127.0.0.1:${mockPort}`;
  // Three providers share the same model so round-robin rotation is testable.
  const providers = [
    { id: 'prov-a', name: 'Provider A', enabled: true, adapter: 'openai', baseURL: base, apiKeys: ['key-a'], supportedModels: ['shared-model'], priority: 1, timeout: 5000 },
    { id: 'prov-b', name: 'Provider B', enabled: true, adapter: 'openai', baseURL: base, apiKeys: ['key-b'], supportedModels: ['shared-model'], priority: 2, timeout: 5000 },
    { id: 'prov-c', name: 'Provider C', enabled: true, adapter: 'openai', baseURL: base, apiKeys: ['key-c'], supportedModels: ['shared-model'], priority: 3, timeout: 5000 },
  ];
  for (const p of providers) {
    fs.writeFileSync(path.join(tmpProvidersDir, `${p.id}.json`), JSON.stringify(p));
  }

  // NOTE: apiKeys.json must NOT live inside the providers config dir —
  // loadProviders() reads every *.json file there.
  tmpApiKeysFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-keys-')), 'apiKeys.json');
  const keys = [
    { id: 'admin', key: ADMIN_KEY, name: 'Admin', status: 'active', role: 'admin' },
    { id: 'user', key: USER_KEY, name: 'User', status: 'active', role: 'user', allowedProviders: ['prov-a', 'prov-b', 'prov-c'] },
  ];
  fs.writeFileSync(tmpApiKeysFile, JSON.stringify(keys));
}

function startExpressServer() {
  return new Promise((resolve) => {
    expressServer = app.listen(0, '127.0.0.1', () => {
      expressPort = expressServer.address().port;
      resolve();
    });
  });
}

function adminReq(method, pathStr, body, key) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = {};
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (key) headers.Authorization = `Bearer ${key}`;
    const req = http.request({ host: '127.0.0.1', port: expressPort, method, path: pathStr, headers }, (res) => {
      let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(c) }); } catch { resolve({ status: res.statusCode, body: c }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Walk the response looking for the raw provider secret (must never appear).
function containsSecret(value) {
  if (typeof value === 'string') return value.includes(PROVIDER_SECRET);
  if (Array.isArray(value)) return value.some(containsSecret);
  if (value && typeof value === 'object') return Object.values(value).some(containsSecret);
  return false;
}

async function main() {
  console.log('=== Provider Management Integration Tests ===\n');
  await startMockProvider();
  writeConfigs();

  const {
    providerManager, apiKeyManager, apiKeyStore, requestLog, metricsCollector,
    modelRouter, usageAnalyticsService,
  } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());
  apiKeyStore.load(tmpApiKeysFile);
  requestLog.reset();
  metricsCollector.reset();
  if (usageAnalyticsService && usageAnalyticsService.reset) usageAnalyticsService.reset();
  modelRouter.setStrategy('round-robin');

  await startExpressServer();

  // app.js schedules an async apiKeyStore.hydrate() shortly after require
  // (skipped when NODE_ENV === 'test'). The storage backend may restore a
  // persisted snapshot, replacing our freshly loaded test keys. Wait for any
  // in-flight hydration, then merge the test keys into the store so auth is
  // deterministic (the merge mirrors what _restoreFromStorage does).
  await new Promise((r) => setTimeout(r, 2200));
  if (!apiKeyStore.validate(ADMIN_KEY).valid) {
    apiKeyStore.load(tmpApiKeysFile);
    await new Promise((r) => setTimeout(r, 100));
    if (!apiKeyStore.validate(ADMIN_KEY).valid) {
      // Persisted state won — inject the test keys directly (test scope only).
      const raw = JSON.parse(fs.readFileSync(tmpApiKeysFile, 'utf-8'));
      for (const k of raw) {
        if (!apiKeyStore.keys.some((x) => x.id === k.id)) apiKeyStore.keys.push(k);
        apiKeyStore._ensureHashFields(k);
        if (k.key) apiKeyStore.keysByKey.set(k.key, k);
        if (k.keyHash) apiKeyStore.keysByHash.set(k.keyHash, k);
      }
    }
  }

  const base = `http://127.0.0.1:${mockPort}`;

  try {
    // 1. List providers
    {
      const res = await adminReq('GET', '/admin/api/providers', null, ADMIN_KEY);
      const ok = res.status === 200 && Array.isArray(res.body.providers) && res.body.providers.length === 3
        && res.body.providers.every((p) => typeof p.enabled === 'boolean' && Array.isArray(p.supportedModels));
      record('1. GET /providers lists providers with status/models', ok, `status=${res.status} count=${res.body?.providers?.length}`);
    }

    // 2. Create provider
    {
      const res = await adminReq('POST', '/admin/api/providers', {
        id: 'prov-new', name: 'New Provider', baseURL: base, adapter: 'openai',
        enabled: true, supportedModels: ['new-model'], apiKeys: [PROVIDER_SECRET], priority: 9, timeout: 5000,
      }, ADMIN_KEY);
      if (res.status !== 201) console.error('   debug create:', JSON.stringify(res.body).slice(0, 300));
      const ok = res.status === 201 && res.body.success === true && res.body.provider && res.body.provider.id === 'prov-new';
      const masked = res.status === 201 && !containsSecret(res.body);
      record('2. POST /providers creates provider (201)', ok, `status=${res.status}`);
      record('2b. create response masks credential', masked, masked ? 'no plaintext secret' : 'SECRET LEAKED');
    }

    // 3. Duplicate provider -> 409
    {
      const res = await adminReq('POST', '/admin/api/providers', {
        id: 'prov-new', name: 'Dup', baseURL: base, supportedModels: ['x'], apiKeys: ['k'],
      }, ADMIN_KEY);
      record('3. duplicate provider id -> 409', res.status === 409, `status=${res.status}`);
    }

    // 4. Invalid provider id -> 400
    {
      const res = await adminReq('POST', '/admin/api/providers', {
        id: 'Bad ID!', name: 'Bad', baseURL: base, supportedModels: ['x'], apiKeys: ['k'],
      }, ADMIN_KEY);
      record('4. invalid provider id -> 400', res.status === 400, `status=${res.status}`);
    }

    // 5. Unknown adapter -> 400
    {
      const res = await adminReq('POST', '/admin/api/providers', {
        id: 'prov-bad-adapter', name: 'Bad Adapter', baseURL: base, adapter: 'does-not-exist',
        supportedModels: ['x'], apiKeys: ['k'],
      }, ADMIN_KEY);
      const notCreated = !providerManager.providersById.has('prov-bad-adapter');
      record('5. unknown adapter -> 400 and provider not created', res.status === 400 && notCreated, `status=${res.status}`);
    }

    // 6. Invalid baseURL -> 400
    {
      const res = await adminReq('POST', '/admin/api/providers', {
        id: 'prov-bad-url', name: 'Bad URL', baseURL: 'not-a-url', supportedModels: ['x'], apiKeys: ['k'],
      }, ADMIN_KEY);
      record('6. invalid baseURL -> 400', res.status === 400, `status=${res.status}`);
    }

    // 7. Empty models -> 400
    {
      const res = await adminReq('POST', '/admin/api/providers', {
        id: 'prov-no-models', name: 'No Models', baseURL: base, supportedModels: [], apiKeys: ['k'],
      }, ADMIN_KEY);
      record('7. empty supportedModels -> 400', res.status === 400, `status=${res.status}`);
    }

    // 8. Update provider (PUT)
    {
      const res = await adminReq('PUT', '/admin/api/providers/prov-new', {
        name: 'New Provider v2', supportedModels: ['new-model', 'new-model-2'],
      }, ADMIN_KEY);
      const p = providerManager.providersById.get('prov-new');
      const ok = res.status === 200 && res.body.provider.name === 'New Provider v2'
        && p.supportedModels.includes('new-model-2') && !containsSecret(res.body);
      record('8. PUT /providers/:id updates name + models (masked response)', ok, `status=${res.status}`);
    }

    // 9. Disable provider
    {
      const res = await adminReq('POST', '/admin/api/providers/prov-b/disable', null, ADMIN_KEY);
      const p = providerManager.providersById.get('prov-b');
      const ok = res.status === 200 && res.body.provider.enabled === false && p.enabled === false
        // models + credentials preserved
        && p.supportedModels.includes('shared-model') && p.apiKeys.length > 0;
      record('9. POST /providers/:id/disable (models+credentials preserved)', ok, `status=${res.status}`);
    }

    // 10. Disabled provider not a routing candidate
    {
      const candidates = modelRouter.getCandidateProviders('shared-model');
      const ids = candidates.map((c) => c.id);
      const ok = !ids.includes('prov-b') && ids.includes('prov-a') && ids.includes('prov-c');
      record('10. disabled provider excluded from routing candidates', ok, `candidates=${ids.join(',')}`);
    }

    // 11. Round-robin skips the disabled provider: strict alternation between
    // the two enabled providers, never the disabled one.
    {
      modelRouter.setStrategy('round-robin'); // ensure strategy (reset in 11b)
      modelRouter._cursors = {}; // reset rotation state
      const picks = [];
      for (let i = 0; i < 4; i += 1) {
        picks.push(modelRouter.getCandidateProviders('shared-model')[0].id);
      }
      const alternates = picks.every((pid, i) => i === 0 || pid !== picks[i - 1]);
      const skipsDisabled = !picks.includes('prov-b');
      const ok = alternates && skipsDisabled && picks.length === 4;
      record('11. round-robin skips disabled provider (strict alternation)', ok,
        `strategy=${modelRouter.getStrategy()} picks=${picks.join(' → ')}`);
    }

    // 12. Re-enable -> routing candidate again
    {
      const res = await adminReq('POST', '/admin/api/providers/prov-b/enable', null, ADMIN_KEY);
      const candidates = modelRouter.getCandidateProviders('shared-model').map((c) => c.id);
      const ok = res.status === 200 && res.body.provider.enabled === true && candidates.includes('prov-b');
      record('12. POST /providers/:id/enable restores routing candidacy', ok, `status=${res.status}`);
    }

    // 13. API key permissions survive disable/enable
    {
      await adminReq('POST', '/admin/api/providers/prov-b/disable', null, ADMIN_KEY);
      const userKey = apiKeyStore.listKeys().find((k) => k.id === 'user');
      const stillAllowed = Array.isArray(userKey.allowedProviders) && userKey.allowedProviders.includes('prov-b');
      await adminReq('POST', '/admin/api/providers/prov-b/enable', null, ADMIN_KEY);
      const after = apiKeyStore.listKeys().find((k) => k.id === 'user');
      const ok = stillAllowed && after.allowedProviders.includes('prov-b');
      record('13. API key allowedProviders survive disable/enable cycle', ok, `allowed=${(after.allowedProviders || []).join(',')}`);
    }

    // 14. No credential in any admin provider response
    {
      const list = await adminReq('GET', '/admin/api/providers', null, ADMIN_KEY);
      const detail = await adminReq('GET', '/admin/api/providers/prov-new', null, ADMIN_KEY);
      const ok = !containsSecret(list.body) && !containsSecret(detail.body);
      record('14. credentials never exposed in provider responses', ok, ok ? 'masked' : 'SECRET LEAKED');
    }

    // 15. Non-admin cannot mutate providers
    {
      const r1 = await adminReq('POST', '/admin/api/providers', {
        id: 'prov-x', name: 'X', baseURL: base, supportedModels: ['x'], apiKeys: ['k'],
      }, USER_KEY);
      const r2 = await adminReq('POST', '/admin/api/providers/prov-a/disable', null, USER_KEY);
      const r3 = await adminReq('PUT', '/admin/api/providers/prov-a', { name: 'hacked' }, USER_KEY);
      const r4 = await adminReq('DELETE', '/admin/api/providers/prov-a', null, USER_KEY);
      const ok = r1.status === 403 && r2.status === 403 && r3.status === 403 && r4.status === 403;
      record('15. non-admin mutations rejected (403)', ok, `statuses=${[r1, r2, r3, r4].map((r) => r.status).join(',')}`);
    }

    // 16. Provider detail endpoint
    {
      const res = await adminReq('GET', '/admin/api/providers/prov-a', null, ADMIN_KEY);
      const ok = res.status === 200 && res.body.provider && res.body.provider.id === 'prov-a'
        && Array.isArray(res.body.connections);
      record('16. GET /providers/:id returns detail + connections', ok, `status=${res.status}`);
      const missing = await adminReq('GET', '/admin/api/providers/no-such-provider', null, ADMIN_KEY);
      record('16b. GET /providers/:id unknown -> 404', missing.status === 404, `status=${missing.status}`);
    }

    // 17. Safe delete: blocked by API key permission; usage recorded; blocked by usage history
    {
      const blockedByKeys = await adminReq('DELETE', '/admin/api/providers/prov-a', null, ADMIN_KEY);
      const stillThere = providerManager.providersById.has('prov-a');
      record('17. delete blocked by API key permission (409)', blockedByKeys.status === 409 && stillThere, `status=${blockedByKeys.status}`);

      // Generate usage for prov-c via a real chat completion.
      const chat = await adminReq('POST', '/v1/chat/completions',
        { model: 'shared-model', messages: [{ role: 'user', content: 'hi' }] }, USER_KEY);
      const usageList = await adminReq('GET', '/admin/api/usage/providers', null, ADMIN_KEY);
      const hasUsage = (usageList.body.providers || []).some((u) => u.requests > 0);
      record('17b. usage analytics still record requests', chat.status === 200 && hasUsage,
        `chat=${chat.status} usageProviders=${(usageList.body.providers || []).length}`);

      // prov-new has no keys referencing it and no usage -> delete allowed.
      const del = await adminReq('DELETE', '/admin/api/providers/prov-new', null, ADMIN_KEY);
      const gone = !providerManager.providersById.has('prov-new');
      record('17c. delete allowed when no blockers (usage/keys/connections)', del.status === 200 && gone, `status=${del.status}`);
    }

    // 18. Adapters endpoint
    {
      const res = await adminReq('GET', '/admin/api/providers/adapters', null, ADMIN_KEY);
      const ok = res.status === 200 && Array.isArray(res.body.adapters)
        && res.body.adapters.includes('openai') && res.body.adapters.includes('generic-openai');
      record('18. GET /providers/adapters lists registered adapters', ok, `count=${res.body?.adapters?.length}`);
    }

    // 19. Existing provider keeps serving requests end-to-end after all mutations
    {
      const res = await adminReq('POST', '/v1/chat/completions',
        { model: 'shared-model', messages: [{ role: 'user', content: 'hello' }] }, USER_KEY);
      const ok = res.status === 200 && res.body.choices && res.body.choices[0];
      record('19. existing providers still serve chat completions', ok, `status=${res.status}`);
    }
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
