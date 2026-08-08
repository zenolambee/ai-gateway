/**
 * Unit tests for Prompt 24 — UsageAnalyticsService.
 *
 * Run:  node examples/usageAnalytics.unit.js
 *
 * Covers: per-key usage + quota, provider/model aggregation, daily/monthly,
 * status/stream/latency analytics, filtering + pagination, isolation,
 * security (no secrets), quota percentages + reset period.
 */

const UsageAnalyticsService = require('../src/services/usageAnalyticsService');
const UsageAccountant = require('../src/services/usageAccountant');
const ApiKeyStore = require('../src/services/apiKeyStore');
const MemoryStorage = require('../src/storage/MemoryStorage');
const logger = require('../src/utils/logger');
logger.info = () => {}; logger.warn = () => {}; logger.error = () => {};

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const providerManager = { listProviders: () => [{ id: 'openai' }, { id: 'nvidia' }, { id: 'idle-prov' }] };

async function run() {
  console.log('='.repeat(60));
  console.log('Usage Analytics — Unit');
  console.log('='.repeat(60));

  const acc = new UsageAccountant({});
  const store = new ApiKeyStore({ storageProvider: new MemoryStorage({ prefix: 'ua' }) });
  store.load('/nonexistent.json');
  await store.hydrate();
  const svc = new UsageAnalyticsService({ usageAccountant: acc, apiKeyStore: store, providerManager });

  const { record: k1 } = await store.generateKey({ name: 'K1', quota: { limit: 1000 } });
  const { record: k2 } = await store.generateKey({ name: 'K2' });

  // Seed usage: k1 → openai/gpt-4o (2 success non-stream, 1 rate_limited stream)
  acc.recordRequest({ requestId: 'a1', apiKeyId: k1.id, providerId: 'openai', model: 'gpt-4o', status: 200, latencyMs: 100, stream: false, inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.01 });
  acc.recordRequest({ requestId: 'a2', apiKeyId: k1.id, providerId: 'openai', model: 'gpt-4o', status: 200, latencyMs: 200, stream: false, inputTokens: 200, outputTokens: 100, totalTokens: 300, cost: 0.02 });
  acc.recordRequest({ requestId: 'a3', apiKeyId: k1.id, providerId: 'openai', model: 'gpt-4o', status: 429, latencyMs: 20, stream: true, errorCategory: 'rate_limited' });
  // k2 → nvidia/model-x (1 success, no tokens reported → unknown)
  acc.recordRequest({ requestId: 'b1', apiKeyId: k2.id, providerId: 'nvidia', model: 'model-x', status: 200, latencyMs: 50, stream: false });

  // ---- per-key usage ----
  const u1 = svc.getApiKeyUsage(k1.id);
  record('apiKey usage: requests', u1.usage.requests === 3);
  record('apiKey usage: success/fail', u1.usage.successfulRequests === 2 && u1.usage.failedRequests === 1);
  record('apiKey usage: success rate', u1.usage.successRate === 66.67, `rate=${u1.usage.successRate}`);
  record('apiKey usage: error rate', u1.usage.errorRate === 33.33, `rate=${u1.usage.errorRate}`);
  record('apiKey usage: input/output/total tokens', u1.usage.inputTokens === 300 && u1.usage.outputTokens === 150 && u1.usage.totalTokens === 450);
  record('apiKey usage: stream split', u1.usage.streamRequests === 1 && u1.usage.nonStreamRequests === 2);
  record('apiKey usage: latency avg/min/max', u1.usage.averageLatencyMs === 107 && u1.usage.minLatencyMs === 20 && u1.usage.maxLatencyMs === 200, `avg=${u1.usage.averageLatencyMs}`);
  record('apiKey usage: error category', u1.usage.errorsByCategory.rate_limited === 1);

  // ---- token unknown not faked ----
  const u2 = svc.getApiKeyUsage(k2.id);
  record('token unknown: k2 total tokens 0 (not faked)', u2.usage.totalTokens === 0 && u2.usage.requests === 1);

  // ---- quota analytics ----
  await store.consumeQuota(k1.id, 750);
  const q = svc.getApiKeyQuota(k1.id);
  record('quota: limit/used/remaining', q.limit === 1000 && q.used === 750 && q.remaining === 250);
  record('quota: percentageUsed', q.percentageUsed === 75);
  record('quota: percentageRemaining', q.percentageRemaining === 25);
  record('quota: reset period default never', q.resetPeriod === 'never' && q.resetAt === null);
  // With reset period
  await store.updateKey(k2.id, { quota: { limit: 100, reset: 'monthly' } });
  const q2 = svc.getApiKeyQuota(k2.id);
  record('quota: monthly reset resetAt present', q2.resetPeriod === 'monthly' && typeof q2.resetAt === 'string');

  // ---- usage vs quota separation ----
  record('usage vs quota: historical preserved independent of quota', u1.usage.totalTokens === 450 && q.used === 750);

  // ---- provider aggregation (incl. idle provider from registry) ----
  const provs = svc.getProviderUsage();
  const openai = provs.find((p) => p.providerId === 'openai');
  const idle = provs.find((p) => p.providerId === 'idle-prov');
  record('provider agg: openai requests', openai.requests === 3);
  record('provider agg: idle provider present with zero', idle && idle.requests === 0);

  // ---- model aggregation ----
  const models = svc.getModelUsage();
  record('model agg: gpt-4o present', models.some((m) => m.model === 'gpt-4o' && m.requests === 3));
  const modelsByProv = svc.getModelUsage({ providerId: 'nvidia' });
  record('model agg: filtered by provider', modelsByProv.length === 1 && modelsByProv[0].model === 'model-x');

  // ---- daily / monthly ----
  record('daily: bucket present', svc.getDailyUsage().length >= 1 && svc.getDailyUsage()[0].requests === 4);
  record('monthly: bucket present', svc.getMonthlyUsage().length >= 1 && svc.getMonthlyUsage()[0].requests === 4);

  // ---- summary ----
  const sum = svc.getUsageSummary();
  record('summary: totals', sum.requests === 4 && sum.providers === 2 && sum.apiKeys === 2);

  // ---- filtering + pagination ----
  const page1 = svc.getUsageDetail({ page: 1, limit: 2 });
  record('detail: pagination limit', page1.items.length === 2 && page1.total === 4);
  const filterK1 = svc.getUsageDetail({ apiKeyId: k1.id });
  record('detail: filter by apiKey', filterK1.total === 3 && filterK1.items.every((i) => i.apiKeyId === k1.id));
  const filterErr = svc.getUsageDetail({ status: 'error' });
  record('detail: filter by status=error', filterErr.total === 1 && filterErr.items[0].status === 429);
  const filterStream = svc.getUsageDetail({ stream: true });
  record('detail: filter by stream', filterStream.total === 1 && filterStream.items[0].stream === true);
  const filterProv = svc.getUsageDetail({ providerId: 'nvidia' });
  record('detail: filter by provider', filterProv.total === 1 && filterProv.items[0].providerId === 'nvidia');

  // ---- isolation ----
  record('isolation: k1 usage excludes k2', filterK1.items.every((i) => i.apiKeyId !== k2.id));

  // ---- security: no secrets in any output ----
  const allJson = JSON.stringify([u1, u2, q, provs, models, sum, page1]);
  const rawKeyLeak = allJson.includes('sk-gw-');
  record('security: no raw key in analytics output', rawKeyLeak === false);
  record('security: detail entry has no key/keyHash/authorization', page1.items.every((i) => i.key === undefined && i.keyHash === undefined && i.authorization === undefined));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(60));
  console.log(`Usage Analytics — Unit: ${passed}/${results.length} passed, ${failed} failed`);
  console.log('='.repeat(60));
  if (failed > 0) {
    for (const r of results.filter((r) => !r.passed)) console.log('  FAIL: ' + r.name + ' — ' + (r.detail || ''));
    process.exit(1);
  }
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
