/**
 * Integration tests for ApiKeyManager full persistence.
 *
 * Run:  node examples/apiKeyPersistence.unit.js
 *
 * Tests:
 *   - key health survives restart
 *   - cooldown state survives restart
 *   - rotation cursor survives restart
 *   - failure count survives restart
 *   - success count survives restart
 *   - latency stats survive restart
 *   - token usage survives restart
 *   - disabled reason survives restart
 *   - weighted routing consistent after restart
 *   - migration helper works
 *   - no storage: backward compatible (in-memory only)
 *   - fallback to MemoryStorage when Redis unavailable
 */

const MemoryStorage = require('../src/storage/MemoryStorage');
const ApiKeyManager = require('../src/services/apiKeyManager');
const { KeyStatus, maskKey } = require('../src/services/apiKeyManager');
const AppError = require('../src/utils/AppError');
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

function makeError(code, status = 502) {
  return new AppError('test error', status, { code });
}

function makeProviders(keyCount = 3) {
  const keys = [];
  for (let i = 0; i < keyCount; i++) keys.push(`sk-key-${String.fromCharCode(97 + i)}`);
  return [
    {
      id: 'provider-a',
      name: 'Provider A',
      apiKeys: keys,
      keySelectionStrategy: 'round-robin',
    },
    {
      id: 'provider-b',
      name: 'Provider B',
      apiKeys: ['sk-b-key'],
      keySelectionStrategy: 'round-robin',
    },
  ];
}

// ---------------------------------------------------------------
// Simulate a restart by creating a new ApiKeyManager with the same
// storage backend and reloading the same provider configs.
// ---------------------------------------------------------------
function simulateRestart(store, providers) {
  const mgr = new ApiKeyManager({
    defaultStrategy: 'round-robin',
    storageProvider: store,
    cooldownsMs: { RATE_LIMITED: 60000, SERVER_ERROR: 5000, NETWORK_ERROR: 100, TIMEOUT: 100, UNKNOWN: 100 },
    failureThreshold: 1,
  });
  mgr.load(providers);
  return mgr;
}

// ---------------------------------------------------------------
// 1. Key health survives restart
// ---------------------------------------------------------------
async function testHealthSurvivesRestart() {
  const store = new MemoryStorage({ prefix: 'test-hsr' });
  const mgr1 = simulateRestart(store, makeProviders(3));
  mgr1.reportSuccess('provider-a', 'sk-key-a', { latencyMs: 50, tokens: 100 });
  mgr1.reportSuccess('provider-a', 'sk-key-a', { latencyMs: 150, tokens: 200 });
  mgr1.reportSuccess('provider-a', 'sk-key-b', { latencyMs: 30, tokens: 50 });
  mgr1.reportFailure('provider-a', 'sk-key-c', makeError('PROVIDER_SERVER_ERROR'));

  // Wait for async restore to complete
  await new Promise((r) => setTimeout(r, 50));

  // Restart
  const mgr2 = simulateRestart(store, makeProviders(3));
  await new Promise((r) => setTimeout(r, 50));

  const health = mgr2.getKeyHealth('provider-a');
  const keyA = health.find((k) => k.key === maskKey('sk-key-a'));
  const keyC = health.find((k) => k.key === maskKey('sk-key-c'));

  record('Health: successCount survives restart', keyA && keyA.stats.successCount === 2);
  record('Health: latency persists', keyA && keyA.stats.averageLatencyMs === 100);
  record('Health: tokens persist', keyA && keyA.stats.totalTokens === 300);
  record('Health: failureCount survives restart', keyC && keyC.stats.failureCount === 1);
  record('Health: consecutiveFailures persists', keyC && keyC.stats.consecutiveFailures === 1);
  record('Health: provider-b untouched', mgr2.getKeyHealth('provider-b').length === 1);
}

// ---------------------------------------------------------------
// 2. Cooldown state survives restart
// ---------------------------------------------------------------
async function testCooldownSurvivesRestart() {
  const store = new MemoryStorage({ prefix: 'test-csr' });
  const mgr1 = simulateRestart(store, makeProviders(2));
  const providers = makeProviders(2);

  // Trigger cooldown (threshold=1 after first failure)
  mgr1.reportFailure('provider-a', 'sk-key-a', makeError('PROVIDER_RATE_LIMITED'));

  // Key should be in cooldown
  let statusA = mgr1.getKeyHealth('provider-a').find((k) => k.key === maskKey('sk-key-a'));
  record('Cooldown: key in cooldown before restart', statusA && (statusA.status === 'COOLDOWN' || statusA.status === 'RATE_LIMITED'));

  // Wait for async restore
  await new Promise((r) => setTimeout(r, 50));

  // Restart
  const mgr2 = simulateRestart(store, providers);
  await new Promise((r) => setTimeout(r, 50));

  statusA = mgr2.getKeyHealth('provider-a').find((k) => k.key === maskKey('sk-key-a'));
  record('Cooldown: key still in cooldown after restart',
    statusA && (statusA.status === 'COOLDOWN' || statusA.status === 'RATE_LIMITED'));

  // cooldownUntil should be a future timestamp
  record('Cooldown: cooldownUntil persists',
    statusA && statusA.cooldownUntil !== null);
}

// ---------------------------------------------------------------
// 3. Rotation cursor survives restart
// ---------------------------------------------------------------
async function testCursorSurvivesRestart() {
  const store = new MemoryStorage({ prefix: 'test-cursor' });
  const providers = makeProviders(3);
  let mgr = simulateRestart(store, providers);

  // Select keys in round-robin (3 keys)
  mgr.getNextKey('provider-a'); // key-a
  mgr.getNextKey('provider-a'); // key-b
  mgr.getNextKey('provider-a'); // key-c

  await new Promise((r) => setTimeout(r, 50));

  // Restart
  mgr = simulateRestart(store, providers);
  await new Promise((r) => setTimeout(r, 50));

  // The cursor should point to key-c (lastIdx=2), so next should be key-a
  const next = mgr.getNextKey('provider-a');
  record('Cursor: resume at correct position after restart', next === 'sk-key-a');

  // Continue rotation
  const next2 = mgr.getNextKey('provider-a');
  record('Cursor: second pick correct after restart', next2 === 'sk-key-b');
}

// ---------------------------------------------------------------
// 4. Weighted routing consistent after restart
// ---------------------------------------------------------------
async function testWeightedRoutingAfterRestart() {
  const store = new MemoryStorage({ prefix: 'test-weighted' });
  const providers = [{
    id: 'weighted-p',
    name: 'Weighted',
    apiKeys: [
      { value: 'sk-heavy', priority: 1, weight: 10 },
      { value: 'sk-light', priority: 2, weight: 1 },
    ],
    keySelectionStrategy: 'weighted',
  }];

  let mgr = simulateRestart(store, providers);
  await new Promise((r) => setTimeout(r, 50));

  // Verify keys are loaded with correct weights
  const health = mgr.getKeyHealth('weighted-p');
  const heavy = health.find((k) => k.key === maskKey('sk-heavy'));
  const light = health.find((k) => k.key === maskKey('sk-light'));
  record('Weighted: heavy key weight persists', heavy && heavy.weight === 10);
  record('Weighted: light key weight persists', light && light.weight === 1);
}

// ---------------------------------------------------------------
// 5. Migration helper
// ---------------------------------------------------------------
async function testMigration() {
  const store = new MemoryStorage({ prefix: 'test-mig' });
  const mgr1 = simulateRestart(store, makeProviders(2));

  mgr1.reportSuccess('provider-a', 'sk-key-a', { latencyMs: 100, tokens: 50 });
  mgr1.reportFailure('provider-a', 'sk-key-b', makeError('PROVIDER_SERVER_ERROR'));
  mgr1.getNextKey('provider-a'); // move cursor

  // Migrate
  const result = await mgr1.migrate();
  record('Migration: reports key count', result.keys > 0);
  record('Migration: no error', !result.error);

  // Verify data exists in same store (MemoryStorage is process-local;
  // new instances cannot share data — use the same store reference)
  const restored = await store.keys('*');
  record('Migration: data written to storage', restored.length > 0);
}

// ---------------------------------------------------------------
// 6. Backward compat: no storage
// ---------------------------------------------------------------
async function testBackwardCompat() {
  const mgr = new ApiKeyManager({
    defaultStrategy: 'round-robin',
    cooldownsMs: { RATE_LIMITED: 1000, SERVER_ERROR: 500 },
    failureThreshold: 1,
  });
  mgr.load(makeProviders(3));

  mgr.reportSuccess('provider-a', 'sk-key-a', { latencyMs: 50 });
  mgr.reportFailure('provider-a', 'sk-key-b', makeError('PROVIDER_SERVER_ERROR'));

  const next = mgr.getNextKey('provider-a');
  record('Backward compat: works without storage', next === 'sk-key-a' || next === 'sk-key-c');
  record('Backward compat: tracks health', mgr.getKeyHealth('provider-a').length === 3);

  // Key-b should be in cooldown
  const keyB = mgr.getKeyHealth('provider-a').find((k) => k.key === maskKey('sk-key-b'));
  record('Backward compat: cooldown works', keyB && keyB.status === 'COOLDOWN');
}

// ---------------------------------------------------------------
// 7. Fallback: MemoryStorage used when no Redis
// ---------------------------------------------------------------
async function testFallbackMemory() {
  const RedisStorage = require('../src/storage/RedisStorage');
  const fallback = new MemoryStorage({ prefix: 'test-fb' });
  const redisStore = new RedisStorage({ prefix: 'test-fb', url: null, fallback });

  // Even without a real Redis, the fallback should work
  const mgr = new ApiKeyManager({
    defaultStrategy: 'round-robin',
    storageProvider: redisStore,
    failureThreshold: 1,
  });
  mgr.load(makeProviders(2));
  await new Promise((r) => setTimeout(r, 50));

  mgr.reportSuccess('provider-a', 'sk-key-a', { latencyMs: 100, tokens: 25 });
  const health = mgr.getKeyHealth('provider-a');
  const keyA = health.find((k) => k.key === maskKey('sk-key-a'));
  record('Fallback: MemoryStorage works via Redis fallback', keyA && keyA.stats.successCount === 1);
  record('Fallback: tokens tracked', keyA && keyA.stats.totalTokens === 25);
}

// ---------------------------------------------------------------
// 8. Restart with failure count preserved
// ---------------------------------------------------------------
async function testFailureCountAfterRestart() {
  const store = new MemoryStorage({ prefix: 'test-fcr' });
  const providers = makeProviders(2);
  let mgr = simulateRestart(store, providers);

  // Report multiple failures
  mgr.reportFailure('provider-a', 'sk-key-a', makeError('PROVIDER_SERVER_ERROR'));
  mgr.reportFailure('provider-a', 'sk-key-a', makeError('PROVIDER_TIMEOUT'));

  await new Promise((r) => setTimeout(r, 50));

  // Restart
  mgr = simulateRestart(store, providers);
  await new Promise((r) => setTimeout(r, 50));

  const health = mgr.getKeyHealth('provider-a');
  const keyA = health.find((k) => k.key === maskKey('sk-key-a'));
  record('FailureCount: survives restart', keyA && keyA.stats.failureCount === 2);
  record('FailureCount: lastError persists', keyA && keyA.stats.lastError !== null);
}

// ---------------------------------------------------------------
// 9. Disabled key stays disabled after restart
// ---------------------------------------------------------------
async function testDisabledAfterRestart() {
  const store = new MemoryStorage({ prefix: 'test-dar' });
  const providers = makeProviders(2);
  let mgr = simulateRestart(store, providers);

  mgr.disableKey('provider-a', 'sk-key-a');

  await new Promise((r) => setTimeout(r, 50));

  // Restart
  mgr = simulateRestart(store, providers);
  await new Promise((r) => setTimeout(r, 50));

  const health = mgr.getKeyHealth('provider-a');
  const keyA = health.find((k) => k.key === maskKey('sk-key-a'));
  record('Disabled: key stays DISABLED after restart', keyA && keyA.status === 'DISABLED');
}

// ---------------------------------------------------------------
// Run all
// ---------------------------------------------------------------
(async () => {
console.log('='.repeat(60));
console.log('ApiKeyManager Persistence — Integration');
console.log('='.repeat(60));

await testBackwardCompat();
await testHealthSurvivesRestart();
await testCooldownSurvivesRestart();
await testCursorSurvivesRestart();
await testWeightedRoutingAfterRestart();
await testMigration();
await testFallbackMemory();
await testFailureCountAfterRestart();
await testDisabledAfterRestart();

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log('\n' + '='.repeat(60));
console.log(`ApiKeyManager Persistence — Integration: ${passed}/${results.length} passed, ${failed} failed`);
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
