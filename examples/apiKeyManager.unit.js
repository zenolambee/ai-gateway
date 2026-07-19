/**
 * Unit tests for ApiKeyManager.
 *
 * Run:  node examples/apiKeyManager.unit.js
 *
 * These tests exercise the manager in isolation — no HTTP, no Express.
 */

const ApiKeyManager = require('../src/services/apiKeyManager');
const { KeyStatus, maskKey, errorCodeToCategory } = require('../src/services/apiKeyManager');
const AppError = require('../src/utils/AppError');

// Silence logger
require('../src/utils/logger').info = () => {};
require('../src/utils/logger').warn = () => {};
require('../src/utils/logger').error = () => {};

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

function makeError(code, status = 502) {
  return new AppError('test error', status, { code });
}

function loadThreeKeys() {
  const mgr = new ApiKeyManager({
    cooldownsMs: { RATE_LIMITED: 1000, SERVER_ERROR: 500, NETWORK_ERROR: 100, TIMEOUT: 100, UNKNOWN: 100 },
    failureThreshold: 1,
  });
  mgr.load([
    { id: 'openai', apiKeys: ['key-a', 'key-b', 'key-c'] },
    { id: 'deepseek', apiKeys: ['d-key'] },
  ]);
  return mgr;
}

function testLoad() {
  const mgr = loadThreeKeys();
  record('load() registers keys per provider', mgr.getKeyStatus('openai').length === 3, `count=${mgr.getKeyStatus('openai').length}`);
  record('load() supports multiple providers', mgr.getKeyStatus('deepseek').length === 1);
  record('all keys start ACTIVE', mgr.getKeyStatus('openai').every((k) => k.status === KeyStatus.ACTIVE));
}

function testRoundRobin() {
  const mgr = loadThreeKeys();
  const seq = [];
  for (let i = 0; i < 7; i += 1) seq.push(mgr.getNextKey('openai'));
  record(
    'round-robin cycles through keys',
    seq[0] === 'key-a' && seq[1] === 'key-b' && seq[2] === 'key-c' && seq[3] === 'key-a' && seq[6] === 'key-a',
    `seq=${seq.join(',')}`
  );
}

function testSkipDisabled() {
  const mgr = loadThreeKeys();
  mgr.disableKey('openai', 'key-b');
  const seq = [];
  for (let i = 0; i < 5; i += 1) seq.push(mgr.getNextKey('openai'));
  record(
    'disabled key is skipped',
    !seq.includes('key-b') && seq.includes('key-a') && seq.includes('key-c'),
    `seq=${seq.join(',')}`
  );
}

function testReportSuccess() {
  const mgr = loadThreeKeys();
  mgr.getNextKey('openai');
  mgr.reportSuccess('openai', 'key-a');
  const stat = mgr.getKeyStatus('openai').find((k) => k.key === maskKey('key-a'));
  record('reportSuccess increments successCount', stat.stats.successCount === 1, `count=${stat.stats.successCount}`);
  record('reportSuccess keeps key ACTIVE', stat.status === KeyStatus.ACTIVE);
}

function testCooldownOnRateLimit() {
  const mgr = loadThreeKeys();
  mgr.getNextKey('openai'); // key-a
  mgr.reportFailure('openai', 'key-a', makeError('PROVIDER_RATE_LIMITED', 429));
  const stat = mgr.getKeyStatus('openai').find((k) => k.key === maskKey('key-a'));
  record('rate-limit puts key in COOLDOWN', stat.status === KeyStatus.COOLDOWN, `status=${stat.status}`);
  record('cooldownUntil set', stat.cooldownUntil !== null);
  // next key should skip key-a
  const next = mgr.getNextKey('openai');
  record('cooling-down key skipped by getNextKey', next !== 'key-a', `next=${next}`);
}

function testAutoReenableAfterCooldown() {
  const mgr = new ApiKeyManager({ cooldownsMs: { RATE_LIMITED: 10, UNKNOWN: 10 }, failureThreshold: 1 });
  mgr.load([{ id: 'openai', apiKeys: ['key-a', 'key-b'] }]);
  mgr.getNextKey('openai');
  mgr.reportFailure('openai', 'key-a', makeError('PROVIDER_RATE_LIMITED', 429));
  let stat = mgr.getKeyStatus('openai').find((k) => k.key === maskKey('key-a'));
  record('key in cooldown', stat.status === KeyStatus.COOLDOWN);
  return new Promise((resolve) => {
    setTimeout(() => {
      mgr.getNextKey('openai'); // triggers reconcile
      stat = mgr.getKeyStatus('openai').find((k) => k.key === maskKey('key-a'));
      record('auto re-enable after cooldown', stat.status === KeyStatus.ACTIVE, `status=${stat.status}`);
      resolve();
    }, 30);
  });
}

function testUnauthorizedIsPermanent() {
  const mgr = loadThreeKeys();
  mgr.getNextKey('openai'); // key-a
  mgr.reportFailure('openai', 'key-a', makeError('PROVIDER_UNAUTHORIZED', 401));
  const stat = mgr.getKeyStatus('openai').find((k) => k.key === maskKey('key-a'));
  record('401 marks key UNAUTHORIZED', stat.status === KeyStatus.UNAUTHORIZED, `status=${stat.status}`);
  record('no cooldownUntil on UNAUTHORIZED', stat.cooldownUntil === null);
  // Auto re-enable should not trigger
  const seq = [];
  for (let i = 0; i < 3; i += 1) seq.push(mgr.getNextKey('openai'));
  record('UNAUTHORIZED key is permanently skipped', !seq.includes('key-a'), `seq=${seq.join(',')}`);
}

function testEnableKey() {
  const mgr = loadThreeKeys();
  mgr.disableKey('openai', 'key-a');
  record('disableKey works', mgr.getKeyStatus('openai')[0].status === KeyStatus.DISABLED);
  mgr.enableKey('openai', 'key-a');
  record('enableKey restores ACTIVE', mgr.getKeyStatus('openai')[0].status === KeyStatus.ACTIVE);
}

function testNoKeysThrows() {
  const mgr = new ApiKeyManager();
  mgr.load([{ id: 'empty', apiKeys: [] }]);
  let threw = false;
  let code;
  try {
    mgr.getNextKey('empty');
  } catch (err) {
    threw = true;
    code = err.info && err.info.code;
  }
  record('getNextKey with no keys throws', threw && code === 'NO_API_KEYS', `code=${code}`);
}

function testAllUnavailableThrows() {
  const mgr = loadThreeKeys();
  mgr.disableKey('openai', 'key-a');
  mgr.disableKey('openai', 'key-b');
  mgr.disableKey('openai', 'key-c');
  let threw = false;
  let code;
  try {
    mgr.getNextKey('openai');
  } catch (err) {
    threw = true;
    code = err.info && err.info.code;
  }
  record('all disabled -> ALL_KEYS_UNAVAILABLE', threw && code === 'ALL_KEYS_UNAVAILABLE', `code=${code}`);
}

function testStatsTracking() {
  const mgr = loadThreeKeys();
  mgr.getNextKey('openai'); // key-a, request++
  mgr.getNextKey('openai'); // key-b
  mgr.reportSuccess('openai', 'key-a');
  mgr.reportSuccess('openai', 'key-a');
  mgr.reportFailure('openai', 'key-b', makeError('PROVIDER_RATE_LIMITED', 429));
  const a = mgr.getKeyStatus('openai').find((k) => k.key === maskKey('key-a'));
  const b = mgr.getKeyStatus('openai').find((k) => k.key === maskKey('key-b'));
  record('stats.totalRequests tracked', a.stats.totalRequests === 1, `total=${a.stats.totalRequests}`);
  record('stats.successCount tracked', a.stats.successCount === 2, `ok=${a.stats.successCount}`);
  record('stats.failureCount tracked', b.stats.failureCount === 1, `fail=${b.stats.failureCount}`);
  record('stats.lastUsed tracked', a.stats.lastUsed !== null);
  record('stats.lastError tracked', b.stats.lastError !== null && b.stats.lastError.code === 'PROVIDER_RATE_LIMITED');
}

function testMaskKey() {
  record('maskKey masks long key', maskKey('sk-abcdefghij1234567890') === '****7890');
  record('maskKey short key', maskKey('ab') === '****');
}

function testErrorCodeToCategory() {
  record('RATE_LIMITED category', errorCodeToCategory('PROVIDER_RATE_LIMITED') === 'RATE_LIMITED');
  record('UNAUTHORIZED category', errorCodeToCategory('PROVIDER_UNAUTHORIZED') === 'UNAUTHORIZED');
  record('SERVER_ERROR category', errorCodeToCategory('PROVIDER_SERVER_ERROR') === 'SERVER_ERROR');
  record('NETWORK_ERROR category', errorCodeToCategory('PROVIDER_CONNECTION_REFUSED') === 'NETWORK_ERROR');
  record('TIMEOUT category', errorCodeToCategory('PROVIDER_TIMEOUT') === 'TIMEOUT');
  record('unknown falls back', errorCodeToCategory('SOMETHING_ELSE') === 'UNKNOWN');
}

function testGetAllStatus() {
  const mgr = loadThreeKeys();
  const all = mgr.getAllStatus();
  record('getAllStatus returns every provider', Object.keys(all).length === 2, `providers=${Object.keys(all).join(',')}`);
  record('getAllStatus returns key arrays', all.openai.length === 3 && all.deepseek.length === 1);
}

async function main() {
  console.log('=== ApiKeyManager Unit Tests ===\n');
  testLoad();
  testRoundRobin();
  testSkipDisabled();
  testReportSuccess();
  testCooldownOnRateLimit();
  await testAutoReenableAfterCooldown();
  testUnauthorizedIsPermanent();
  testEnableKey();
  testNoKeysThrows();
  testAllUnavailableThrows();
  testStatsTracking();
  testMaskKey();
  testErrorCodeToCategory();
  testGetAllStatus();

  const failed = results.filter((r) => !r.passed);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length > 0) {
    console.error('FAILED TESTS:');
    failed.forEach((f) => console.error(`  - ${f.name}: ${f.detail}`));
    process.exit(1);
  }
}

main();
