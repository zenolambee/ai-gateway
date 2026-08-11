/**
 * Integration tests for Routing Management (Routing Strategy & Round-Robin).
 *
 * Run:  node examples/routingManagement.integration.js
 *
 * Verifies (all against the EXISTING routing architecture — ModelRouter,
 * RoutingStrategy, RoutingRuleEngine, AccountManager, ConnectionManager):
 *
 *   1.  Priority routing (provider level)
 *   2.  Round-robin routing (provider level, stateful)
 *   3.  Round-robin concurrency safety (atomic cursor)
 *   4.  Weighted routing (connection level, proportional distribution)
 *   5.  Least-used routing (connection level)
 *   6.  Random routing (connection level)
 *   7.  Disabled connection excluded from rotation
 *   8.  Disabled provider excluded
 *   9.  Unhealthy provider excluded (circuit breaker)
 *   10. API key provider permission enforced
 *   11. API key model permission enforced
 *   12. Model-based routing rule (strategy + connection allow-list)
 *   13. Failover on 401 (auth failure marks key, next provider serves)
 *   14. Failover on 429 (rate-limit failover)
 *   15. Failover on 5xx
 *   16. Timeout failover
 *   17. Maximum retry bound (no infinite retry)
 *   18. All connections/providers failed -> real error (no fake success)
 *   19. No eligible connection -> clear error
 *   20. Routing config persistence (routing.json)
 *   21. Routing config validation (invalid strategy rejected)
 *   22. Admin authorization (non-admin cannot mutate routing)
 *   23. No credential leakage in routing endpoints
 *   24. Backup contains routing config + model rules (no secrets)
 *   25. Usage analytics compatibility (requestLog carries routing metadata)
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

// ---------------------------------------------------------------
// Mock provider infrastructure
// ---------------------------------------------------------------

function createMockProvider(opts = {}) {
  const state = { seen: [], behaviour: { mode: 'ok' } };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      const key = auth.replace('Bearer ', '');
      state.seen.push(key);
      const behaviour = state.behaviour;

      if (behaviour.mode === 'timeout') return; // never respond

      const failKey = behaviour.failKeys && behaviour.failKeys.has(key);
      if (behaviour.mode === 'fail-all' || failKey) {
        const status = failKey ? behaviour.failKeys.get(key) : behaviour.status;
        res.writeHead(status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock failure ${status || 500}` } }));
        return;
      }

      if (req.url === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: opts.model, object: 'model' }] }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl-${opts.id}`, object: 'chat.completion', created: 1700000000,
        model: opts.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `from-${opts.id}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  return {
    server,
    id: opts.id,
    port: 0,
    seen: state.seen,
    behaviour: state.behaviour,
    start() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => { this.port = server.address().port; resolve(); });
      });
    },
    stop() { return new Promise((r) => server.close(r)); },
  };
}

// ---------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------

const ADMIN_KEY = 'sk-admin-routing-mgmt-0000';
const USER_KEY = 'sk-user-routing-mgmt-1111';
const RESTRICTED_KEY = 'sk-user-routing-restricted-2222';

let expressServer;
let expressPort;
let tmpProvidersDir;
let tmpKeysDir;
let tmpConfigDir;
let mocks = {};

function adminReq(method, pathStr, body, key) {
  return new Promise((resolve, reject) => {
    // Only attach a body (and JSON headers) when one is actually provided —
    // sending Content-Length: 0 with a content-type makes express.json()
    // reject empty bodies with a 400 before auth runs.
    const hasBody = body !== null && body !== undefined;
    const data = hasBody ? JSON.stringify(body) : null;
    const headers = {};
    if (hasBody) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
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

function chat(model, key, extra) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(Object.assign({ model, messages: [{ role: 'user', content: 'hi' }] }, extra || {}));
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (key) headers.Authorization = `Bearer ${key}`;
    const req = http.request({
      host: '127.0.0.1', port: expressPort, method: 'POST', path: '/v1/chat/completions', headers,
    }, (res) => {
      let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(c) }); } catch { resolve({ status: res.statusCode, body: c }); }
      });
    });
    req.on('error', reject);
    req.write(data);
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
  console.log('=== Routing Management Integration Tests ===\n');

  // Mock upstreams
  mocks = {
    A: createMockProvider({ id: 'A', model: 'route-model' }),
    B: createMockProvider({ id: 'B', model: 'route-model' }),
    C: createMockProvider({ id: 'C', model: 'route-model' }),
  };
  await Promise.all(Object.values(mocks).map((m) => m.start()));

  // Provider configs: three providers serving the same model.
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-routing-prov-'));
  const mk = (id, port, extra = {}) => fs.writeFileSync(
    path.join(tmpProvidersDir, `${id}.json`),
    JSON.stringify({
      id, name: `Provider ${id}`, enabled: true, adapter: 'openai',
      baseURL: `http://127.0.0.1:${port}`, apiKeys: [`key-${id}-1`, `key-${id}-2`],
      supportedModels: ['route-model'], priority: 100, timeout: 3000, ...extra,
    }),
  );
  mk('provA', mocks.A.port, { priority: 1, weight: 70 });
  mk('provB', mocks.B.port, { priority: 2, weight: 20 });
  mk('provC', mocks.C.port, { priority: 3, weight: 10 });

  // Gateway API keys
  tmpKeysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-routing-keys-'));
  fs.writeFileSync(path.join(tmpKeysDir, 'apiKeys.json'), JSON.stringify([
    { id: 'admin', key: ADMIN_KEY, name: 'Admin', status: 'active', role: 'admin' },
    { id: 'user', key: USER_KEY, name: 'User', status: 'active', role: 'user' },
    {
      id: 'restricted', key: RESTRICTED_KEY, name: 'Restricted', status: 'active', role: 'user',
      allowedProviders: ['provA'], allowedModels: ['route-model'],
    },
  ]));

  // Point the routing config files at a scratch dir so persistence tests do
  // not touch the repo config.
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-routing-cfg-'));
  process.env.ROUTING_CONFIG_FILE = path.join(tmpConfigDir, 'routing.json');
  process.env.ROUTING_RULES_CONFIG_FILE = path.join(tmpConfigDir, 'routingRules.json');

  const {
    providerManager, apiKeyManager, apiKeyStore, modelRouter, routingStrategy,
    healthMonitor, accountManager, connectionRegistry, requestLog, routingConfig,
    requestExecutor,
  } = require('../src/services');
  providerManager.load(tmpProvidersDir);
  apiKeyManager.load(providerManager.listProviders());
  apiKeyStore.load(path.join(tmpKeysDir, 'apiKeys.json'));
  healthMonitor.reset();
  requestLog.reset();
  modelRouter.setStrategy('priority');
  accountManager.setDefaultStrategy('priority');
  requestExecutor.maxRetries = 1; // keep failover tests fast + deterministic

  expressServer = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  expressPort = expressServer.address().port;

  // Deterministic auth: ensure the test keys are present (mirrors the
  // connectionManagement suite rationale — async hydration race).
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

  const reset = async () => {
    for (const m of Object.values(mocks)) { m.seen.length = 0; m.behaviour.mode = 'ok'; m.behaviour.failKeys = null; }
    healthMonitor.reset();
    apiKeyManager.load(providerManager.listProviders());
    // Wait for the async storage restore to settle, THEN force every key
    // ACTIVE + cooldown-free so tests never race the restore.
    if (typeof apiKeyManager.whenReady === 'function') await apiKeyManager.whenReady();
    for (const records of apiKeyManager.keysByProvider.values()) {
      for (const r of records) { r.status = 'ACTIVE'; r.cooldownUntil = null; r.stats.consecutiveFailures = 0; }
    }
    // Deterministic routing state per test.
    modelRouter.setStrategy('priority');
    modelRouter._cursors = {};
    accountManager.setDefaultStrategy('priority');
    accountManager.setProviderStrategy('provA', null);
    // Remove any connections registered by earlier tests so provider-level
    // tests use the provider-config keys (legacy path) deterministically.
    for (const cid of ['rr-a', 'rr-b', 'rr-c']) {
      if (connectionRegistry.accounts.has(cid)) connectionRegistry.accounts.delete(cid);
      accountManager.removeAccount(cid);
    }
  };

  try {
    // ----------------------------------------------------------
    // 1. Priority routing (provider level)
    // ----------------------------------------------------------
    {
      await reset();
      modelRouter.setStrategy('priority');
      const res = await chat('route-model', USER_KEY);
      const ok = res.status === 200 && mocks.A.seen.length > 0 && mocks.B.seen.length === 0 && mocks.C.seen.length === 0;
      record('1. priority routing picks highest-priority provider', ok,
        `status=${res.status} A=${mocks.A.seen.length} B=${mocks.B.seen.length} C=${mocks.C.seen.length}`);
    }

    // ----------------------------------------------------------
    // 2. Round-robin routing (provider level, stateful)
    // ----------------------------------------------------------
    {
      await reset();
      modelRouter.setStrategy('round-robin');
      modelRouter._cursors = {}; // deterministic start
      const order = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await chat('route-model', USER_KEY);
        if (r.status === 200) {
          if (mocks.A.seen.length > order.filter((x) => x === 'A').length) order.push('A');
          else if (mocks.B.seen.length > order.filter((x) => x === 'B').length) order.push('B');
          else order.push('C');
        }
      }
      // Priority order A(1),B(2),C(3) rotated: first request A, second B, third C.
      const ok = order.length === 3 && order[0] === 'A' && order[1] === 'B' && order[2] === 'C';
      record('2. round-robin rotates across providers (A→B→C)', ok, `order=${order.join('→')}`);
    }

    // ----------------------------------------------------------
    // 3. Round-robin concurrency safety (no duplicate consecutive picks)
    // ----------------------------------------------------------
    {
      await reset();
      modelRouter.setStrategy('round-robin');
      modelRouter._cursors = {};
      // Fire 6 concurrent requests; with an atomic cursor each gets a
      // distinct rotation slot (3 providers → each hit exactly twice).
      await Promise.all(Array.from({ length: 6 }, () => chat('route-model', USER_KEY)));
      const counts = [mocks.A.seen.length, mocks.B.seen.length, mocks.C.seen.length];
      const ok = counts.every((c) => c === 2);
      record('3. round-robin concurrency-safe (even distribution, no race)', ok, `counts=A:${counts[0]},B:${counts[1]},C:${counts[2]}`);
    }

    // ----------------------------------------------------------
    // 7. Disabled connection excluded + connection round-robin A↔C
    // ----------------------------------------------------------
    let connIds = [];
    {
      // Register three connections on provA.
      for (const [cid, secret] of [['rr-a', 'sk-rr-a-0001'], ['rr-b', 'sk-rr-b-0002'], ['rr-c', 'sk-rr-c-0003']]) {
        await adminReq('POST', '/admin/api/providers/provA/connections', { id: cid, name: cid, apiKey: secret }, ADMIN_KEY);
      }
      connIds = ['rr-a', 'rr-b', 'rr-c'];
      accountManager.setDefaultStrategy('round-robin');
      accountManager.setProviderStrategy('provA', 'round-robin');
      accountManager._cursors.delete('provA');
      const picks = [];
      for (let i = 0; i < 6; i += 1) {
        const sel = await accountManager.selectAccount('provA', {});
        picks.push(sel && sel.id);
      }
      const rotates = picks[0] === 'rr-a' && picks[1] === 'rr-b' && picks[2] === 'rr-c' && picks[3] === 'rr-a';
      record('7a. connection round-robin is stateful (A→B→C→A)', rotates, `picks=${picks.slice(0, 4).join('→')}`);

      // Disable B → rotation must become A→C→A→C (never B).
      await adminReq('POST', '/admin/api/providers/provA/connections/rr-b/disable', null, ADMIN_KEY);
      accountManager._cursors.delete('provA');
      const picks2 = [];
      for (let i = 0; i < 4; i += 1) {
        const sel = await accountManager.selectAccount('provA', {});
        picks2.push(sel && sel.id);
      }
      const noB = !picks2.includes('rr-b');
      const alternates = picks2[0] === 'rr-a' && picks2[1] === 'rr-c' && picks2[2] === 'rr-a' && picks2[3] === 'rr-c';
      record('7. disabled connection excluded from round-robin (A↔C)', noB && alternates, `picks=${picks2.join('→')}`);
      await adminReq('POST', '/admin/api/providers/provA/connections/rr-b/enable', null, ADMIN_KEY);
    }

    // ----------------------------------------------------------
    // 4. Weighted routing (connection level, ~70/20/10 over many picks)
    // ----------------------------------------------------------
    {
      await adminReq('PUT', '/admin/api/accounts/rr-a', { weight: 70 }, ADMIN_KEY);
      await adminReq('PUT', '/admin/api/accounts/rr-b', { weight: 20 }, ADMIN_KEY);
      await adminReq('PUT', '/admin/api/accounts/rr-c', { weight: 10 }, ADMIN_KEY);
      const counts = { 'rr-a': 0, 'rr-b': 0, 'rr-c': 0 };
      const N = 400;
      for (let i = 0; i < N; i += 1) {
        const sel = await accountManager.selectAccount('provA', { strategy: 'weighted' });
        if (sel && counts[sel.id] !== undefined) counts[sel.id] += 1;
      }
      const aPct = counts['rr-a'] / N;
      const ok = aPct > 0.55 && aPct < 0.85 && counts['rr-b'] > counts['rr-c'];
      record('4. weighted routing approximates 70/20/10', ok,
        `a=${(aPct * 100).toFixed(1)}% b=${((counts['rr-b'] / N) * 100).toFixed(1)}% c=${((counts['rr-c'] / N) * 100).toFixed(1)}%`);
      // restore equal weights
      await adminReq('PUT', '/admin/api/accounts/rr-a', { weight: 1 }, ADMIN_KEY);
      await adminReq('PUT', '/admin/api/accounts/rr-b', { weight: 1 }, ADMIN_KEY);
      await adminReq('PUT', '/admin/api/accounts/rr-c', { weight: 1 }, ADMIN_KEY);
    }

    // ----------------------------------------------------------
    // 5. Least-used routing (connection level)
    // ----------------------------------------------------------
    {
      // Reset usage so counts are deterministic.
      accountManager._health.clear();
      accountManager.recordUsage('rr-a'); accountManager.recordUsage('rr-a');
      accountManager.recordUsage('rr-b');
      const sel = await accountManager.selectAccount('provA', { strategy: 'least-used' });
      record('5. least-used picks the connection with lowest usage', sel && sel.id === 'rr-c', `picked=${sel && sel.id}`);
      accountManager._health.clear();
    }

    // ----------------------------------------------------------
    // 6. Random routing (connection level — all eligible eventually picked)
    // ----------------------------------------------------------
    {
      const seen = new Set();
      for (let i = 0; i < 60; i += 1) {
        const sel = await accountManager.selectAccount('provA', { strategy: 'random' });
        if (sel) seen.add(sel.id);
      }
      record('6. random routing covers all eligible connections', seen.size === 3, `seen=${[...seen].join(',')}`);
    }

    // ----------------------------------------------------------
    // 8. Disabled provider excluded
    // ----------------------------------------------------------
    {
      await reset();
      modelRouter.setStrategy('priority');
      await adminReq('POST', '/admin/api/providers/provA/disable', null, ADMIN_KEY);
      const res = await chat('route-model', USER_KEY);
      const ok = res.status === 200 && mocks.A.seen.length === 0 && mocks.B.seen.length > 0;
      record('8. disabled provider excluded from routing', ok,
        `status=${res.status} A=${mocks.A.seen.length} B=${mocks.B.seen.length}`);
      await adminReq('POST', '/admin/api/providers/provA/enable', null, ADMIN_KEY);
    }

    // ----------------------------------------------------------
    // 9. Unhealthy provider excluded (circuit breaker)
    // ----------------------------------------------------------
    {
      await reset();
      modelRouter.setStrategy('priority');
      for (let i = 0; i < 6; i += 1) healthMonitor.recordFailure({ providerId: 'provA', errorCode: 'PROVIDER_SERVER_ERROR' });
      const available = healthMonitor.isAvailable('provA');
      const res = await chat('route-model', USER_KEY);
      const ok = !available && res.status === 200 && mocks.A.seen.length === 0 && mocks.B.seen.length > 0;
      record('9. unhealthy provider (open circuit) excluded', ok,
        `available=${available} A=${mocks.A.seen.length} B=${mocks.B.seen.length}`);
      healthMonitor.reset();
    }

    // ----------------------------------------------------------
    // 10. API key provider permission enforced
    // ----------------------------------------------------------
    {
      await reset();
      modelRouter.setStrategy('round-robin');
      modelRouter._cursors = {};
      // Restricted key may ONLY use provA. Rotate: all 3 requests must hit A.
      for (let i = 0; i < 3; i += 1) await chat('route-model', RESTRICTED_KEY);
      const ok = mocks.A.seen.length === 3 && mocks.B.seen.length === 0 && mocks.C.seen.length === 0;
      record('10. API key provider permission respected (restricted→provA)', ok,
        `A=${mocks.A.seen.length} B=${mocks.B.seen.length} C=${mocks.C.seen.length}`);
    }

    // ----------------------------------------------------------
    // 11. API key model permission enforced
    // ----------------------------------------------------------
    {
      const res = await chat('forbidden-model', RESTRICTED_KEY);
      const ok = res.status === 403 && res.body && res.body.error
        && /model/i.test(res.body.error.message || '');
      record('11. API key model permission enforced (403)', ok,
        `status=${res.status} code=${res.body && res.body.error && res.body.error.code}`);
    }

    // ----------------------------------------------------------
    // 12. Model-based routing rule (strategy + connection allow-list)
    // ----------------------------------------------------------
    {
      const rule = {
        id: 'rule-route-model',
        model: 'route-model',
        strategy: 'round-robin',
        providerOrder: ['provA'],
        connectionIds: ['rr-a', 'rr-c'],
        enabled: true,
      };
      const created = await adminReq('POST', '/admin/api/routing/rules', rule, ADMIN_KEY);
      const listed = await adminReq('GET', '/admin/api/routing/rules', null, ADMIN_KEY);
      const allow = modelRouter.connectionAllowList('route-model');
      const ok = created.status === 201
        && listed.status === 200 && (listed.body.rules || []).some((r) => r.id === 'rule-route-model')
        && allow && allow.sort().join(',') === 'rr-a,rr-c';
      record('12. model routing rule applied (strategy + connection allow-list)', ok,
        `create=${created.status} allow=${allow && allow.join(',')}`);
    }

    // ----------------------------------------------------------
    // 13. Failover on 401 (auth failure → next provider serves)
    // ----------------------------------------------------------
    {
      await reset();
      modelRouter.setStrategy('priority');
      modelRouter.removeModelRule('rule-route-model'); // clear allow-list
      mocks.A.behaviour.failKeys = new Map([['key-provA-1', 401], ['key-provA-2', 401]]);
      const res = await chat('route-model', USER_KEY);
      const ok = res.status === 200 && mocks.B.seen.length > 0;
      record('13. failover on 401 to next eligible provider', ok,
        `status=${res.status} A_tried=${mocks.A.seen.length} B=${mocks.B.seen.length}`);
    }

    // ----------------------------------------------------------
    // 14. Failover on 429
    // ----------------------------------------------------------
    {
      await reset();
      mocks.A.behaviour.failKeys = new Map([['key-provA-1', 429], ['key-provA-2', 429]]);
      const res = await chat('route-model', USER_KEY);
      const ok = res.status === 200 && mocks.B.seen.length > 0;
      record('14. failover on 429 to next eligible provider', ok,
        `status=${res.status} A_tried=${mocks.A.seen.length} B=${mocks.B.seen.length}`);
    }

    // ----------------------------------------------------------
    // 15. Failover on 5xx
    // ----------------------------------------------------------
    {
      await reset();
      mocks.A.behaviour.mode = 'fail-all'; mocks.A.behaviour.status = 503;
      const res = await chat('route-model', USER_KEY);
      const ok = res.status === 200 && mocks.B.seen.length > 0;
      record('15. failover on 5xx to next eligible provider', ok,
        `status=${res.status} A=${mocks.A.seen.length} B=${mocks.B.seen.length}`);
    }

    // ----------------------------------------------------------
    // 16. Timeout failover
    // ----------------------------------------------------------
    {
      await reset();
      mocks.A.behaviour.mode = 'timeout';
      const res = await chat('route-model', USER_KEY);
      const ok = res.status === 200 && mocks.B.seen.length > 0;
      record('16. failover on timeout to next eligible provider', ok,
        `status=${res.status} A=${mocks.A.seen.length} B=${mocks.B.seen.length}`);
      mocks.A.behaviour.mode = 'ok';
    }

    // ----------------------------------------------------------
    // 17. Maximum retry bound (no infinite retry)
    // ----------------------------------------------------------
    {
      await reset();
      mocks.A.behaviour.mode = 'fail-all'; mocks.A.behaviour.status = 503;
      mocks.B.behaviour.mode = 'fail-all'; mocks.B.behaviour.status = 503;
      mocks.C.behaviour.mode = 'fail-all'; mocks.C.behaviour.status = 503;
      await chat('route-model', USER_KEY);
      // Each provider tried at most (maxRetries + 1) times; never loops forever.
      const maxPerProvider = requestExecutor.maxRetries + 1;
      const ok = mocks.A.seen.length <= maxPerProvider && mocks.B.seen.length <= maxPerProvider && mocks.C.seen.length <= maxPerProvider;
      record('17. retry bounded per provider (no infinite retry)', ok,
        `A=${mocks.A.seen.length} B=${mocks.B.seen.length} C=${mocks.C.seen.length} max=${maxPerProvider}`);
    }

    // ----------------------------------------------------------
    // 18. All providers failed -> real error (no fake success)
    // ----------------------------------------------------------
    {
      await reset();
      mocks.A.behaviour.mode = 'fail-all'; mocks.A.behaviour.status = 500;
      mocks.B.behaviour.mode = 'fail-all'; mocks.B.behaviour.status = 500;
      mocks.C.behaviour.mode = 'fail-all'; mocks.C.behaviour.status = 500;
      const res = await chat('route-model', USER_KEY);
      const ok = res.status >= 500 && res.body && res.body.error;
      record('18. all providers failed -> honest error to client', ok, `status=${res.status}`);
    }

    // ----------------------------------------------------------
    // 19. No eligible connection -> clear error
    // ----------------------------------------------------------
    {
      await reset();
      await adminReq('POST', '/admin/api/providers/provA/disable', null, ADMIN_KEY);
      await adminReq('POST', '/admin/api/providers/provB/disable', null, ADMIN_KEY);
      await adminReq('POST', '/admin/api/providers/provC/disable', null, ADMIN_KEY);
      const res = await chat('route-model', USER_KEY);
      const ok = (res.status === 404 || res.status === 503) && res.body && res.body.error;
      record('19. all connections disabled -> clear error (no fake success)', ok, `status=${res.status}`);
      await adminReq('POST', '/admin/api/providers/provA/enable', null, ADMIN_KEY);
      await adminReq('POST', '/admin/api/providers/provB/enable', null, ADMIN_KEY);
      await adminReq('POST', '/admin/api/providers/provC/enable', null, ADMIN_KEY);
    }

    // ----------------------------------------------------------
    // 20. Routing config persistence
    // ----------------------------------------------------------
    {
      const put = await adminReq('PUT', '/admin/api/routing', {
        strategy: 'round-robin', connectionStrategy: 'least-used', keySelectionStrategy: 'weighted',
      }, ADMIN_KEY);
      const file = JSON.parse(fs.readFileSync(process.env.ROUTING_CONFIG_FILE, 'utf-8'));
      const ok = put.status === 200 && put.body.persisted === true
        && file.strategy === 'round-robin' && file.connectionStrategy === 'least-used'
        && file.keySelectionStrategy === 'weighted'
        && modelRouter.getStrategy() === 'round-robin'
        && accountManager.defaultStrategy === 'least-used';
      record('20. routing config persisted + applied (hot reload, no restart)', ok,
        `file=${file.strategy}/${file.connectionStrategy}/${file.keySelectionStrategy}`);
    }

    // ----------------------------------------------------------
    // 21. Routing config validation (invalid strategy rejected)
    // ----------------------------------------------------------
    {
      const before = modelRouter.getStrategy();
      const bad = await adminReq('PUT', '/admin/api/routing', { strategy: 'not-a-strategy' }, ADMIN_KEY);
      const badConn = await adminReq('PUT', '/admin/api/routing', { connectionStrategy: 'bogus' }, ADMIN_KEY);
      const ok = bad.status === 400 && badConn.status === 400 && modelRouter.getStrategy() === before;
      record('21. invalid routing strategy rejected (400, state unchanged)', ok,
        `bad=${bad.status} badConn=${badConn.status} strategy=${modelRouter.getStrategy()}`);
    }

    // ----------------------------------------------------------
    // 22. Admin authorization (non-admin cannot mutate routing)
    // ----------------------------------------------------------
    {
      const r1 = await adminReq('PUT', '/admin/api/routing', { strategy: 'random' }, USER_KEY);
      const r2 = await adminReq('POST', '/admin/api/routing/rules', { id: 'unauthorized-rule', model: 'route-model', strategy: 'random' }, USER_KEY);
      const r3 = await adminReq('DELETE', '/admin/api/routing/rules/rule-route-model', undefined, USER_KEY);
      const r4 = await adminReq('GET', '/admin/api/routing/status', null, USER_KEY);
      const created = modelRouter.listModelRules().some((r) => r.id === 'unauthorized-rule');
      if (r3.status !== 403) {
        const probe = await adminReq('DELETE', '/admin/api/routing/rules/definitely-not-here', null, USER_KEY);
        console.log('   debug r3:', r3.status, JSON.stringify(r3.body).slice(0, 250), '| probe:', probe.status);
      }
      // cleanup any accidental create
      modelRouter.removeModelRule('unauthorized-rule');
      const ok = [r1, r2, r3, r4].every((r) => r.status === 403) && !created;
      record('22. non-admin cannot mutate/read routing admin API', ok,
        `statuses=${[r1, r2, r3, r4].map((r) => r.status).join(',')} ruleCreated=${created}`);
    }

    // ----------------------------------------------------------
    // 23. No credential leakage in routing endpoints
    // ----------------------------------------------------------
    {
      const endpoints = [
        await adminReq('GET', '/admin/api/routing', null, ADMIN_KEY),
        await adminReq('GET', '/admin/api/routing/status', null, ADMIN_KEY),
        await adminReq('GET', '/admin/api/routing/activity', null, ADMIN_KEY),
        await adminReq('GET', '/admin/api/routing/rules', null, ADMIN_KEY),
      ];
      const secrets = ['sk-rr-a-0001', 'sk-rr-b-0002', 'sk-rr-c-0003', ADMIN_KEY, USER_KEY, RESTRICTED_KEY,
        'key-provA-1', 'key-provA-2', 'key-provB-1', 'key-provC-1'];
      const leaked = endpoints.some((e) => secrets.some((s) => containsSecret(e.body, s)));
      record('23. no credential/API key leakage in routing endpoints', !leaked, leaked ? 'SECRET LEAKED' : 'clean');
    }

    // ----------------------------------------------------------
    // 24. Backup contains routing config + model rules (no secrets)
    // ----------------------------------------------------------
    {
      await adminReq('POST', '/admin/api/routing/rules', {
        id: 'rule-backup-check', model: 'route-model', strategy: 'weighted', enabled: true,
      }, ADMIN_KEY);
      const res = await adminReq('POST', '/admin/api/backup', {}, ADMIN_KEY);
      const d = res.body && res.body.backup && res.body.backup.data;
      const hasRouting = d && d.routing && typeof d.routing.strategy === 'string';
      const hasRules = d && Array.isArray(d.routingRules) && d.routingRules.some((r) => r.id === 'rule-backup-check');
      const leaked = containsSecret(res.body, 'sk-rr-a-0001');
      record('24. backup includes routing config + model rules, no secrets', res.status === 200 && hasRouting && hasRules && !leaked,
        `routing=${!!hasRouting} rules=${!!hasRules} leaked=${leaked}`);
      await adminReq('DELETE', '/admin/api/routing/rules/rule-backup-check', ADMIN_KEY);
    }

    // ----------------------------------------------------------
    // 25. Usage analytics compatibility (requestLog routing metadata)
    // ----------------------------------------------------------
    {
      await reset();
      // Circuit breakers may be OPEN from the earlier all-fail tests; force
      // them closed so routing deterministically picks a provider.
      for (const pid of ['provA', 'provB', 'provC']) {
        const h = healthMonitor.health && healthMonitor.health.get(pid);
        if (h) { h.state = 'closed'; h.consecutiveFailures = 0; }
      }
      const res = await chat('route-model', USER_KEY);
      const served = mocks.A.seen.length + mocks.B.seen.length + mocks.C.seen.length > 0;
      if (!(res.status === 200 && served)) {
        console.log('   debug 25 pre:', res.status, JSON.stringify(res.body).slice(0, 250), 'A=', mocks.A.seen.length, 'B=', mocks.B.seen.length, 'C=', mocks.C.seen.length);
      }
      const activity = await adminReq('GET', '/admin/api/routing/activity?limit=5', null, ADMIN_KEY);
      const entries = (activity.body && activity.body.entries) || [];
      // The latest entry must correspond to the request we just made (newest first).
      const latest = entries[0] || {};
      const ok = res.status === 200 && served && activity.status === 200
        && latest.model === 'route-model' && ['provA', 'provB', 'provC'].includes(latest.providerId)
        && typeof latest.latencyMs === 'number' && latest.status === 200
        && !latest.apiKey && !latest.key && !latest.credential;
      record('25. routing activity feeds usage analytics (no secret fields)', ok,
        `model=${latest.model} provider=${latest.providerId} latency=${latest.latencyMs}ms`);
    }
  } finally {
    await new Promise((r) => expressServer.close(r));
    await Promise.all(Object.values(mocks).map((m) => m.stop()));
    fs.rmSync(tmpProvidersDir, { recursive: true, force: true });
    fs.rmSync(tmpKeysDir, { recursive: true, force: true });
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    delete process.env.ROUTING_CONFIG_FILE;
    delete process.env.ROUTING_RULES_CONFIG_FILE;
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
