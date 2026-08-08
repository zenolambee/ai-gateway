/**
 * Unit tests for Prompt 23 — Backup & Restore.
 *
 * Run:  node examples/backup.unit.js
 *
 * Covers:
 *   - createBackup: versioned, checksum, secret-free
 *   - validateBackup: version / schema / integrity / secret rejection
 *   - restoreBackup: dry-run, apply metadata, rejects invalid, no partial
 *   - listBackups / saveBackup / loadBackup (disk)
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const BackupService = require('../src/services/backupService');
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

// Minimal fakes for the non-key dependencies.
const providerManager = {
  listProviders: () => [
    { id: 'openai', name: 'OpenAI', enabled: true, baseURL: 'https://api.openai.com/v1', apiKeys: ['sk-secret-1', 'sk-secret-2'], supportedModels: ['gpt-4o'], headers: { Authorization: 'Bearer LEAK', 'X-Env': 'prod' } },
  ],
};
const quotaService = { getSnapshot: () => ({ policies: [{ id: 'p1', scope: 'api_key', limit: 'total_tokens', window: 'daily', value: 1000 }] }) };
const usageAccountant = { getSnapshot: () => ({ global: { requests: 5, totalTokens: 100, cost: 0 } }) };

async function run() {
  console.log('='.repeat(60));
  console.log('Backup & Restore — Unit');
  console.log('='.repeat(60));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
  const store = new ApiKeyStore({ storageProvider: new MemoryStorage({ prefix: 'b' }) });
  store.load('/nonexistent.json');
  await store.hydrate();
  const { record: k1 } = await store.generateKey({ name: 'Key One', allowedProviders: ['openai'], quota: { limit: 500 } });

  const svc = new BackupService({ providerManager, apiKeyStore: store, quotaService, usageAccountant }, { backupDir: tmpDir, gatewayVersion: '1.2.3' });

  // ---- createBackup ----
  const backup = await svc.createBackup();
  record('create: versioned', backup.backupVersion === 1);
  record('create: has createdAt + gatewayVersion', !!backup.createdAt && backup.gatewayVersion === '1.2.3');
  record('create: has checksum', typeof backup.checksum === 'string' && backup.checksum.length === 64);
  record('create: providers included', Array.isArray(backup.data.providers) && backup.data.providers.length === 1);
  record('create: apiKeys included', backup.data.apiKeys.length === 1);
  record('create: quotas included', backup.data.quotas.length === 1);
  record('create: usage included', !!backup.data.usage);

  // ---- security: no secrets ----
  const prov = backup.data.providers[0];
  record('security: provider apiKeys stripped', prov.apiKeys === undefined && prov.apiKey === undefined);
  record('security: provider apiKeyCount kept', prov.apiKeyCount === 2);
  record('security: provider Authorization header stripped', !prov.headers.Authorization);
  record('security: provider non-secret header kept', prov.headers['X-Env'] === 'prod');
  const bk = backup.data.apiKeys[0];
  record('security: apiKey has no plaintext', bk.key === undefined);
  record('security: apiKey has no keyHash', bk.keyHash === undefined);
  record('security: apiKey keyPrefix present', !!bk.keyPrefix);

  // ---- validateBackup ----
  record('validate: good backup valid', svc.validateBackup(backup).valid === true);
  record('validate: null invalid', svc.validateBackup(null).valid === false);
  const badVer = { ...backup, backupVersion: 999 };
  record('validate: future version rejected', svc.validateBackup(badVer).valid === false);
  const tampered = JSON.parse(JSON.stringify(backup));
  tampered.data.apiKeys[0].name = 'TAMPERED';
  record('validate: checksum mismatch rejected', svc.validateBackup(tampered).valid === false);
  const withSecret = JSON.parse(JSON.stringify(backup));
  withSecret.data.apiKeys[0].keyHash = 'deadbeef';
  withSecret.checksum = svc._checksum(withSecret.data);
  record('validate: secret material rejected', svc.validateBackup(withSecret).valid === false);
  const noData = { backupVersion: 1 };
  record('validate: missing data rejected', svc.validateBackup(noData).valid === false);

  // ---- restore dry-run ----
  const dry = await svc.restoreBackup(backup, { dryRun: true });
  record('restore: dry-run ok', dry.ok === true && dry.dryRun === true);
  record('restore: dry-run plans existing key', dry.applied.apiKeyMetadata === 1);

  // ---- restore apply (metadata for existing key) ----
  await store.updateKey(k1.id, { name: 'Changed Locally' });
  const applied = await svc.restoreBackup(backup);
  record('restore: apply ok', applied.ok === true && applied.dryRun === false);
  record('restore: metadata restored', store.keys.find((k) => k.id === k1.id).name === 'Key One');

  // ---- restore rejects invalid (no partial) ----
  const invalidRestore = await svc.restoreBackup(tampered);
  record('restore: invalid rejected', invalidRestore.ok === false && invalidRestore.errors.length > 0);

  // ---- disk: save / list / load ----
  const savedPath = await svc.saveBackup(backup, 'test');
  record('disk: saveBackup writes file', fs.existsSync(savedPath));
  const list = svc.listBackups();
  record('disk: listBackups returns entry', list.length >= 1 && list[0].backupVersion === 1);
  const loaded = svc.loadBackup(path.basename(savedPath));
  record('disk: loadBackup round-trips', loaded && loaded.checksum === backup.checksum);

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(60));
  console.log(`Backup & Restore — Unit: ${passed}/${results.length} passed, ${failed} failed`);
  console.log('='.repeat(60));
  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) console.log('  FAIL: ' + r.name + ' — ' + (r.detail || ''));
    process.exit(1);
  }
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
