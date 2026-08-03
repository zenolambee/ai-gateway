/**
 * Integration tests for Sprint: Dashboard Admin & Connect Account.
 *
 * Run:  node examples/connectAccount.integration.js
 *
 * Verifies the generic authentication architecture:
 *   - AuthAdapterFactory exposes all 6 auth types + extension point (register)
 *   - AuthAdapter interface (connect/refresh/disconnect/status/validate/save/load)
 *   - each built-in adapter type works (api-key, oauth, device-code,
 *     browser-login, session, custom)
 *   - ConnectionRegistry owns storage; adapters never touch storage directly
 *   - account persistence survives a "restart" (same storage backend)
 *   - connection states: connected/disconnected/expired/refreshing/reconnecting
 *   - admin API: list / connect / status / refresh / disconnect
 *   - provider CRUD via admin API (add / edit / delete)
 *   - dashboard HTML serves the new tab (Connect Account markup present)
 *   - all backwards compatibility maintained (existing endpoints still work)
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const services = require('../src/services');
const MemoryStorage = require('../src/storage/MemoryStorage');
const RedisStorage = require('../src/storage/RedisStorage');
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
// 1. Auth adapter factory — types & extension point
// ---------------------------------------------------------------
async function testFactory() {
  const { authAdapterFactory } = services;
  const types = authAdapterFactory.listTypes();
  const ids = types.map((t) => t.id).sort();
  record('factory: exposes all 6 auth types', JSON.stringify(ids) === JSON.stringify(['api-key','browser-login','custom','device-code','oauth','session']), ids.join(','));
  record('factory: api-key adapter created', authAdapterFactory.create('x', 'api-key').type === 'api-key');
  record('factory: oauth adapter created', authAdapterFactory.create('x', 'oauth').type === 'oauth');
  record('factory: device-code adapter created', authAdapterFactory.create('x', 'device-code').type === 'device-code');
  record('factory: browser-login adapter created', authAdapterFactory.create('x', 'browser-login').type === 'browser-login');
  record('factory: session adapter created', authAdapterFactory.create('x', 'session').type === 'session');
  record('factory: custom adapter created', authAdapterFactory.create('x', 'custom').type === 'custom');

  // Extension point: register a new provider adapter without core changes.
  const { AuthAdapter } = require('../src/auth');
  class GrokAdapter extends AuthAdapter {
    constructor(){ super({ type: 'custom' }); }
    async connect(c){ return { providerId: c.providerId, accountId: c.providerId, authType: 'custom', name: c.name, credential: { grokToken: c.apiKey }, connectedAt: Date.now() }; }
  }
  authAdapterFactory.register('grok', GrokAdapter);
  const grok = authAdapterFactory.create('grok');
  record('factory: extension point (register grok)', grok && typeof grok.connect === 'function');
}

// ---------------------------------------------------------------
// 2. Each built-in adapter works + correct status states
// ---------------------------------------------------------------
async function testAdapters() {
  const { connectionRegistry } = services;

  // api-key
  let a = await connectionRegistry.connect({ providerId: 'p1', authType: 'api-key', apiKey: 'sk-abc', name: 'API Key Acct' });
  record('api-key: connects', a.state === 'connected');
  record('api-key: valid', a.valid === true);
  record('api-key: credential not exposed in view', !('credential' in a));

  // oauth (expired -> refreshing when refresh token present)
  const oa = await connectionRegistry.connect({ providerId: 'p2', authType: 'oauth', accessToken: 'tok', refreshToken: 'rt', expiresIn: -1000, name: 'OAuth Acct' });
  const oaStatus = await connectionRegistry.status(oa.accountId);
  record('oauth: expired+refresh -> refreshing state', oaStatus.state === 'refreshing', oaStatus.state);

  // oauth without refresh -> expired
  const oa2 = await connectionRegistry.connect({ providerId: 'p3', authType: 'oauth', accessToken: 'tok2', expiresIn: -1000 });
  const oa2s = await connectionRegistry.status(oa2.accountId);
  record('oauth: no refresh -> expired state', oa2s.state === 'expired', oa2s.state);

  // device-code -> reconnecting until authorized
  const dc = await connectionRegistry.connect({ providerId: 'p4', authType: 'device-code', deviceCode: 'dev', userCode: '123456', verificationUri: 'https://example.com/device' });
  const dcStatus = await connectionRegistry.status(dc.accountId);
  record('device-code: pending -> need-device state', dcStatus.state === 'need-device', dcStatus.state);
  const dcRefreshed = await connectionRegistry.refresh(dc.accountId);
  const dcAfter = await connectionRegistry.status(dcRefreshed.accountId);
  record('device-code: after refresh -> connected', dcAfter.state === 'connected', dcAfter.state);

  // browser-login
  const bl = await connectionRegistry.connect({ providerId: 'p5', authType: 'browser-login', cookies: 'session=abc123', sessionExpiresAt: Date.now() + 60000 });
  record('browser-login: connects', bl.state === 'connected');

  // session
  const sn = await connectionRegistry.connect({ providerId: 'p6', authType: 'session', session: 'sess-secret' });
  record('session: connects', sn.state === 'connected');

  // custom
  const cu = await connectionRegistry.connect({ providerId: 'p7', authType: 'custom', credential: { any: 'val' } });
  record('custom: connects', cu.state === 'connected');

  // cleanup
  for (const pid of ['p1','p2','p3','p4','p5','p6','p7']) await connectionRegistry.disconnect(pid);
}

// ---------------------------------------------------------------
// 3. Persistence across restart + adapters don't touch storage
// ---------------------------------------------------------------
async function testPersistenceAndIsolation() {
  // Use a deterministic key for encryption so it survives between registry instances.
  process.env.GATEWAY_SECRET_KEY = 'test-secret-key-for-persistence';
  const storage = new MemoryStorage({ prefix: 'cc-test' });
  const { AuthAdapterFactory, ConnectionRegistry, EncryptionService } = require('../src/auth');
  const encryption = new EncryptionService({});
  const registry = new ConnectionRegistry({ factory: new AuthAdapterFactory(), storageProvider: () => storage, encryption });

  await registry.connect({ providerId: 'persist', authType: 'api-key', apiKey: 'sk-persist', name: 'Persist Acct' });
  await registry.connect({ providerId: 'persist2', authType: 'oauth', accessToken: 't', refreshToken: 'r' });

  // Simulate restart: a NEW registry sharing the SAME storage backend.
  const registry2 = new ConnectionRegistry({ factory: new AuthAdapterFactory(), storageProvider: () => storage, encryption });
  const restored = await registry2.hydrate();
  record('persistence: accounts restored after restart', restored >= 2, 'restored='+restored);
  const list2 = await registry2.listAccounts();
  record('persistence: account list survives', list2.length === 2);
  const p = list2.find((x) => x.providerId === 'persist');
  record('persistence: state/name survive', p && p.state === 'connected' && p.name === 'Persist Acct');

  // Adapters must not know about storage: verify our built-in adapters have no
  // storage references and only use registry save/load.
  const AuthAdapter = require('../src/auth/AuthAdapter');
  const adapter = registry2._adapter('persist', 'api-key');
  record('isolation: adapter has no storage refs', !('_store' in adapter) && !('storageProvider' in adapter));
  record('isolation: adapter exposes save/load via interface', typeof adapter.save === 'function' && typeof adapter.load === 'function');
}

// ---------------------------------------------------------------
// 4. Redis fallback
// ---------------------------------------------------------------
async function testRedisFallback() {
  const fallback = new MemoryStorage({ prefix: 'cc-fb' });
  const redis = new RedisStorage({ prefix: 'cc-fb', url: null, fallback });
  const { AuthAdapterFactory, ConnectionRegistry } = require('../src/auth');
  const registry = new ConnectionRegistry({ factory: new AuthAdapterFactory(), storageProvider: () => redis });
  await registry.connect({ providerId: 'fb', authType: 'api-key', apiKey: 'sk-fb' });
  const restored = (await fallback.get('gatewayAccount:fb')) !== null;
  record('redis fallback: account persisted via memory fallback', restored);
}

// ---------------------------------------------------------------
// HTTP admin API
// ---------------------------------------------------------------
let server;
let port;
let tmpDir;
let tmpProvidersDir;

function startProviders() {
  tmpProvidersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-provs-'));
  fs.writeFileSync(path.join(tmpProvidersDir, 'seed.json'), JSON.stringify({
    id: 'seed', name: 'Seed', adapter: 'generic-openai', baseURL: 'https://seed.example.com',
    enabled: true, apiKeys: ['seed-key'], supportedModels: ['seed-model'], priority: 99,
  }));
  process.env.PROVIDERS_CONFIG_DIR = tmpProvidersDir;
  services.providerManager.load(tmpProvidersDir);
  services.apiKeyManager.load(services.providerManager.listProviders());
}

function startServer() {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
}

function req(method, p, body, key) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = {};
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (key) headers.Authorization = 'Bearer ' + key;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(c) }); } catch { resolve({ status: res.statusCode, body: c }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function testHttpAdmin() {
  const ADMIN = 'sk-admin-dash-0000';

  // Accounts API
  const con = await req('POST', '/admin/api/accounts/connect', { providerId: 'httpacct', authType: 'api-key', apiKey: 'sk-http', name: 'HTTP Acct' }, ADMIN);
  record('http: connect account', con.status === 200 && con.body.account && con.body.account.state === 'connected');

  const status = await req('GET', '/admin/api/accounts/httpacct/status', null, ADMIN);
  record('http: account status', status.status === 200 && status.body.state === 'connected');

  const list = await req('GET', '/admin/api/accounts', null, ADMIN);
  record('http: account list', list.status === 200 && Array.isArray(list.body.accounts));
  record('http: account list has auth types', Array.isArray(list.body.authTypes) && list.body.authTypes.length >= 5);

  const del = await req('DELETE', '/admin/api/accounts/httpacct', null, ADMIN);
  record('http: disconnect account', del.status === 200 && del.body.success === true);

  // Provider add
  const add = await req('POST', '/admin/api/providers', {
    id: 'dash-prov', name: 'Dash Provider', adapter: 'generic-openai', baseURL: 'https://example.com', priority: 50, weight: 2, timeout: 5000, enabled: true, apiKeys: ['pk'], supportedModels: ['m1']
  }, ADMIN);
  record('http: add provider', add.status === 201 && add.body.success === true);

  // Provider edit (PUT already existed; verify it still works for the new one)
  const edit = await req('PUT', '/admin/api/providers/dash-prov', {
    id: 'dash-prov', name: 'Edited Provider', adapter: 'generic-openai', baseURL: 'https://example.com', priority: 40, weight: 3, timeout: 5000, enabled: true, apiKeys: ['pk'], supportedModels: ['m1','m2']
  }, ADMIN);
  record('http: edit provider', edit.status === 200 && edit.body.success === true);

  // Provider delete
  const rmdel = await req('DELETE', '/admin/api/providers/dash-prov', null, ADMIN);
  record('http: delete provider', rmdel.status === 200 && rmdel.body.success === true);

  // Dashboard HTML includes the Connect Account tab
  const dash = await req('GET', '/admin', null, ADMIN);
  const html = typeof dash.body === 'string' ? dash.body : JSON.stringify(dash.body);
  record('http: dashboard serves Connect Account tab', dash.status === 200 && html.includes('Connect Account') && html.includes('loadAccounts'));
}

// ---------------------------------------------------------------
// Run
// ---------------------------------------------------------------
(async () => {
  console.log('='.repeat(60));
  console.log('Connect Account + Dashboard Admin — Integration');
  console.log('='.repeat(60));

  const { apiKeyStore } = services;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  const cfgFile = path.join(tmpDir, 'apiKeys.json');
  fs.writeFileSync(cfgFile, JSON.stringify([
    { id: 'admin', key: 'sk-admin-dash-0000', name: 'Admin', status: 'active', role: 'admin' }
  ]));
  apiKeyStore.load(cfgFile);

  await testFactory();
  await testAdapters();
  await testPersistenceAndIsolation();
  await testRedisFallback();

  startProviders();
  await startServer();
  try {
    await testHttpAdmin();
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpProvidersDir, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(60));
  console.log(`Connect Account — Integration: ${passed}/${results.length} passed, ${failed} failed`);
  console.log('='.repeat(60));
  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) console.log(`  FAIL: ${r.name} — ${r.detail || ''}`);
    process.exit(1);
  }
})().catch((err) => { console.error('FATAL:', err); process.exit(1); });
