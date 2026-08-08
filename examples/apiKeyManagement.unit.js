/**
 * Unit tests for Prompt 23 — API Key Management, hashing, quota, lifecycle.
 *
 * Run:  node examples/apiKeyManagement.unit.js
 *
 * Covers:
 *   - ApiKeyHasher: generate / hash / fingerprint / verify
 *   - ApiKeyStore.generateKey: hashed-only storage (no plaintext persisted)
 *   - validate: hash lookup, revoked, expired, invalid
 *   - provider permission: allowed / denied
 *   - model permission: allowed / denied
 *   - quota: available / exhausted / atomic consume / concurrent
 *   - lifecycle: create / list / get / update / revoke / rotate / delete
 *   - security: secret not in publicView / listKeys
 */

const assert = require('assert');
const ApiKeyHasher = require('../src/services/apiKeyHasher');
const ApiKeyStore = require('../src/services/apiKeyStore');
const MemoryStorage = require('../src/storage/MemoryStorage');
const logger = require('../src/utils/logger');
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}
function check(name, fn) {
  try { const d = fn(); if (d && d.then) return d.then((x) => record(name, x !== false)).catch((e) => record(name, false, e.message)); record(name, d !== false); }
  catch (e) { record(name, false, e.message); }
}

async function run() {
  console.log('='.repeat(60));
  console.log('API Key Management — Unit');
  console.log('='.repeat(60));

  // ---- ApiKeyHasher ----
  const hasher = new ApiKeyHasher();
  const g = hasher.generate();
  record('hasher: generates prefixed key', g.rawKey.startsWith('sk-gw-'));
  record('hasher: hash is 64-hex SHA-256', /^[0-9a-f]{64}$/.test(g.keyHash));
  record('hasher: fingerprint is masked', g.keyPrefix.includes('...') && !g.keyPrefix.includes(g.rawKey.slice(10)));
  record('hasher: verify true for correct key', hasher.verify(g.rawKey, g.keyHash) === true);
  record('hasher: verify false for wrong key', hasher.verify('sk-gw-wrong', g.keyHash) === false);
  record('hasher: two keys differ', hasher.generate().rawKey !== hasher.generate().rawKey);

  // ---- Store with storage backend ----
  const store = new ApiKeyStore({ storageProvider: new MemoryStorage({ prefix: 't' }) });
  store.load('/nonexistent-so-empty.json');
  await store.hydrate();

  // ---- generateKey: no plaintext persisted ----
  const { record: rec, rawKey } = await store.generateKey({ name: 'Prod Key', role: 'user' });
  record('generateKey: returns one-time rawKey', typeof rawKey === 'string' && rawKey.startsWith('sk-gw-'));
  record('generateKey: record has keyHash', !!rec.keyHash);
  record('generateKey: record has NO plaintext key', rec.key === undefined);
  record('generateKey: keyPrefix present', !!rec.keyPrefix);

  // ---- validate via hash ----
  const v = store.validate(rawKey);
  record('validate: correct key valid', v.valid === true && v.key.id === rec.id);
  record('validate: unknown key invalid', store.validate('sk-gw-nope').error.code === 'INVALID_API_KEY');
  record('validate: missing key -> MISSING_API_KEY', store.validate(null).error.code === 'MISSING_API_KEY');

  // ---- security: no secret in public view / listKeys ----
  const pub = store.publicView(rec);
  record('security: publicView has no key', pub.key === undefined);
  record('security: publicView has no keyHash', pub.keyHash === undefined);
  record('security: publicView exposes keyPrefix', !!pub.keyPrefix);
  const listed = store.listKeys();
  const anySecret = listed.some((k) => k.key !== undefined || k.keyHash !== undefined);
  record('security: listKeys has no secrets', anySecret === false);

  // ---- provider permission ----
  const { record: provKey } = await store.generateKey({ name: 'NVIDIA only', allowedProviders: ['nvidia'] });
  record('provider perm: allowed provider ok', store.canAccessProvider(provKey, 'nvidia') === true);
  record('provider perm: denied provider blocked', store.canAccessProvider(provKey, 'openai') === false);
  const { record: denyKey } = await store.generateKey({ name: 'deny openai', deniedProviders: ['openai'] });
  record('provider perm: explicit deny blocks', store.canAccessProvider(denyKey, 'openai') === false);
  record('provider perm: non-denied allowed', store.canAccessProvider(denyKey, 'nvidia') === true);

  // ---- model permission ----
  const { record: modelKey } = await store.generateKey({ name: 'model-a only', allowedModels: ['model-a'] });
  record('model perm: allowed model ok', store.canAccessModel(modelKey, 'model-a') === true);
  record('model perm: denied model blocked', store.canAccessModel(modelKey, 'model-b') === false);

  // ---- quota ----
  const { record: qKey } = await store.generateKey({ name: 'quota key', quota: { limit: 1000 } });
  record('quota: normalized remaining', qKey.quota.remaining === 1000);
  record('quota: not exhausted initially', store.isQuotaExhausted(qKey) === false);
  const c1 = await store.consumeQuota(qKey.id, 400);
  record('quota: consume updates used/remaining', c1.used === 400 && c1.remaining === 600);
  await store.consumeQuota(qKey.id, 600);
  record('quota: exhausted at limit', store.isQuotaExhausted(store.keys.find((k) => k.id === qKey.id)) === true);
  const qStatus = store.getQuota(qKey.id);
  record('quota: getQuota remaining 0', qStatus.remaining === 0);

  // ---- quota atomic / concurrent ----
  const { record: aKey } = await store.generateKey({ name: 'atomic key', quota: { limit: 100000 } });
  const consumes = [];
  for (let i = 0; i < 50; i += 1) consumes.push(store.consumeQuota(aKey.id, 100));
  await Promise.all(consumes);
  const finalQuota = store.getQuota(aKey.id);
  record('quota: concurrent consume exact (no lost updates)', finalQuota.used === 5000, `used=${finalQuota.used}`);

  // ---- lifecycle: revoke ----
  const revoked = await store.revokeKey(rec.id);
  record('revoke: status revoked', revoked.status === 'revoked' && typeof revoked.revokedAt === 'number');
  record('revoke: revoked key rejected', store.validate(rawKey).error.code === 'REVOKED_API_KEY');
  record('revoke: historical record kept', store.keys.some((k) => k.id === rec.id));

  // ---- lifecycle: expired ----
  const { record: expKey, rawKey: expRaw } = await store.generateKey({ name: 'exp', expiresAt: Math.floor(Date.now() / 1000) - 10 });
  record('expired: validate rejects', store.validate(expRaw).error.code === 'EXPIRED_API_KEY');
  record('expired: effectiveStatus expired', store.effectiveStatus(expKey) === 'expired');

  // ---- lifecycle: rotate ----
  const { record: rotKey, rawKey: rotRaw1 } = await store.generateKey({ name: 'rotate me' });
  const oldHash = rotKey.keyHash;
  const rot = await store.rotateKey(rotKey.id);
  record('rotate: returns new rawKey', rot.rawKey !== rotRaw1 && rot.rawKey.startsWith('sk-gw-'));
  record('rotate: hash changed', rot.record.keyHash !== oldHash);
  record('rotate: old key no longer valid', store.validate(rotRaw1).valid === false);
  record('rotate: new key valid', store.validate(rot.rawKey).valid === true);
  record('rotate: same id preserved', rot.record.id === rotKey.id);

  // ---- lifecycle: update metadata ----
  const upd = await store.updateKey(rotKey.id, { name: 'renamed', allowedProviders: ['openai'] });
  record('update: metadata applied', upd.name === 'renamed' && upd.allowedProviders[0] === 'openai');

  // ---- lifecycle: delete ----
  const del = await store.deleteKey(expKey.id);
  record('delete: removes record', del === true && !store.keys.some((k) => k.id === expKey.id));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(60));
  console.log(`API Key Management — Unit: ${passed}/${results.length} passed, ${failed} failed`);
  console.log('='.repeat(60));
  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) console.log('  FAIL: ' + r.name + ' — ' + (r.detail || ''));
    process.exit(1);
  }
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
