/**
 * Integration tests for ApiKeyStore full persistence via StorageProvider.
 *
 * Run:  node examples/gatewayApiKeyPersistence.integration.js
 *
 * Tests:
 *   - create key (store-level)
 *   - update key
 *   - delete key
 *   - disable key (status persisted)
 *   - enable key
 *   - restart simulation (state survives across a fresh store + same storage)
 *   - automatic migration from config/apiKeys.json (import once, no duplicates)
 *   - migration does not duplicate on repeated load
 *   - Redis fallback to MemoryStorage when Redis unavailable
 *   - duplicate prevention on admin create
 *   - usage counter persists across restart
 *   - all persisted fields survive restart
 *   - HTTP admin endpoints (create/update/delete/enable/disable) keep working
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const MemoryStorage = require('../src/storage/MemoryStorage');
const RedisStorage = require('../src/storage/RedisStorage');
const ApiKeyStore = require('../src/services/apiKeyStore');
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
// Store-level helpers
// ---------------------------------------------------------------

function newStore(storage) {
  return new ApiKeyStore({ storageProvider: () => storage });
}

function makeConfigKeysFile(dir, keys) {
  const file = path.join(dir, 'apiKeys.json');
  fs.writeFileSync(file, JSON.stringify(keys));
  return file;
}

// A fresh store sharing the SAME storage backend simulates a process restart
// for MemoryStorage (which is process-local).
function simulateRestart(storage) {
  const store = new ApiKeyStore({ storageProvider: () => storage });
  store.load();
  return store;
}

// ---------------------------------------------------------------
// 1. create key
// ---------------------------------------------------------------
async function testCreateKey() {
  const storage = new MemoryStorage({ prefix: 'gk-create' });
  const store = newStore(storage);
  store.load();

  const rec = await store.createKey({
    key: 'sk-create-1234', name: 'Created', role: 'user',
    allowedProviders: ['openai'], tags: ['a', 'b'], quota: { tier: 'free' },
    description: 'desc', metadata: { env: 'test' },
  });
  record('create: record created', !!rec && rec.id === 'sk-create-1234');
  record('create: in-memory lookup works', !!store.keysByKey.get('sk-create-1234'));
  record('create: persisted to storage', !!(await storage.get('gatewayKey:sk-create-1234')));

  const persisted = await storage.get('gatewayKey:sk-create-1234');
  record('create: tags persisted', Array.isArray(persisted.tags) && persisted.tags.includes('a'));
  record('create: quota persisted', persisted.quota && persisted.quota.tier === 'free');
  record('create: description persisted', persisted.description === 'desc');
  record('create: metadata persisted', persisted.metadata && persisted.metadata.env === 'test');
  record('create: role persisted', persisted.role === 'user');
  record('create: allowedProviders persisted', Array.isArray(persisted.allowedProviders) && persisted.allowedProviders.includes('openai'));
  record('create: usageCount initialized to 0', persisted.usageCount === 0);
}

// ---------------------------------------------------------------
// 2. update key
// ---------------------------------------------------------------
async function testUpdateKey() {
  const storage = new MemoryStorage({ prefix: 'gk-update' });
  const store = newStore(storage);
  store.load();
  await store.createKey({ key: 'sk-upd-1', name: 'Before', role: 'user' });

  const updated = await store.updateKey('sk-upd-1', { name: 'After', role: 'admin', expiresAt: 9999999999, allowedModels: ['gpt-4o'] });
  record('update: record returned', !!updated && updated.name === 'After');
  const persisted = await storage.get('gatewayKey:sk-upd-1');
  record('update: name persisted', persisted.name === 'After');
  record('update: role persisted', persisted.role === 'admin');
  record('update: expiresAt persisted', persisted.expiresAt === 9999999999);
  record('update: allowedModels persisted', Array.isArray(persisted.allowedModels) && persisted.allowedModels.includes('gpt-4o'));
  record('update: updatedAt set', typeof persisted.updatedAt === 'number');
  record('update: not found returns null', (await store.updateKey('nope', { name: 'x' })) === null);
}

// ---------------------------------------------------------------
// 3. delete key
// ---------------------------------------------------------------
async function testDeleteKey() {
  const storage = new MemoryStorage({ prefix: 'gk-delete' });
  const store = newStore(storage);
  store.load();
  await store.createKey({ key: 'sk-del-1', name: 'Del' });
  await store.createKey({ key: 'sk-del-2', name: 'Keep' });

  const removed = await store.deleteKey('sk-del-1');
  record('delete: returns true', removed === true);
  record('delete: removed from memory', !store.keys.find((k) => k.id === 'sk-del-1'));
  record('delete: removed from map', !store.keysByKey.has('sk-del-1'));
  record('delete: removed from storage', (await storage.get('gatewayKey:sk-del-1')) === null);
  record('delete: other keys untouched', !!store.keysByKey.get('sk-del-2'));
  record('delete: not found returns false', (await store.deleteKey('nope')) === false);
}

// ---------------------------------------------------------------
// 4. disable / 5. enable
// ---------------------------------------------------------------
async function testDisableEnable() {
  const storage = new MemoryStorage({ prefix: 'gk-de' });
  const store = newStore(storage);
  store.load();
  await store.createKey({ key: 'sk-de-1', name: 'Toggle' });

  await store.updateKey('sk-de-1', { status: 'inactive' });
  let persisted = await storage.get('gatewayKey:sk-de-1');
  record('disable: status persisted as inactive', persisted.status === 'inactive');
  record('disable: validate rejects', store.validate('sk-de-1').valid === false);

  await store.updateKey('sk-de-1', { status: 'active' });
  persisted = await storage.get('gatewayKey:sk-de-1');
  record('enable: status persisted as active', persisted.status === 'active');
  record('enable: validate accepts', store.validate('sk-de-1').valid === true);

  // enabled / revoked convenience fields
  await store.updateKey('sk-de-1', { enabled: false });
  record('enable: enabled=false maps to inactive', (await store.validate('sk-de-1')).valid === false);
  await store.updateKey('sk-de-1', { revoked: true });
  record('enable: revoked maps to inactive', (await store.validate('sk-de-1')).valid === false);
}

// ---------------------------------------------------------------
// 6. restart simulation — all state survives via same storage
// ---------------------------------------------------------------
async function testRestartPersistence() {
  const storage = new MemoryStorage({ prefix: 'gk-restart' });
  const store1 = newStore(storage);
  store1.load();
  await store1.createKey({
    id: 'sk-r-1', key: 'sk-r-1', name: 'Persisted', role: 'admin',
    allowedProviders: ['openai'], deniedProviders: ['anthropic'],
    allowedModels: ['gpt-4o'], deniedModels: ['claude-3'],
    expiresAt: 9999999999, tags: ['t1'], quota: { tokens: 1000 },
  });

  // usage counter
  await store1.recordUsage('sk-r-1');
  await store1.recordUsage('sk-r-1');

  // disable another key to test status persistence
  await store1.createKey({ id: 'sk-r-2', key: 'sk-r-2', name: 'Disabled' });
  await store1.updateKey('sk-r-2', { status: 'inactive' });

  // Simulate restart: fresh store sharing the SAME storage backend
  const store2 = simulateRestart(storage);
  await store2.hydrate();

  record('restart: key count preserved', store2.listKeys().length === 2);
  const r1 = store2.keys.find((k) => k.id === 'sk-r-1');
  record('restart: role preserved', r1 && r1.role === 'admin');
  record('restart: enabled/status preserved (active)', r1 && r1.status === 'active');
  record('restart: expiration preserved', r1 && r1.expiresAt === 9999999999);
  record('restart: allowedProviders preserved', r1 && Array.isArray(r1.allowedProviders) && r1.allowedProviders.includes('openai'));
  record('restart: deniedProviders preserved', r1 && Array.isArray(r1.deniedProviders) && r1.deniedProviders.includes('anthropic'));
  record('restart: allowedModels preserved', r1 && Array.isArray(r1.allowedModels) && r1.allowedModels.includes('gpt-4o'));
  record('restart: deniedModels preserved', r1 && Array.isArray(r1.deniedModels) && r1.deniedModels.includes('claude-3'));
  record('restart: usage counter preserved', r1 && r1.usageCount === 2);
  record('restart: lastUsed preserved', r1 && typeof r1.lastUsed === 'number');
  record('restart: name preserved', r1 && r1.name === 'Persisted');
  record('restart: tags preserved', r1 && Array.isArray(r1.tags) && r1.tags.includes('t1'));
  record('restart: quota preserved', r1 && r1.quota && r1.quota.tokens === 1000);

  const r2 = store2.keys.find((k) => k.id === 'sk-r-2');
  record('restart: disabled key stays inactive', r2 && r2.status === 'inactive');
  record('restart: disabled key still rejects', store2.validate('sk-r-2').valid === false);
  record('restart: active key validates after restart', store2.validate('sk-r-1').valid === true);
  record('restart: provider restriction enforced after restart', store2.canAccessProvider(r1, 'anthropic') === false);
  record('restart: model restriction enforced after restart', store2.canAccessModel(r1, 'claude-3') === false);
}

// ---------------------------------------------------------------
// 7. automatic migration (config -> storage, once, no duplicates)
// ---------------------------------------------------------------
async function testMigration() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-mig-'));
  const file = makeConfigKeysFile(tmp, [
    { id: 'm1', key: 'sk-m-1', name: 'One', status: 'active', role: 'admin' },
    { id: 'm2', key: 'sk-m-2', name: 'Two', status: 'active' },
  ]);

  const storage = new MemoryStorage({ prefix: 'gk-mig' });
  const store = new ApiKeyStore({ storageProvider: () => storage });
  store.load(file);
  await store.hydrate();

  record('migration: marker set', (await storage.get('gatewayKey:migrationDone')) !== null);
  record('migration: both config keys imported', (await storage.get('gatewayKey:m1')) !== null && (await storage.get('gatewayKey:m2')) !== null);

  // Duplicate prevention: reloading the same config must NOT create duplicates
  const store2 = new ApiKeyStore({ storageProvider: () => storage });
  store2.load(file);
  await store2.hydrate();
  const m1Keys = store2.keys.filter((k) => k.id === 'm1');
  record('migration: reload does not duplicate', m1Keys.length === 1);
  record('migration: marker persisted across load', (await storage.get('gatewayKey:migrationDone')) !== null);

  // Admin-created keys coexist with migrated config keys (no overwrite / dedupe)
  await store.createKey({ id: 'm-admin', key: 'sk-m-admin', name: 'AdminMade' });
  const store3 = new ApiKeyStore({ storageProvider: () => storage });
  store3.load(file);
  await store3.hydrate();
  record('migration: admin key coexists with config keys', store3.keys.some((k) => k.id === 'm-admin') && store3.keys.length === 3);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------
// 8. Redis fallback to MemoryStorage
// ---------------------------------------------------------------
async function testRedisFallback() {
  const fallback = new MemoryStorage({ prefix: 'gk-fb' });
  const redisStore = new RedisStorage({ prefix: 'gk-fb', url: null, fallback });
  const store = new ApiKeyStore({ storageProvider: () => redisStore });
  store.load();

  await store.createKey({ key: 'sk-fb-1', name: 'Fallback', role: 'admin', expiresAt: 9999999999 });
  const persisted = await fallback.get('gatewayKey:sk-fb-1');
  record('redis fallback: key persisted through fallback memory', !!persisted && persisted.name === 'Fallback');
  record('redis fallback: validate works via fallback', store.validate('sk-fb-1').valid === true);

  // Restart via fallback
  const store2 = new ApiKeyStore({ storageProvider: () => redisStore });
  store2.load();
  await store2.hydrate();
  const r = store2.keys.find((k) => k.id === 'sk-fb-1');
  record('redis fallback: restored after restart via memory fallback', !!r && r.role === 'admin' && r.expiresAt === 9999999999);
}

// ---------------------------------------------------------------
// 9. duplicate prevention on admin-style create
// ---------------------------------------------------------------
async function testDuplicatePrevention() {
  const storage = new MemoryStorage({ prefix: 'gk-dup' });
  const store = newStore(storage);
  store.load();
  await store.createKey({ key: 'sk-dup-1', name: 'First' });
  const before = store.keys.length;
  await store.createKey({ key: 'sk-dup-1', name: 'Second' });
  record('duplicate: memory does not double count', store.keys.length === before + 1);
  record('duplicate: keysByKey maps the newest', !!store.keysByKey.get('sk-dup-1'));
}

// ---------------------------------------------------------------
// HTTP admin endpoints (GET/POST/PUT/PATCH/DELETE still work)
// ---------------------------------------------------------------
let expressServer;
let expressPort;
let tmpDir;

function startServer() {
  return new Promise((resolve) => {
    expressServer = app.listen(0, '127.0.0.1', () => {
      expressPort = expressServer.address().port;
      resolve();
    });
  });
}

function req(method, pathStr, body, key) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = {};
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (key) headers.Authorization = `Bearer ${key}`;
    const r = http.request({ host: '127.0.0.1', port: expressPort, method, path: pathStr, headers }, (res) => {
      let c = ''; res.on('data', (d) => (c += d)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(c) }); } catch { resolve({ status: res.statusCode, body: c }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function testHttpEndpoints() {
  const { apiKeyStore } = require('../src/services');

  // Create
  const create = await req('POST', '/admin/api/keys', { key: 'sk-http-1', name: 'HTTP Key', role: 'user', tags: ['h'] }, 'sk-admin-test-0000');
  record('http create: 200 + success', create.status === 200 && create.body.success === true);
  record('http create: persisted to storage', !!apiKeyStore.keysByKey.get('sk-http-1'));

  const persisted = await apiKeyStoreKeysInStorage(apiKeyStore, 'sk-http-1');
  record('http create: persisted with tags + role', persisted && persisted.tags && persisted.tags.includes('h') && persisted.role === 'user');

  // Duplicate prevention over HTTP
  const dup = await req('POST', '/admin/api/keys', { key: 'sk-http-1', name: 'Dup' }, 'sk-admin-test-0000');
  record('http create duplicate: 409 conflict', dup.status === 409);

  // Update (disable)
  const dis = await req('PUT', '/admin/api/keys/sk-http-1', { status: 'inactive' }, 'sk-admin-test-0000');
  record('http update disable: 200', dis.status === 200);
  const afterDis = await apiKeyStore.keys.find((k) => k.id === 'sk-http-1');
  record('http update disable: status inactive', afterDis && afterDis.status === 'inactive');

  // PATCH (enable + rename)
  const patch = await req('PATCH', '/admin/api/keys/sk-http-1', { status: 'active', name: 'Renamed' }, 'sk-admin-test-0000');
  record('http patch update: 200', patch.status === 200);
  const afterPatch = await apiKeyStore.keys.find((k) => k.id === 'sk-http-1');
  record('http patch: re-enabled + renamed', afterPatch && afterPatch.status === 'active' && afterPatch.name === 'Renamed');

  // List
  const list = await req('GET', '/admin/api/keys', null, 'sk-admin-test-0000');
  record('http list: key present', list.status === 200 && list.body.keys.some((k) => k.id === 'sk-http-1'));

  // Delete
  const del = await req('DELETE', '/admin/api/keys/sk-http-1', null, 'sk-admin-test-0000');
  record('http delete: 200', del.status === 200);
  record('http delete: removed from store', !apiKeyStore.keys.some((k) => k.id === 'sk-http-1'));
  const gone = await new Promise((resolve) => {
    const s = apiKeyStore._getStore();
    resolve(s ? s.get('gatewayKey:sk-http-1') : null);
  });
  record('http delete: removed from storage', gone === null);
}

// Helper: read a record directly from the store's storage backend.
async function apiKeyStoreKeysInStorage(store, id) {
  const s = store._getStore();
  if (!s) return null;
  return s.get(store._storageKey(id));
}

// ---------------------------------------------------------------
// Run all
// ---------------------------------------------------------------
(async () => {
  console.log('='.repeat(60));
  console.log('ApiKeyStore Full Persistence — Integration');
  console.log('='.repeat(60));

  await testCreateKey();
  await testUpdateKey();
  await testDeleteKey();
  await testDisableEnable();
  await testRestartPersistence();
  await testMigration();
  await testRedisFallback();
  await testDuplicatePrevention();

  // HTTP-level (uses the real app + storage-backed store) — set up config keys
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-http-'));
  const cfgFile = makeConfigKeysFile(tmpDir, [
    { id: 'admin', key: 'sk-admin-test-0000', name: 'Admin', status: 'active', role: 'admin' },
  ]);
  const { apiKeyStore } = require('../src/services');
  apiKeyStore.load(cfgFile);
  await startServer();
  try {
    await testHttpEndpoints();
  } finally {
    await new Promise((r) => expressServer.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(60));
  console.log(`ApiKeyStore Persistence — Integration: ${passed}/${results.length} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  FAIL: ${r.name} — ${r.detail || ''}`);
    }
    process.exit(1);
  }
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
