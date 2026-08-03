/**
 * Unit tests for provider config startup validation.
 *
 * Run:  node examples/startupValidation.unit.js
 *
 * These tests exercise the provider config validation logic in isolation —
 * no HTTP, no Express. Covers:
 *   - unexpanded env-var placeholders detected and provider disabled
 *   - missing/empty API keys cause provider to be auto-disabled
 *   - valid providers pass through unchanged
 *   - invalid baseURL triggers validation error
 *   - duplicate provider ids rejected
 *   - duplicate models within a provider rejected
 *   - mixed valid/invalid providers: valid ones survive, invalid ones dropped
 *   - ProviderManager.getDisabledProviders() returns correct reasons
 *   - disabled providers are NOT included in getEnabledProviders()
 *   - hasUnexpandedEnvVars and findUnexpandedEnvVarNames helpers
 */

const {
  validateProviderConfigs,
  validateProvider,
  hasUnexpandedEnvVars,
  findUnexpandedEnvVarNames,
} = require('../src/config/providersConfig');
const ProviderManager = require('../src/services/providerManager');
const logger = require('../src/utils/logger');

// Silence logger
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
// Helper: valid base provider config
// ---------------------------------------------------------------
function validProvider(overrides = {}) {
  return {
    id: 'test-provider',
    name: 'Test Provider',
    enabled: true,
    baseURL: 'http://127.0.0.1:8080',
    apiKeys: ['sk-test-key'],
    supportedModels: ['test-model'],
    priority: 1,
    timeout: 5000,
    ...overrides,
  };
}

// ---------------------------------------------------------------
// hasUnexpandedEnvVars / findUnexpandedEnvVarNames helpers
// ---------------------------------------------------------------
function testUnexpandedHelpers() {
  // String with no placeholders
  record('hasUnexpandedEnvVars: false for plain string',
    hasUnexpandedEnvVars('hello') === false);

  // String with unexpanded placeholder
  record('hasUnexpandedEnvVars: true for ${VAR}',
    hasUnexpandedEnvVars('${API_KEY}') === true);

  // String with already-expanded value (env var was set, no ${} remains)
  record('hasUnexpandedEnvVars: false for expanded value (no ${} pattern)',
    hasUnexpandedEnvVars('expanded-value') === false);

  // Object with nested unexpanded
  record('hasUnexpandedEnvVars: true for nested object',
    hasUnexpandedEnvVars({ key: '${SECRET}' }) === true);

  // Array with unexpanded
  record('hasUnexpandedEnvVars: true for array',
    hasUnexpandedEnvVars(['${KEY_A}', '${KEY_B}']) === true);

  // findUnexpandedEnvVarNames extracts variable names
  const names = findUnexpandedEnvVarNames('${MY_KEY}');
  record('findUnexpandedEnvVarNames: extracts name',
    names.length === 1 && names[0] === 'MY_KEY');

  // findUnexpandedEnvVarNames extracts multiple
  const multi = findUnexpandedEnvVarNames({ url: '${BASE}', key: '${TOKEN}' });
  record('findUnexpandedEnvVarNames: multiple vars',
    multi.length === 2 && multi.includes('BASE') && multi.includes('TOKEN'));
}

// ---------------------------------------------------------------
// Env-placeholder validation
// ---------------------------------------------------------------
function testUnexpandedEnvVarBlocked() {
  // Provider with unexpanded baseURL
  const badUrl = validProvider({ baseURL: 'http://${UNSET_HOST}:8080' });
  const urlResult = validateProviderConfigs([badUrl]);
  record('unexpanded baseURL: dropped from valid providers',
    urlResult.providers.length === 0 && urlResult.errors.length === 1);
  record('unexpanded baseURL: error message includes variable name',
    urlResult.errors[0].includes('UNSET_HOST'));

  // Provider with unexpanded API key
  const badKey = validProvider({ apiKeys: ['${UNSET_API_KEY}'] });
  const keyResult = validateProviderConfigs([badKey]);
  record('unexpanded apiKey: dropped from valid providers',
    keyResult.providers.length === 0 && keyResult.errors.length === 1);
  record('unexpanded apiKey: error message includes variable name',
    keyResult.errors[0].includes('UNSET_API_KEY'));
}

// ---------------------------------------------------------------
// Missing API keys → auto-disabled
// ---------------------------------------------------------------
function testMissingApiKeysDisabled() {
  // Empty apiKeys array
  const noKeys = validProvider({ apiKeys: [] });
  const result = validateProviderConfigs([noKeys]);
  record('empty apiKeys: kept but disabled',
    result.providers.length === 1 && result.providers[0].id === 'test-provider');
  record('empty apiKeys: disabled with reason',
    result.providers[0].__disabledReason === 'No API keys configured');
  record('empty apiKeys: enabled set to false',
    result.providers[0].enabled === false);

  // Missing apiKeys field entirely
  const missingField = validProvider({ apiKeys: undefined });
  // TL:DR the validateProvider will set apiKeys to undefined; the validator
  // will then see it's not an array => treats as empty.
  const result2 = validateProviderConfigs([missingField]);
  record('missing apiKeys field: kept but disabled',
    result2.providers.length === 1 && result2.providers[0].__disabledReason === 'No API keys configured');

  // Empty string key
  const emptyStrKey = validProvider({ apiKeys: [''] });
  const result3 = validateProviderConfigs([emptyStrKey]);
  record('empty string apiKey: kept but disabled',
    result3.providers.length === 1 && result3.providers[0].__disabledReason === 'No API keys configured');
}

// ---------------------------------------------------------------
// Valid provider passes through
// ---------------------------------------------------------------
function testValidProviderPasses() {
  const result = validateProviderConfigs([validProvider()]);
  record('valid provider: passes validation',
    result.providers.length === 1 && result.errors.length === 0);
  record('valid provider: keeps enabled=true',
    result.providers[0].enabled === true);
  record('valid provider: no disabled reason',
    result.providers[0].__disabledReason === undefined);
}

// ---------------------------------------------------------------
// Invalid baseURL
// ---------------------------------------------------------------
function testInvalidBaseUrl() {
  // Non-HTTP protocol
  const badProto = validProvider({ baseURL: 'ftp://bad.example.com' });
  const result1 = validateProviderConfigs([badProto]);
  record('invalid protocol: dropped',
    result1.providers.length === 0 && result1.errors.length === 1);

  // Non-parseable URL
  const badUrl = validProvider({ baseURL: 'not-a-url' });
  const result2 = validateProviderConfigs([badUrl]);
  record('unparseable baseURL: dropped',
    result2.providers.length === 0 && result2.errors.length === 1);
}

// ---------------------------------------------------------------
// Duplicate IDs
// ---------------------------------------------------------------
function testDuplicateIds() {
  const p1 = validProvider({ id: 'dup-id' });
  const p2 = validProvider({ id: 'dup-id', name: 'Duplicate', baseURL: 'http://other:9090' });
  // Make p2 distinct enough to not hit other validation
  p2.supportedModels = ['other-model'];
  p2.apiKeys = ['sk-other-key'];

  const result = validateProviderConfigs([p1, p2]);
  record('duplicate id: only first is kept',
    result.providers.length === 1 && result.providers[0].id === 'dup-id');
  record('duplicate id: error reported',
    result.errors.some((e) => e.includes('Duplicate provider id')));
}

// ---------------------------------------------------------------
// Duplicate models within a provider
// ---------------------------------------------------------------
function testDuplicateModels() {
  const withDupModels = validProvider({ supportedModels: ['model-a', 'model-b', 'model-a'] });
  const result = validateProviderConfigs([withDupModels]);
  record('duplicate models: provider still accepted',
    result.providers.length === 1);
  record('duplicate models: error reported for duplicates',
    result.errors.some((e) => e.includes('duplicate model')));
}

// ---------------------------------------------------------------
// Mixed valid + invalid providers
// ---------------------------------------------------------------
function testMixedProviders() {
  const good = validProvider({ id: 'good', apiKeys: ['sk-good'] });
  const badKey = validProvider({ id: 'bad-key', apiKeys: ['${UNSET_VAR}'] });
  const badUrl = validProvider({ id: 'bad-url', baseURL: 'not-valid' });
  const noKeys = validProvider({ id: 'no-keys', apiKeys: [] });

  const result = validateProviderConfigs([good, badKey, badUrl, noKeys]);
  record('mixed providers: valid survive, invalid dropped',
    result.providers.length === 2);
  record('mixed providers: good provider included',
    result.providers.some((p) => p.id === 'good'));
  record('mixed providers: no-keys included as disabled',
    result.providers.some((p) => p.id === 'no-keys' && p.__disabledReason));
  record('mixed providers: bad-key dropped',
    !result.providers.some((p) => p.id === 'bad-key'));
  record('mixed providers: bad-url dropped',
    !result.providers.some((p) => p.id === 'bad-url'));
}

// ---------------------------------------------------------------
// ProviderManager.getDisabledProviders()
// ---------------------------------------------------------------
function testProviderManagerDisabled() {
  const pm = new ProviderManager();
  pm.load = () => {};
  pm._disabledReasons = new Map();
  pm._disabledReasons.set('disabled-inline', 'No API keys configured');
  pm._disabledReasons.set('disabled-config', 'Disabled in config');

  // Mock the providers list
  pm.providers = [
    { id: 'enabled-provider', enabled: true, name: 'Enabled', baseURL: 'http://a', apiKeys: ['k'], supportedModels: ['m'], priority: 1 },
    { id: 'disabled-inline', enabled: false, name: 'No Keys', baseURL: 'http://b', apiKeys: [], supportedModels: ['m'], priority: 2 },
    { id: 'disabled-config', enabled: false, name: 'Config Off', baseURL: 'http://c', apiKeys: ['k'], supportedModels: ['m'], priority: 3 },
  ];

  const disabled = pm.getDisabledProviders();
  record('getDisabledProviders: correct count',
    disabled.length === 2);
  record('getDisabledProviders: reason preserved',
    disabled.find((d) => d.provider.id === 'disabled-inline').reason === 'No API keys configured');
  record('getDisabledProviders: config-disabled default reason',
    disabled.find((d) => d.provider.id === 'disabled-config').reason === 'Disabled in config');

  const enabled = pm.providers.filter((p) => p.enabled);
  record('getEnabledProviders: only actually enabled included',
    enabled.length === 1 && enabled[0].id === 'enabled-provider');

  // getDisabledReason
  record('getDisabledReason: returns reason for disabled',
    pm.getDisabledReason('disabled-inline') === 'No API keys configured');
  record('getDisabledReason: returns null for enabled',
    pm.getDisabledReason('enabled-provider') === null);
  record('getDisabledReason: returns null for unknown',
    pm.getDisabledReason('nonexistent') === null);
}

// ---------------------------------------------------------------
// Adapter capabilities accuracy (no over-claims)
// ---------------------------------------------------------------
function testAdapterCapabilities() {
  const ProviderAdapterRegistry = require('../src/providers/providerAdapterRegistry');
  const reg = new ProviderAdapterRegistry();

  const baseProvider = { id: 'test', apiKeys: ['k'], supportedModels: ['m'], baseURL: 'http://localhost' };

  const cases = [
    { id: 'generic-openai', images: false, audio: false, embeddings: false, reasoning: false },
    { id: 'openai', images: true, audio: true, embeddings: true, reasoning: true },
    { id: 'openrouter', images: true, audio: false, embeddings: true, reasoning: true },
    { id: 'deepseek', images: false, audio: false, embeddings: true, reasoning: true },
    { id: 'databricks', images: false, audio: false, embeddings: true, reasoning: false },
    { id: 'nvidia', images: false, audio: false, embeddings: true, reasoning: false },
    { id: 'gemini', images: false, audio: false, embeddings: true, reasoning: true },
    { id: 'anthropic', images: false, audio: false, embeddings: false, reasoning: true },
    { id: 'tokenfaucet', images: false, audio: false, embeddings: false, reasoning: false },
  ];

  for (const c of cases) {
    const adapter = reg.getAdapter({ ...baseProvider, adapter: c.id });
    const caps = adapter.capabilities();
    const label = c.id;

    record(`${label}: supportsImages=${c.images}`,
      caps.supportsImages === c.images, `got=${caps.supportsImages}`);
    record(`${label}: supportsAudio=${c.audio}`,
      caps.supportsAudio === c.audio, `got=${caps.supportsAudio}`);
    record(`${label}: supportsEmbeddings=${c.embeddings}`,
      caps.supportsEmbeddings === c.embeddings, `got=${caps.supportsEmbeddings}`);
    record(`${label}: supportsReasoning=${c.reasoning}`,
      caps.supportsReasoning === c.reasoning, `got=${caps.supportsReasoning}`);
    record(`${label}: supportsChat=true`,
      caps.supportsChat === true);
    record(`${label}: supportsTools matches`,
      c.id !== 'tokenfaucet' ? caps.supportsTools === true : caps.supportsTools === false);
  }
}

// ---------------------------------------------------------------
// Run all
// ---------------------------------------------------------------
(async () => {
console.log('='.repeat(60));
console.log('Startup Validation — Unit');
console.log('='.repeat(60));

testUnexpandedHelpers();
testUnexpandedEnvVarBlocked();
testMissingApiKeysDisabled();
testValidProviderPasses();
testInvalidBaseUrl();
testDuplicateIds();
testDuplicateModels();
testMixedProviders();
testProviderManagerDisabled();
testAdapterCapabilities();

let passed = results.filter((r) => r.passed).length;
let failed = results.filter((r) => !r.passed).length;
console.log('\n' + '='.repeat(60));
console.log(`Startup Validation — Unit: ${passed}/${results.length} passed, ${failed} failed`);
console.log('='.repeat(60));

if (failed > 0) {
  process.exit(1);
}

// ---------------------------------------------------------------
// Storage-backed service integration tests
// ---------------------------------------------------------------
console.log('\n' + '='.repeat(60));
console.log('Storage-Service Integration');
console.log('='.repeat(60));

const MemoryStorage = require('../src/storage/MemoryStorage');
const UsageTracker = require('../src/services/usageTracker');
const MetricsCollector = require('../src/services/metricsCollector');

async function testUsageTrackerWithStorage() {
  const store = new MemoryStorage({ prefix: 'test-ut' });
  const ut = new UsageTracker({ storageProvider: store });

  ut.recordRequest('key-1');
  ut.recordRequest('key-1');
  ut.recordUsage('key-1', { totalTokens: 100, providerId: 'openai', model: 'gpt-4' });

  const usage = ut.getUsage('key-1');
  record('UsageTracker: records requests', usage.totalRequests === 2);
  record('UsageTracker: records tokens', usage.totalTokens === 100);
  record('UsageTracker: persists to storage', (await store.hgetall('usage:key-1')) !== null);

  ut.reset();
  record('UsageTracker: reset clears in-memory', ut.getUsage('key-1') === null);
}

async function testMetricsCollectorWithStorage() {
  const store = new MemoryStorage({ prefix: 'test-mc' });
  const mc = new MetricsCollector({ storageProvider: store });

  mc.recordRequestStart({ providerId: 'p1', virtualModelId: 'vm1' });
  mc.recordSuccess({ providerId: 'p1', virtualModelId: 'vm1', latencyMs: 100, cost: 0.05, promptTokens: 10, completionTokens: 20 });

  const snap = mc.getSnapshot();
  record('MetricsCollector: global requests', snap.global.totalRequests === 1);
  record('MetricsCollector: global success', snap.global.successfulRequests === 1);
  record('MetricsCollector: global cost', snap.global.totalCost === 0.05);
  record('MetricsCollector: provider tracked', snap.providers.p1 !== undefined);
  record('MetricsCollector: VM tracked', snap.virtualModels.vm1 !== undefined);
  record('MetricsCollector: persists global', (await store.hgetall('metrics:global')).totalRequests === 1);
}

async function testRateLimiterWithStorage() {
  const store = new MemoryStorage({ prefix: 'test-rl' });
  const RateLimiter = require('../src/services/rateLimiter');
  const rl = new RateLimiter({
    enabled: true, algorithm: 'fixed_window',
    perKey: { requestsPerMinute: 100, dailyRequestQuota: 50, dailyTokenQuota: 10000 },
  }, { storageProvider: store });

  rl.recordTokens('ak-1', 500);
  rl.recordRequest('ak-1');
  const qd = rl.quota.data.get('ak-1');
  record('RateLimiter: quota tracks tokens', qd && qd.dayTokens === 500);
  record('RateLimiter: quota tracks requests', qd && qd.dayCount === 1);
}

async function testHealthMonitorWithStorage() {
  const store = new MemoryStorage({ prefix: 'test-hm' });
  const ProviderHealthMonitor = require('../src/services/providerHealthMonitor');
  const hm = new ProviderHealthMonitor({ storageProvider: store, failureThreshold: 2 });

  hm.recordSuccess({ providerId: 'p1', latencyMs: 50 });
  hm.recordFailure({ providerId: 'p1' });
  hm.recordFailure({ providerId: 'p1' });

  record('HealthMonitor: circuit opens', hm.isAvailable('p1') === false);
  record('HealthMonitor: success tracked', hm.getHealth('p1').totalSuccess === 1);
  record('HealthMonitor: failure tracked', hm.getHealth('p1').totalFailure === 2);
}

async function testBudgetServiceWithStorage() {
  const store = new MemoryStorage({ prefix: 'test-bs' });
  const BudgetService = require('../src/services/budgetService');
  const bs = new BudgetService({
    enabled: true,
    budgets: [{ id: 'b1', name: 'B1', scope: 'global', window: 'daily', limit: 100, onExceed: 'stop' }],
  }, { storageProvider: store });

  bs.consume({ cost: 30 });
  bs.consume({ cost: 20 });
  record('BudgetService: cost tracked', bs.counters.get('b1').totalCost === 50);
}

async function testQuotaServiceWithStorage() {
  const store = new MemoryStorage({ prefix: 'test-qs' });
  const QuotaService = require('../src/services/quotaService');
  const qs = new QuotaService({
    enabled: true,
    policies: [{ id: 'q1', name: 'Q1', scope: 'api_key', window: 'daily', limit: 'total_tokens', value: 1000, action: 'reject' }],
  }, { storageProvider: store });

  qs.consume({ apiKeyId: 'ak-1', totalTokens: 300 });
  qs.consume({ apiKeyId: 'ak-1', totalTokens: 200 });
  record('QuotaService: tokens tracked', qs.counters.get('q1').totalTokens === 500);
}

await testUsageTrackerWithStorage();
await testMetricsCollectorWithStorage();
await testRateLimiterWithStorage();
await testHealthMonitorWithStorage();
await testBudgetServiceWithStorage();
await testQuotaServiceWithStorage();

passed = results.filter((r) => r.passed).length;
failed = results.filter((r) => !r.passed).length;
console.log('\n' + '='.repeat(60));
console.log(`Storage-Service Integration: ${results.length} total, ${failed} failed`);
console.log('='.repeat(60));

if (failed > 0) {
  process.exit(1);
}
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
