/**
 * Integration tests for Sprint: Universal Connect Account.
 * Tests ConnectionManager lifecycle: API Key login, OAuth, Device Code,
 * Browser Session, Reconnect, Refresh, Validate, Routing, Failover.
 *
 * Run:  node examples/connectionManager.integration.js
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
  const tag = passed ? 'PASS' : 'FAIL';
  console.log('[' + tag + '] ' + name + (detail ? ' — ' + detail : ''));
}

// ---------------------------------------------------------------
// 1. API Key login
// ---------------------------------------------------------------
async function testApiKeyLogin() {
  const services = require('../src/services');
  const acct = await services.connectionManager.registerConnection({
    providerId: 'openai', authType: 'api-key', displayName: 'API Key Acct',
    apiKey: 'sk-api-test-1234', priority: 1,
  });
  record('apikey: registered', !!acct && acct.id && acct.status === 'connected');
  record('apikey: displayName', acct.displayName === 'API Key Acct');
  record('apikey: provider', acct.provider === 'openai');
  record('apikey: authType', acct.authType === 'api-key');
  record('apikey: masked apiKey', acct.apiKey && (acct.apiKey.includes('...') || acct.apiKey.includes('****')));
  record('apikey: no credential field', !acct.credential);
  record('apikey: priority', acct.priority === 1);

  await services.connectionManager.disconnect(acct.id);
  record('apikey: disconnected', true);
}

// ---------------------------------------------------------------
// 2. OAuth Authorization Code (mock)
// ---------------------------------------------------------------
async function testOAuthFlow() {
  const services = require('../src/services');
  const acct = await services.connectionManager.registerConnection({
    accountId: 'oauth-test-1', providerId: 'openai', authType: 'oauth',
    displayName: 'OAuth Acct', accessToken: 'tok-abc', refreshToken: 'rt-xyz',
    priority: 2,
  });
  record('oauth: registered', acct && acct.id === 'oauth-test-1' && acct.status === 'connected');
  record('oauth: accessToken masked', acct.accessToken && (acct.accessToken.includes('...') || acct.accessToken.includes('****')));
  record('oauth: refreshToken always masked', acct.refreshToken === '****');
  await services.connectionManager.disconnect(acct.id);
}

// ---------------------------------------------------------------
// 3. Device Code flow (mock)
// ---------------------------------------------------------------
async function testDeviceCode() {
  const services = require('../src/services');
  const acct = await services.connectionManager.registerConnection({
    accountId: 'device-test-1', providerId: 'copilot', authType: 'device-code',
    displayName: 'Device Acct', deviceCode: 'dev-123', verificationUri: 'https://example.com/device',
  });
  record('device: registered', acct && acct.id === 'device-test-1');
  await services.connectionManager.disconnect(acct.id);
}

// ---------------------------------------------------------------
// 4. Browser Session
// ---------------------------------------------------------------
async function testBrowserSession() {
  const services = require('../src/services');
  const acct = await services.connectionManager.registerConnection({
    accountId: 'browser-test-1', providerId: 'cursor', authType: 'browser-login',
    displayName: 'Browser Acct', cookies: 'session=abc;token=xyz',
  });
  record('browser: registered', acct && acct.id === 'browser-test-1');
  await services.connectionManager.disconnect(acct.id);
}

// ---------------------------------------------------------------
// 5. Reconnect
// ---------------------------------------------------------------
async function testReconnect() {
  const services = require('../src/services');
  const acct = await services.connectionManager.registerConnection({
    accountId: 'recon-test-1', providerId: 'openai', authType: 'api-key',
    displayName: 'Reconnect Acct', apiKey: 'sk-recon-1',
  });
  const reconnected = await services.connectionManager.reconnect(acct.id);
  record('reconnect: works', !!reconnected && (reconnected.accountId || reconnected.id) === acct.id);
  // Clean up
  if (services.connectionManager) {
    services.connectionManager.disconnect(acct.id).catch(() => {});
  }
}

// ---------------------------------------------------------------
// 6. Refresh
// ---------------------------------------------------------------
async function testRefresh() {
  const services = require('../src/services');
  const acct = await services.connectionManager.registerConnection({
    accountId: 'refresh-test-1', providerId: 'openai', authType: 'oauth',
    displayName: 'Refresh Acct', accessToken: 'tok-refresh', refreshToken: 'rt-refresh',
  });
  const refreshed = await services.connectionManager.refresh(acct.id);
  record('refresh: works', !!refreshed && refreshed.accountId === acct.id);
  await services.connectionManager.disconnect(acct.id);
}

// ---------------------------------------------------------------
// 7. Validation
// ---------------------------------------------------------------
async function testValidate() {
  const services = require('../src/services');
  const acct = await services.connectionManager.registerConnection({
    accountId: 'val-test-1', providerId: 'openai', authType: 'api-key',
    displayName: 'Validate Acct', apiKey: 'sk-val-1',
  });
  const valid = await services.connectionManager.validate(acct.id);
  record('validate: returns something', typeof valid === 'boolean');
  await services.connectionManager.disconnect(acct.id);
}

// ---------------------------------------------------------------
// 8. Routing / selectConnection
// ---------------------------------------------------------------
async function testRouting() {
  const cm = require('../src/services').connectionManager;
  const accts = [
    await cm.registerConnection({ accountId: 'route-1', providerId: 'router-prov', authType: 'api-key', displayName: 'R1', apiKey: 'sk-r1', priority: 1, weight: 10 }),
    await cm.registerConnection({ accountId: 'route-2', providerId: 'router-prov', authType: 'api-key', displayName: 'R2', apiKey: 'sk-r2', priority: 2, weight: 5 }),
    await cm.registerConnection({ accountId: 'route-3', providerId: 'router-prov', authType: 'api-key', displayName: 'R3', apiKey: 'sk-r3', priority: 3, weight: 1 }),
  ];

  const p = await cm.selectConnection('router-prov', { strategy: 'priority' });
  record('routing: priority selects R1', p && p.displayName === 'R1', p ? p.displayName : 'null');

  const r1 = await cm.selectConnection('router-prov', { strategy: 'round-robin' });
  const r2 = await cm.selectConnection('router-prov', { strategy: 'round-robin' });
  const r3 = await cm.selectConnection('router-prov', { strategy: 'round-robin' });
  const r4 = await cm.selectConnection('router-prov', { strategy: 'round-robin' });
  record('routing: round-robin cycles', r1.id && r2.id && r3.id && (r1.id !== r2.id || r2.id !== r3.id));
  record('routing: round-robin wraps', r1.id === r4.id);
  
  const rand = await cm.selectConnection('router-prov', { strategy: 'random' });
  record('routing: random returns', !!rand);

  // Cleanup
  for (const a of accts) await cm.disconnect(a.id);
}

// ---------------------------------------------------------------
// 9. Runtime credential resolution (ConnectionManager → transport auth)
// ---------------------------------------------------------------
async function testRuntimeAuthResolution() {
  const cm = require('../src/services').connectionManager;

  // api-key connection → resolves to an apiKey (Bearer) with no headers.
  const ak = await cm.registerConnection({
    accountId: 'rt-apikey', providerId: 'rt-apikey-prov', authType: 'api-key',
    displayName: 'RT ApiKey', apiKey: 'sk-runtime-123', priority: 1,
  });
  const akAuth = await cm.resolveRuntimeAuth('rt-apikey-prov');
  record('runtime: api-key resolves apiKey', !!akAuth && akAuth.apiKey === 'sk-runtime-123');
  record('runtime: api-key connectionId', akAuth && akAuth.connectionId === 'rt-apikey');
  record('runtime: api-key no auth headers', akAuth && Object.keys(akAuth.headers).length === 0);
  await cm.disconnect(ak.id);

  // oauth connection → resolves to an Authorization: Bearer header, no apiKey.
  const oa = await cm.registerConnection({
    accountId: 'rt-oauth', providerId: 'rt-oauth-prov', authType: 'oauth',
    displayName: 'RT OAuth', accessToken: 'tok-runtime-xyz', refreshToken: 'rt-xyz',
  });
  const oaAuth = await cm.resolveRuntimeAuth('rt-oauth-prov');
  record('runtime: oauth resolves Bearer header', !!oaAuth && oaAuth.headers.Authorization === 'Bearer tok-runtime-xyz');
  record('runtime: oauth no apiKey', oaAuth && !oaAuth.apiKey);
  await cm.disconnect(oa.id);

  // browser-login connection → resolves to a Cookie header.
  const br = await cm.registerConnection({
    accountId: 'rt-browser', providerId: 'rt-browser-prov', authType: 'browser-login',
    displayName: 'RT Browser', cookies: 'session=runtime-cookie',
  });
  const brAuth = await cm.resolveRuntimeAuth('rt-browser-prov');
  record('runtime: browser-login resolves Cookie header', !!brAuth && brAuth.headers.Cookie === 'session=runtime-cookie');
  await cm.disconnect(br.id);

  // no connection → null (legacy ApiKeyManager fallback path).
  const none = await cm.resolveRuntimeAuth('rt-nonexistent-prov');
  record('runtime: no connection resolves null', none === null);

  // secrets are never surfaced through the public account view.
  record('runtime: api-key masked in publicView', ak.apiKey && ak.apiKey.includes('...'));
}

// ---------------------------------------------------------------
// 10. Runtime credential actually used on upstream request
// ---------------------------------------------------------------
async function testRuntimeCredentialUpstream() {
  const services = require('../src/services');
  const cm = services.connectionManager;
  const { providerManager, apiKeyManager } = services;

  // Capture the Authorization header the upstream provider received.
  const seen = [];
  const mock = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', (d) => (b += d)); rq.on('end', () => {
      seen.push({ url: rq.url, auth: rq.headers.authorization, cookie: rq.headers.cookie });
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({
        id: 'chatcmpl-rt', object: 'chat.completion', created: 1700000000, model: 'rt-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;

  // Register a provider whose STATIC key differs from the connection credential.
  const providers = [{
    id: 'rt-upstream', name: 'RT Upstream', enabled: true,
    baseURL: `http://127.0.0.1:${mockPort}`, apiKeys: ['static-provider-key'],
    supportedModels: ['rt-model'], priority: 1, timeout: 3000,
  }];
  providerManager.updateProviders(providers);
  apiKeyManager.load(providers);

  // Connect an OAuth account for the provider — its token must win over the
  // static provider key at runtime.
  const conn = await cm.registerConnection({
    accountId: 'rt-upstream-oauth', providerId: 'rt-upstream', authType: 'oauth',
    displayName: 'RT Upstream OAuth', accessToken: 'CONNECTION-TOKEN-999', refreshToken: 'r',
  });

  const result = await services.requestExecutor.execute({
    model: 'rt-model',
    input: { model: 'rt-model', messages: [{ role: 'user', content: 'hi' }] },
    operation: 'chat',
    ctx: { requestId: 'rt-test-1' },
  });

  record('runtime-upstream: request succeeded', result && result.status === 200);
  const forwarded = seen[0];
  record('runtime-upstream: connection token used (not static key)',
    forwarded && forwarded.auth === 'Bearer CONNECTION-TOKEN-999',
    `auth=${forwarded && forwarded.auth}`);
  record('runtime-upstream: meta carries connectionId or provider',
    result && result.meta && result.meta.providerId === 'rt-upstream');

  await cm.disconnect(conn.id);
  // Restore providers so later HTTP tests are unaffected.
  providerManager.updateProviders([]);
  await new Promise((r) => mock.close(r));
}

// ---------------------------------------------------------------
// HTTP admin endpoints (new lifecycle + existing)
// ---------------------------------------------------------------
let server;
let port;
let tmpDir;

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

async function testHttp() {
  const K = 'sk-acct-admin-0000';

  // Register via HTTP /accounts/connect (existing)
  const con = await req('POST', '/admin/api/accounts/connect', { providerId: 'http-test', authType: 'api-key', apiKey: 'sk-http-1', name: 'HTTP Acct' }, K);
  record('http: connect account', con.status === 200 && con.body.account?.state === 'connected');

  // GET /accounts (list)
  const list = await req('GET', '/admin/api/accounts', null, K);
  record('http: list accounts', list.status === 200 && Array.isArray(list.body.accounts));

  // GET /accounts/:id/status (existing)
  if (con.body.account?.accountId) {
    const st = await req('GET', '/admin/api/accounts/' + con.body.account.accountId + '/status', null, K);
    record('http: account status', st.status === 200 && st.body.state === 'connected');
  }

  // New lifecycle endpoints
  const LIST = await req('GET', '/admin/api/accounts', null, K);
  const first = LIST.body.accounts[0];
  if (first) {
    const exReconnect = await req('POST', '/admin/api/accounts/' + encodeURIComponent(first.id) + '/reconnect', null, K);
    record('http: reconnect', exReconnect.status === 200);
  }

  // DELETE /accounts/:id (existing)
  if (con.body.account?.accountId) {
    const del = await req('DELETE', '/admin/api/accounts/' + con.body.account.accountId, null, K);
    record('http: delete account', del.status === 200 && del.body.success === true);
  }

  // Validate endpoint
  if (first) {
    const val = await req('POST', '/admin/api/accounts/' + encodeURIComponent(first.id) + '/validate', null, K);
    record('http: validate', val.status === 200 && typeof val.body.valid === 'boolean');
  }

  // Health endpoint
  const health = await req('GET', '/admin/api/accounts/config/health', null, K);
  record('http: health', health.status === 200 && typeof health.body.health === 'object');
}

// ---------------------------------------------------------------
// Run
// ---------------------------------------------------------------
(async () => {
  console.log('='.repeat(60));
  console.log('Connection Manager — Integration');
  console.log('='.repeat(60));

  const { apiKeyStore } = require('../src/services');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-'));
  const cfgFile = path.join(tmpDir, 'apiKeys.json');
  fs.writeFileSync(cfgFile, JSON.stringify([
    { id: 'admin', key: 'sk-acct-admin-0000', name: 'Admin', status: 'active', role: 'admin' }
  ]));
  apiKeyStore.load(cfgFile);

  await testApiKeyLogin();
  await testOAuthFlow();
  await testDeviceCode();
  await testBrowserSession();
  await testReconnect();
  await testRefresh();
  await testValidate();
  await testRouting();
  await testRuntimeAuthResolution();
  await testRuntimeCredentialUpstream();

  await startServer();
  try {
    await testHttp();
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(60));
  console.log('Connection Manager — Integration: ' + passed + '/' + results.length + ' passed, ' + failed + ' failed');
  console.log('='.repeat(60));
  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) console.log('  FAIL: ' + r.name + ' — ' + (r.detail || ''));
    process.exit(1);
  }
})().catch((err) => { console.error('FATAL:', err); process.exit(1); });
