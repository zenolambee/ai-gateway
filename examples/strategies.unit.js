/**
 * Unit tests for KeySelectionStrategy and RoutingStrategy.
 *
 * Run:  node examples/strategies.unit.js
 *
 * These tests exercise the strategy modules in isolation — no HTTP, no
 * Express, no side effects.
 */

const keyStrategy = require('../src/services/keySelectionStrategy');
const routingStrategy = require('../src/services/routingStrategy');

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

// Deterministic RNG for reproducible random/weighted tests
function makeRng(values) {
  let i = 0;
  return function() {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
}

function makeKeyRecord(value, opts = {}) {
  return {
    providerId: opts.providerId || 'p',
    value,
    status: 'ACTIVE',
    priority: opts.priority !== undefined ? opts.priority : 0,
    weight: opts.weight !== undefined ? opts.weight : 1,
    stats: {
      totalRequests: opts.totalRequests || 0,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      lastUsed: null,
      lastError: null,
      totalTokens: 0,
      latencySum: 0,
      latencyCount: 0,
      averageLatencyMs: 0,
      lastSuccess: null,
      lastFailure: null,
    },
    cooldownUntil: null,
  };
}

function makeProvider(id, opts = {}) {
  return {
    id,
    name: id,
    enabled: true,
    baseURL: 'http://localhost',
    supportedModels: opts.models || ['gpt-4o'],
    priority: opts.priority !== undefined ? opts.priority : 100,
    weight: opts.weight !== undefined ? opts.weight : 1,
    apiKeys: opts.apiKeys || [],
  };
}

// ============================================================
// KeySelectionStrategy
// ============================================================

function testKeyStrategyRegistry() {
  const ids = keyStrategy.listStrategies();
  record('built-in key strategies registered', ids.length >= 5, `ids=${ids.join(',')}`);
  record('round-robin is default', ids.includes('round-robin'));
  record('priority registered', ids.includes('priority'));
  record('random registered', ids.includes('random'));
  record('least-used registered', ids.includes('least-used'));
  record('weighted registered', ids.includes('weighted'));
}

function testKeyPriority() {
  const candidates = [
    makeKeyRecord('key-a', { priority: 5 }),
    makeKeyRecord('key-b', { priority: 1 }),
    makeKeyRecord('key-c', { priority: 3 }),
  ];
  const idx = keyStrategy.priorityStrategy(candidates, {});
  record('priority selects lowest priority', idx === 1, `idx=${idx}, value=${candidates[idx].value}`);
}

function testKeyRoundRobin() {
  const candidates = [makeKeyRecord('a'), makeKeyRecord('b'), makeKeyRecord('c')];
  const cursor = { lastIdx: -1, lastValue: null };
  const seq = [];
  for (let i = 0; i < 6; i += 1) {
    const idx = keyStrategy.roundRobinStrategy(candidates, cursor);
    seq.push(candidates[idx].value);
    cursor.lastIdx = idx;
    cursor.lastValue = candidates[idx].value;
  }
  record('round-robin cycles a,b,c,a,b,c',
    seq[0] === 'a' && seq[1] === 'b' && seq[2] === 'c' && seq[3] === 'a',
    `seq=${seq.join(',')}`);
}

function testKeyRandom() {
  const candidates = [makeKeyRecord('a'), makeKeyRecord('b'), makeKeyRecord('c')];
  const rng = makeRng([0.0, 0.5, 0.9]);
  const picks = [];
  for (let i = 0; i < 3; i += 1) {
    const idx = keyStrategy.randomStrategy(candidates, {}, { rng });
    picks.push(idx);
  }
  record('random uses provided rng', picks[0] === 0 && picks[1] === 1 && picks[2] === 2, `picks=${picks.join(',')}`);
}

function testKeyLeastUsed() {
  const candidates = [
    makeKeyRecord('a', { totalRequests: 10 }),
    makeKeyRecord('b', { totalRequests: 3 }),
    makeKeyRecord('c', { totalRequests: 7 }),
  ];
  const idx = keyStrategy.leastUsedStrategy(candidates, {});
  record('least-used picks minimum totalRequests', idx === 1, `idx=${idx}, value=${candidates[idx].value}`);
}

function testKeyWeighted() {
  const candidates = [
    makeKeyRecord('a', { weight: 1 }),
    makeKeyRecord('b', { weight: 9 }),
  ];
  // With weights 1:9 and a rng that returns 0.0..0.99, pick b ~90% of the time.
  // Use a rng that lands in b's bucket.
  const rng = makeRng([0.5]); // 0.5*10=5, after subtracting weight a(1) -> 4, still >0 -> b
  const idx = keyStrategy.weightedStrategy(candidates, {}, { rng });
  record('weighted picks high-weight key', idx === 1, `idx=${idx}, value=${candidates[idx].value}`);
}

function testKeyStrategyEmpty() {
  record('priority empty -> -1', keyStrategy.priorityStrategy([], {}) === -1);
  record('round-robin empty -> -1', keyStrategy.roundRobinStrategy([], {}) === -1);
  record('random empty -> -1', keyStrategy.randomStrategy([], {}) === -1);
  record('least-used empty -> -1', keyStrategy.leastUsedStrategy([], {}) === -1);
  record('weighted empty -> -1', keyStrategy.weightedStrategy([], {}) === -1);
}

function testKeyStrategySingle() {
  const c = [makeKeyRecord('only')];
  record('priority single -> 0', keyStrategy.priorityStrategy(c, {}) === 0);
  record('round-robin single -> 0', keyStrategy.roundRobinStrategy(c, {}) === 0);
  record('random single -> 0', keyStrategy.randomStrategy(c, {}) === 0);
  record('least-used single -> 0', keyStrategy.leastUsedStrategy(c, {}) === 0);
  record('weighted single -> 0', keyStrategy.weightedStrategy(c, {}) === 0);
}

function testKeyStrategyCustomRegistration() {
  let calls = 0;
  keyStrategy.register('custom-test', function(candidates) { calls += 1; return 0; });
  const fn = keyStrategy.getStrategy('custom-test');
  fn([makeKeyRecord('x')], {});
  record('custom strategy is callable', calls === 1, `calls=${calls}`);
}

// ============================================================
// RoutingStrategy
// ============================================================

function testRoutingRegistry() {
  const ids = routingStrategy.listStrategies();
  record('built-in routing strategies registered', ids.length >= 7, `ids=${ids.join(',')}`);
  record('priority is registered', ids.includes('priority'));
  record('fastest-response is registered', ids.includes('fastest-response'));
  record('lowest-latency is registered', ids.includes('lowest-latency'));
  record('round-robin is registered', ids.includes('round-robin'));
  record('least-used is registered', ids.includes('least-used'));
  record('weighted is registered', ids.includes('weighted'));
  record('random is registered', ids.includes('random'));
}

function testRoutingPriority() {
  const candidates = [
    makeProvider('a', { priority: 5 }),
    makeProvider('b', { priority: 1 }),
    makeProvider('c', { priority: 3 }),
  ];
  const out = routingStrategy.applyStrategy('priority', candidates, {});
  record('priority orders by lowest first', out[0].id === 'b' && out[1].id === 'c' && out[2].id === 'a', `order=${out.map(p=>p.id).join(',')}`);
  // input not mutated
  record('priority does not mutate input', candidates[0].id === 'a', `input[0]=${candidates[0].id}`);
}

function testRoutingFastestResponse() {
  const candidates = [
    makeProvider('a', { priority: 1 }),
    makeProvider('b', { priority: 2 }),
    makeProvider('c', { priority: 3 }),
  ];
  const health = {
    a: { averageLatencyMs: 200 },
    b: { averageLatencyMs: 50 },
    c: { averageLatencyMs: 100 },
  };
  const out = routingStrategy.applyStrategy('fastest-response', candidates, { health });
  record('fastest-response orders by latency', out[0].id === 'b' && out[1].id === 'c' && out[2].id === 'a', `order=${out.map(p=>p.id).join(',')}`);
}

function testRoutingFastestResponseFallback() {
  const candidates = [makeProvider('a', { priority: 1 }), makeProvider('b', { priority: 2 })];
  // No health data -> fall back to priority
  const out = routingStrategy.applyStrategy('fastest-response', candidates, { health: {} });
  record('fastest-response falls back to priority when no health', out[0].id === 'a', `order=${out.map(p=>p.id).join(',')}`);
}

function testRoutingLowestLatency() {
  const candidates = [
    makeProvider('a', { priority: 1 }),
    makeProvider('b', { priority: 2 }),
    makeProvider('c', { priority: 3 }),
  ];
  const health = {
    a: { p50LatencyMs: 150, averageLatencyMs: 200 },
    b: { p50LatencyMs: 30, averageLatencyMs: 50 },
    c: { p50LatencyMs: 90, averageLatencyMs: 100 },
  };
  const out = routingStrategy.applyStrategy('lowest-latency', candidates, { health });
  record('lowest-latency orders by p50', out[0].id === 'b' && out[1].id === 'c', `order=${out.map(p=>p.id).join(',')}`);
}

function testRoutingRoundRobin() {
  const candidates = [makeProvider('a', { priority: 1 }), makeProvider('b', { priority: 2 }), makeProvider('c', { priority: 3 })];
  const cursors = {};
  // First call: start=0 -> a,b,c
  const out1 = routingStrategy.applyStrategy('round-robin', candidates, { model: 'gpt-4o', cursors });
  // Second call: start=1 -> b,c,a
  const out2 = routingStrategy.applyStrategy('round-robin', candidates, { model: 'gpt-4o', cursors });
  // Third call: start=2 -> c,a,b
  const out3 = routingStrategy.applyStrategy('round-robin', candidates, { model: 'gpt-4o', cursors });
  record('round-robin rotates start',
    out1[0].id === 'a' && out2[0].id === 'b' && out3[0].id === 'c',
    `starts=${out1[0].id},${out2[0].id},${out3[0].id}`);
  record('round-robin preserves all candidates',
    out1.length === 3 && out2.length === 3 && out3.length === 3);
}

function testRoutingLeastUsed() {
  const candidates = [
    makeProvider('a', { priority: 1 }),
    makeProvider('b', { priority: 2 }),
    makeProvider('c', { priority: 3 }),
  ];
  const health = {
    a: { totalRequests: 100 },
    b: { totalRequests: 10 },
    c: { totalRequests: 50 },
  };
  const out = routingStrategy.applyStrategy('least-used', candidates, { health });
  record('least-used picks minimum totalRequests', out[0].id === 'b', `order=${out.map(p=>p.id).join(',')}`);
}

function testRoutingLeastUsedFallback() {
  const candidates = [makeProvider('a', { priority: 1 }), makeProvider('b', { priority: 2 })];
  const out = routingStrategy.applyStrategy('least-used', candidates, { health: {} });
  record('least-used falls back to priority when no usage', out[0].id === 'a', `order=${out.map(p=>p.id).join(',')}`);
}

function testRoutingWeighted() {
  const candidates = [
    makeProvider('a', { weight: 1 }),
    makeProvider('b', { weight: 99 }),
  ];
  // rng=0.5 -> total=100, r=50 -> subtract a(1) -> 49, still >0 -> b
  const out = routingStrategy.applyStrategy('weighted', candidates, { opts: { rng: makeRng([0.5]) } });
  record('weighted picks high-weight provider first', out[0].id === 'b', `order=${out.map(p=>p.id).join(',')}`);
  record('weighted returns all candidates', out.length === 2);
}

function testRoutingRandom() {
  const candidates = [makeProvider('a'), makeProvider('b'), makeProvider('c')];
  const out = routingStrategy.applyStrategy('random', candidates, { opts: { rng: makeRng([0.0, 0.5, 0.9]) } });
  record('random returns all candidates', out.length === 3);
  record('random uses provided rng (shuffled)', out.length === 3);
}

function testRoutingUnknownStrategyFallback() {
  const candidates = [makeProvider('a', { priority: 2 }), makeProvider('b', { priority: 1 })];
  // Unknown strategy -> applyStrategy falls back to priority (via try/catch)
  const out = routingStrategy.applyStrategy('does-not-exist', candidates, {});
  record('unknown strategy falls back to priority', out[0].id === 'b', `order=${out.map(p=>p.id).join(',')}`);
}

function testRoutingEmptyAndSingle() {
  record('empty input -> empty output', routingStrategy.applyStrategy('priority', [], {}).length === 0);
  const single = [makeProvider('a')];
  record('single candidate -> single output', routingStrategy.applyStrategy('priority', single, {}).length === 1);
}

// ============================================================
// Main
// ============================================================

function main() {
  console.log('=== KeySelectionStrategy Unit Tests ===\n');
  testKeyStrategyRegistry();
  testKeyPriority();
  testKeyRoundRobin();
  testKeyRandom();
  testKeyLeastUsed();
  testKeyWeighted();
  testKeyStrategyEmpty();
  testKeyStrategySingle();
  testKeyStrategyCustomRegistration();

  console.log('\n=== RoutingStrategy Unit Tests ===\n');
  testRoutingRegistry();
  testRoutingPriority();
  testRoutingFastestResponse();
  testRoutingFastestResponseFallback();
  testRoutingLowestLatency();
  testRoutingRoundRobin();
  testRoutingLeastUsed();
  testRoutingLeastUsedFallback();
  testRoutingWeighted();
  testRoutingRandom();
  testRoutingUnknownStrategyFallback();
  testRoutingEmptyAndSingle();

  const failed = results.filter((r) => !r.passed);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length > 0) {
    console.error('FAILED TESTS:');
    failed.forEach((f) => console.error(`  - ${f.name}: ${f.detail}`));
    process.exit(1);
  }
}

main();
