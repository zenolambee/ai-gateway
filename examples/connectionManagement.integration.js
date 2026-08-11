/**
 * Integration tests for Connection Management (provider credentials via the
 * Dashboard admin API).
 *
 * Run:  node examples/connectionManagement.integration.js
 *
 * Verifies:
 *   1.  Create connection (201, credential never returned)
 *   2.  Create multiple connections for one provider
 *   3.  Duplicate connection -> 409
 *   4.  Credential is encrypted at rest (envelope, not plaintext)
 *   5.  Credential never appears in any admin response
 *   6.  Test connection success (mock 200)
 *   7.  Test connection 401
 *   8.  Test connection 403
 *   9.  Test connection 429
 *   10. Test connection timeout
 *   11. Disable connection
 *   12. Enable connection
 *   13. Disabled connection excluded from selection (round-robin)
 *   14. Multiple connections rotate A -> C when B disabled
 *   15. Edit connection preserves credential when no new key given
 *   16. Edit connection rotates credential when new key given
 *   17. List connections (flat + nested) — masked
 *   18. Non-admin rejected for all mutations (403)
 *   19. Backup contains no plaintext credential
 *   20. Delete connection removes credential + record
 *   21. Unknown provider -> 404 on create
 *   22. Detail endpoint returns health metadata
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
let tmpKeysDir;
let mockBehavior = { status: 200 }; // mutable upstream behaviour per test

const ADMIN_KEY = 'sk-admin-conn-mgmt-0000';
const USER_KEY = 'sk-user-conn-mgmt-1111';
const CONN_SECRET = 'nvapi-super-secret-connection-key-0001';

function startMockProvider() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (mockBehavior.status === 'timeout') {
          // Never respond — let the client time out.
          return;
        }
        if (req.url === '/models') {
          res.writeHead(mockBehavior.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
          return;
        }
        if (req.url === '/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-mock', object: 'chat.completion', created: 1700000000,
            model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
          return;
        }
        res.writeHead(404); res.end('{}');
      });
    });
    mockServer.listen(0, '127.0.0.1', () => { mockPort = mockServer.address().port; resolve(); });
  });
}

function writeConfigs() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-connmgmt-'));
  const base = `http://127.0.0.1:${mockPort}`;
  const provider = {
    id: 'mockprov', name: 'Mock Provider', enabled: true, adapter: 'openai',
    baseURL: base, apiKeys: ['fallback-key'], supportedModels: ['mock-model'], priority: 1, timeout: 5000,
  };
  fs.writeFileSync(path.join(tmpProvidersDir, 'mockprov.json'), JSON.stringify(provider));

  tmpKeysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-connkeys-'));
  fs.writeFileSync(path.join(tmpKeysDir, 'apiKeys.json'), JSON.stringify([
    { id: 'admin', key: ADMIN_KEY, name: 'Admin', status: 'active', role: 'admin' },
    { id: 'user', key: USER_KEY, name: 'User', status: 'active', role: 'user', allowedProviders: ['mockprov'], allowedModels: ['mock-model'] },
  ]));
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

function containsSecret(value, secret) {
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some((v) => containsSecret(v, secret));
  if (value && typeof value === 'object') return Object.values(value).some((v) => containsSecret(v, secret));
  return false;
}

async function main() {
  console.log('=== Connection Management Integration Tests ===\n');
  await startMockProvider();
  writeConfigs();

  const {
    providerManager, apiKeyManager, apiKeyStore, requestLog, metricsCollector,
    connectionRegistry, accountManager, connectionManager, backupService,
  } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());
  apiKeyStore.load(path.join(tmpKeysDir, 'apiKeys.json'));
  requestLog.reset();
  metricsCollector.reset();

  expressServer = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  expressPort = expressServer.address().port;

  // Deterministic auth: wait for any scheduled hydration, then ensure test
  // keys are present (see providerManagement.integration.js for rationale).
  await new Promise((r) => setTimeout(r, 2200));
  if (!apiKeyStore.validate(ADMIN_KEY).valid) {
    apiKeyStore.load(path.join(tmpKeysDir, 'apiKeys.json'));
    await new Promise((r) => setTimeout(r, 100));
    if (!apiKeyStore.validate(ADMIN_KEY).valid) {
      const raw = JSON.parse(fs.readFileSync(path.join(tmpKeysDir, 'apiKeys.json'), 'utf-8'));
      for (const k of raw) {
        if (!apiKeyStore.keys.some((x) => x.id === k.id)) apiKeyStore.keys.push(k);
        apiKeyStore._ensureHashFields(k);
        if (k.key) apiKeyStore.keysByKey.set(k.key, k);
        if (k.keyHash) apiKeyStore.keysByHash.set(k.keyHash, k);
      }
    }
  }

  try {
    // 1. Create connection
    {
      const res = await adminReq('POST', '/admin/api/providers/mockprov/connections', {
        id: 'conn-a', name: 'Mock Production', apiKey: CONN_SECRET,
      }, ADMIN_KEY);
      const ok = res.status === 201 && res.body.success === true;
      const masked = res.status === 201 && !containsSecret(res.body, CONN_SECRET);
      record('1. POST /providers/:id/connections creates connection (201)', ok, `status=${res.status}`);
      record('1b. create response never contains plaintext credential', masked, masked ? 'masked' : 'SECRET LEAKED');
    }

    // 2. Multiple connections
    {
      const r2 = await adminReq('POST', '/admin/api/providers/mockprov/connections', { id: 'conn-b', name: 'Mock Backup', apiKey: 'backup-key-1234567890' }, ADMIN_KEY);
      const r3 = await adminReq('POST', '/admin/api/providers/mockprov/connections', { id: 'conn-c', name: 'Mock Account 3', apiKey: 'third-key-1234567890' }, ADMIN_KEY);
      const list = await adminReq('GET', '/admin/api/providers/mockprov/connections', null, ADMIN_KEY);
      const ok = r2.status === 201 && r3.status === 201 && list.status === 200 && list.body.connections.length === 3;
      record('2. multiple connections per provider', ok, `count=${list.body?.connections?.length}`);
    }

    // 3. Duplicate connection -> 409
    {
      const res = await adminReq('POST', '/admin/api/providers/mockprov/connections', { id: 'conn-a', apiKey: 'x' }, ADMIN_KEY);
      record('3. duplicate connection -> 409', res.status === 409, `status=${res.status}`);
    }

    // 4. Credential encrypted at rest (storage backend holds the envelope;
    //    the in-memory registry copy is the runtime representation).
    {
      const store = connectionRegistry._getStore();
      let persisted = null;
      if (store) {
        const keys = await store.keys('*');
        const k = keys.find((key) => key.includes('gatewayAccount:conn-a'));
        if (k) persisted = await store.get(k.slice(k.indexOf('gatewayAccount')));
      }
      const cred = persisted && persisted.credential;
      const isEnvelope = cred && typeof cred === 'object' && typeof cred.data === 'string' && cred.iv !== undefined;
      const notPlain = persisted && !containsSecret(persisted, CONN_SECRET);
      if (!isEnvelope || !notPlain) {
        console.error('   debug store record:', JSON.stringify(persisted).slice(0, 200));
      }
      record('4. credential persisted as encrypted envelope', !!(isEnvelope && notPlain), isEnvelope ? 'envelope {v,iv,tag,data}' : JSON.stringify(cred).slice(0, 60));
    }

    // 5. No response exposes the credential
    {
      const list = await adminReq('GET', '/admin/api/accounts', null, ADMIN_KEY);
      const nested = await adminReq('GET', '/admin/api/providers/mockprov/connections', null, ADMIN_KEY);
      const detail = await adminReq('GET', '/admin/api/accounts/conn-a/detail', null, ADMIN_KEY);
      const statusRes = await adminReq('GET', '/admin/api/accounts/conn-a/status', null, ADMIN_KEY);
      const ok = [list, nested, detail, statusRes].every((r) => !containsSecret(r.body, CONN_SECRET));
      record('5. credential absent from list/nested/detail/status responses', ok, ok ? 'masked everywhere' : 'SECRET LEAKED');
    }

    // 6. Test connection success
    {
      mockBehavior.status = 200;
      const res = await adminReq('POST', '/admin/api/providers/mockprov/connections/conn-a/test', null, ADMIN_KEY);
      const ok = res.status === 200 && res.body.success === true && typeof res.body.latencyMs === 'number' && !containsSecret(res.body, CONN_SECRET);
      record('6. test connection success (latency recorded)', ok, `success=${res.body?.success} latency=${res.body?.latencyMs}ms`);
    }

    // 7-9. Test connection error classification (401/403/429)
    for (const [n, code, label] of [[7, 401, '401'], [8, 403, '403'], [9, 429, '429']]) {
      mockBehavior.status = code;
      const res = await adminReq('POST', '/admin/api/providers/mockprov/connections/conn-a/test', null, ADMIN_KEY);
      const ok = res.status === 200 && res.body.success === false
        && typeof res.body.error === 'string' && res.body.error.includes(String(code))
        && !containsSecret(res.body, CONN_SECRET);
      record(`${n}. test connection ${label} classified without leaking secret`, ok, `error="${res.body?.error}"`);
    }

    // 10. Timeout
    {
      mockBehavior.status = 'timeout';
      const res = await adminReq('POST', '/admin/api/providers/mockprov/connections/conn-a/test', null, ADMIN_KEY);
      mockBehavior.status = 200;
      const ok = res.status === 200 && res.body.success === false && /timed out|timeout/i.test(res.body.error || '');
      record('10. test connection timeout handled', ok, `error="${res.body?.error}"`);
    }

    // 11 + 13. Disable connection -> excluded from selection
    {
      const res = await adminReq('POST', '/admin/api/providers/mockprov/connections/conn-b/disable', null, ADMIN_KEY);
      const raw = await connectionRegistry._loadAccount('conn-b');
      const disabled = res.status === 200 && raw.enabled === false && !!raw.credential; // credential preserved
      const avail = await accountManager.getAvailableAccounts('mockprov');
      const excluded = !avail.some((a) => (a.accountId || a.id) === 'conn-b');
      record('11. disable connection (credential + record preserved)', disabled, `status=${res.status}`);
      record('13. disabled connection excluded from eligible candidates', excluded, `available=${avail.map((a) => a.accountId || a.id).join(',')}`);
    }

    // 14. Round-robin rotates A -> C -> A (B disabled)
    {
      accountManager._cursors.set('mockprov', { lastIdx: -1, strategy: 'round-robin' });
      const picks = [];
      for (let i = 0; i < 4; i += 1) {
        const sel = await accountManager.selectAccount('mockprov', { strategy: 'round-robin' });
        picks.push(sel && (sel.id || sel.accountId));
      }
      const alternates = picks.every((id, i) => i === 0 || id !== picks[i - 1]);
      const skipsB = !picks.includes('conn-b');
      record('14. round-robin skips disabled connection (A↔C)', alternates && skipsB, `picks=${picks.join(' → ')}`);
    }

    // 12. Enable connection
    {
      const res = await adminReq('POST', '/admin/api/providers/mockprov/connections/conn-b/enable', null, ADMIN_KEY);
      const avail = await accountManager.getAvailableAccounts('mockprov');
      const ok = res.status === 200 && avail.some((a) => (a.accountId || a.id) === 'conn-b');
      record('12. enable connection restores eligibility', ok, `status=${res.status}`);
    }

    // 15. Edit without new key preserves credential
    {
      const res = await adminReq('PUT', '/admin/api/accounts/conn-a', { displayName: 'Mock Production v2' }, ADMIN_KEY);
      const plain = connectionRegistry._plain(await connectionRegistry._loadAccount('conn-a'));
      const ok = res.status === 200 && plain.credential && plain.credential.apiKey === CONN_SECRET;
      record('15. edit without new key preserves stored credential', ok, `status=${res.status}`);
    }

    // 16. Edit with new key rotates credential
    {
      const NEW = 'nvapi-rotated-key-9999';
      const res = await adminReq('PUT', '/admin/api/accounts/conn-a', { apiKey: NEW }, ADMIN_KEY);
      const plain = connectionRegistry._plain(await connectionRegistry._loadAccount('conn-a'));
      const ok = res.status === 200 && plain.credential.apiKey === NEW && !containsSecret(res.body, NEW);
      record('16. edit with new key rotates credential (masked response)', ok, `status=${res.status}`);
    }

    // 17. Flat + nested list shapes
    {
      const flat = await adminReq('GET', '/admin/api/accounts?providerId=mockprov', null, ADMIN_KEY);
      const nested = await adminReq('GET', '/admin/api/providers/mockprov/connections', null, ADMIN_KEY);
      const ok = flat.status === 200 && flat.body.accounts.length === 3 && nested.body.connections.length === 3;
      record('17. list connections (flat + nested)', ok, `flat=${flat.body?.accounts?.length} nested=${nested.body?.connections?.length}`);
    }

    // 22. Detail endpoint health metadata
    {
      const res = await adminReq('GET', '/admin/api/accounts/conn-a/detail', null, ADMIN_KEY);
      const c = res.body.connection || {};
      const ok = res.status === 200 && c.providerId === 'mockprov'
        && typeof c.successCount === 'number' && c.successCount > 0
        && typeof c.lastLatencyMs === 'number';
      record('22. connection detail returns health/usage metadata', ok, `successCount=${c.successCount} latency=${c.lastLatencyMs}`);
    }

    // 18. Non-admin rejected for every mutation
    {
      const r1 = await adminReq('POST', '/admin/api/providers/mockprov/connections', { id: 'x', apiKey: 'y' }, USER_KEY);
      const r2 = await adminReq('PUT', '/admin/api/accounts/conn-a', { displayName: 'hacked' }, USER_KEY);
      const r3 = await adminReq('POST', '/admin/api/accounts/conn-a/disable', null, USER_KEY);
      const r4 = await adminReq('DELETE', '/admin/api/accounts/conn-a', null, USER_KEY);
      const r5 = await adminReq('POST', '/admin/api/providers/mockprov/connections/conn-a/test', null, USER_KEY);
      const ok = [r1, r2, r3, r4, r5].every((r) => r.status === 403);
      record('18. non-admin mutations rejected (403)', ok, `statuses=${[r1, r2, r3, r4, r5].map((r) => r.status).join(',')}`);
    }

    // 21. Unknown provider -> 404 on create
    {
      const res = await adminReq('POST', '/admin/api/providers/no-such/connections', { id: 'z', apiKey: 'k' }, ADMIN_KEY);
      record('21. create connection for unknown provider -> 404', res.status === 404, `status=${res.status}`);
    }

    // 19. Backup contains no plaintext credential
    {
      const res = await adminReq('POST', '/admin/api/backup', {}, ADMIN_KEY);
      const ok = res.status === 200 && !containsSecret(res.body, CONN_SECRET) && !containsSecret(res.body, 'nvapi-rotated-key-9999');
      record('19. backup contains no plaintext credential', ok, `status=${res.status}`);
    }

    // 20. Delete connection
    {
      const res = await adminReq('DELETE', '/admin/api/accounts/conn-c', null, ADMIN_KEY);
      const store = connectionRegistry._getStore();
      const keys = store ? await store.keys('*') : [];
      const persisted = keys.some((k) => k.includes('gatewayAccount:conn-c'));
      const list = await adminReq('GET', '/admin/api/providers/mockprov/connections', null, ADMIN_KEY);
      const inList = (list.body.connections || []).some((c) => (c.id || c.accountId) === 'conn-c');
      if (persisted || inList) {
        console.error('   debug delete: status', res.status, 'persisted:', persisted, 'inList:', inList,
          'list:', (list.body.connections || []).map((c) => c.id || c.accountId).join(','),
          'registryHas:', connectionRegistry.accounts.has('conn-c'),
          'amHas:', accountManager._accounts.has('conn-c'));
      }
      const ok = res.status === 200 && !persisted && !inList;
      record('20. delete connection removes credential + record', ok, `status=${res.status} remaining=${list.body?.connections?.length}`);
    }
  } finally {
    await new Promise((r) => expressServer.close(r));
    await new Promise((r) => mockServer.close(r));
    fs.rmSync(tmpProvidersDir, { recursive: true, force: true });
    fs.rmSync(tmpKeysDir, { recursive: true, force: true });
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
