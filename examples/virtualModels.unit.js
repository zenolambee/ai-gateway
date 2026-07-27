/**
 * Unit tests for the Virtual Model Registry (Sprint 11).
 *
 * Run:  node examples/virtualModels.unit.js
 *
 * Exercises:
 *   - VirtualModelsConfig validation (valid + invalid shapes, strategies)
 *   - VirtualModelsConfig persistence (validate-before-save, atomic write)
 *   - VirtualModelRegistry load / register / isVirtualModel / get / list
 *   - VirtualModelRegistry runtime CRUD + setEnabled
 *   - VirtualModelRegistry.resolve() (real model ids for a virtual id)
 *   - VirtualModelRegistry.resolveCandidates() ordering for each selection
 *     strategy:
 *       priority, round-robin, lowest-latency, least-used, lowest-cost,
 *       highest-success-rate, weighted, random
 *   - Failover contract: only candidates of the SAME virtual model are ever
 *     returned (no cross-virtual-model leakage)
 *   - Disabled candidate / disabled provider / disabled virtual model handling
 *   - Backward compatibility: an unknown id resolves to [id] (passthrough)
 *
 * No HTTP, no Express. Pure in-memory with constructor-injected fakes.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// Silence logger
require('../src/utils/logger').info = () => {};
require('../src/utils/logger').warn = () => {};
require('../src/utils/logger').error = () => {};

const VirtualModelRegistry = require('../src/services/virtualModelRegistry');
const routingStrategy = require('../src/services/routingStrategy');
const {
  validateVirtualModelsConfig,
  saveVirtualModelsConfig,
  loadVirtualModelsConfig,
  SELECTION_STRATEGIES,
} = require('../src/config/virtualModelsConfig');

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}
const assert = (cond, name, detail) => record(name, !!cond, detail);
const eq = (actual, expected, name) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  record(name, ok, ok ? '' : `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
};

// ---------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------
function fakeProvider(id, opts = {}) {
  return {
    id,
    name: id,
    enabled: opts.enabled !== undefined ? opts.enabled : true,
    baseURL: 'https://' + id + '/v1',
    adapter: 'generic-openai',
    apiKeys: ['sk-' + id],
    supportedModels: opts.supportedModels || [id + '-model'],
    priority: opts.priority !== undefined ? opts.priority : 100,
    weight: opts.weight !== undefined ? opts.weight : 1,
  };
}

function fakeProviderManager(providers) {
  const enabled = providers.filter((p) => p.enabled);
  return {
    getEnabledProviders: () => enabled,
    providersById: new Map(providers.map((p) => [p.id, p])),
    listProviders: () => providers,
  };
}

function fakeHealth(health) {
  return { getAllHealth: () => health };
}

function deterministicRng(values) {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
}

// ============================================================
// 1. Config validation
// ============================================================

function testConfigValidation() {
  // Valid empty
  let r = validateVirtualModelsConfig({ virtualModels: {} });
  assert(r.valid, 'validation: empty virtualModels is valid', r.errors.join(';'));
  assert(Object.keys(r.config.virtualModels).length === 0, 'validation: empty config has no vms');

  // Valid full example with all 7 strategies
  r = validateVirtualModelsConfig({
    virtualModels: {
      'coding-fast': {
        enabled: true,
        strategy: 'priority',
        candidates: [
          { provider: 'nvidia', model: 'glm-5.2', priority: 1, weight: 1 },
          { provider: 'deepseek', model: 'deepseek-v3', priority: 2, weight: 1 },
          { provider: 'openrouter', model: 'qwen-coder', priority: 3, weight: 1 },
        ],
      },
    },
  });
  assert(r.valid, 'validation: example coding-fast is valid', r.errors.join(';'));
  eq(r.config.virtualModels['coding-fast'].candidates[0], { provider: 'nvidia', model: 'glm-5.2', priority: 1, weight: 1, enabled: true }, 'validation: candidate defaults (enabled=true) applied');

  // All 7 required strategies accepted
  const acceptable = ['priority', 'round-robin', 'lowest-latency', 'least-used', 'lowest-cost', 'highest-success-rate', 'weighted', 'random'];
  assert(SELECTION_STRATEGIES.length === acceptable.length, 'strategies: all required strategies registered', `got ${SELECTION_STRATEGIES.join(',')}`);
  for (const s of acceptable) {
    assert(SELECTION_STRATEGIES.includes(s), 'strategies: includes ' + s, SELECTION_STRATEGIES.join(','));
  }
  // Each acceptable strategy validates
  for (const s of acceptable) {
    const rr = validateVirtualModelsConfig({ virtualModels: { vm: { strategy: s, candidates: [{ provider: 'p', model: 'm' }] } } });
    assert(rr.valid, 'validation: strategy ' + s + ' accepted', rr.errors.join(';'));
  }

  // Rejects unknown strategy
  r = validateVirtualModelsConfig({ virtualModels: { vm: { strategy: 'magic', candidates: [{ provider: 'p', model: 'm' }] } } });
  assert(!r.valid && /magic.*is not supported/.test(r.errors.join(';')), 'validation: unknown strategy rejected', r.errors.join(';'));

  // Rejects empty candidates
  r = validateVirtualModelsConfig({ virtualModels: { vm: { candidates: [] } } });
  assert(!r.valid && /at least one candidate/.test(r.errors.join(';')), 'validation: empty candidates rejected', r.errors.join(';'));

  // Rejects candidate without provider/model
  r = validateVirtualModelsConfig({ virtualModels: { vm: { candidates: [{ provider: 'p', model: '' }] } } });
  assert(!r.valid && /model is required/.test(r.errors.join(';')), 'validation: candidate missing model rejected', r.errors.join(';'));

  // Non-object root rejected
  r = validateVirtualModelsConfig('nope');
  assert(!r.valid, 'validation: non-object root rejected', r.errors.join(';'));

  // enabled must be a boolean (non-boolean rejects the entry)
  r = validateVirtualModelsConfig({ virtualModels: { vm: { enabled: 1, candidates: [{ provider: 'p', model: 'm' }] } } });
  assert(!r.valid, 'validation: non-boolean enabled rejected', r.errors.join(';'));
  // default enabled = true when omitted
  r = validateVirtualModelsConfig({ virtualModels: { vm: { candidates: [{ provider: 'p', model: 'm' }] } } });
  assert(r.valid && r.config.virtualModels.vm.enabled === true, 'validation: enabled defaults to true');

  // duplicate candidate de-duplicated (warning, kept first)
  r = validateVirtualModelsConfig({ virtualModels: { vm: { candidates: [
    { provider: 'p', model: 'm' }, { provider: 'p', model: 'm' },
  ] } } });
  assert(r.valid, 'validation: duplicate candidate keeps first', r.errors.join(';'));
  assert(r.config.virtualModels.vm.candidates.length === 1, 'validation: duplicate candidate deduped', 'count=' + r.config.virtualModels.vm.candidates.length);
  assert(r.warnings.length >= 1, 'validation: duplicate candidate warns', r.warnings.join(';'));
}

// ============================================================
// 2. Config persistence
// ============================================================

function testConfigPersistence() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-cfg-'));
  const file = path.join(dir, 'virtualModels.json');

  // Save a valid config
  const cfg = { virtualModels: { vm1: { enabled: true, strategy: 'priority', candidates: [{ provider: 'p', model: 'm', priority: 1, weight: 1 }] } } };
  const sv = saveVirtualModelsConfig(cfg, file);
  assert(sv.success, 'persist: valid save succeeds', sv.errors.join(';'));
  assert(fs.existsSync(file), 'persist: file written');
  // Load回来的 round-trips
  const loaded = loadVirtualModelsConfig(file);
  eq(Object.keys(loaded.virtualModels), ['vm1'], 'persist: round-trips id');
  eq(loaded.virtualModels.vm1.candidates[0].model, 'm', 'persist: candidate model round-trips');

  // Invalid save: nothing written, file unchanged
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const sv2 = saveVirtualModelsConfig({ virtualModels: { bad: { candidates: [] } } }, file);
  assert(!sv2.success, 'persist: invalid save rejected', sv2.errors.join(';'));
  const after = fs.readFileSync(file, 'utf8');
  eq(after, before, 'persist: invalid save leaves file unchanged');

  // Save to a non-existent dir creates it
  const nestedFile = path.join(dir, 'nested', 'vm.json');
  const sv3 = saveVirtualModelsConfig(cfg, nestedFile);
  assert(sv3.success && fs.existsSync(nestedFile), 'persist: creates nested dir', sv3.errors.join(';'));

  fs.rmSync(dir, { recursive: true, force: true });
}

// ============================================================
// 3. Registry load + introspection
// ============================================================

function testRegistryLoad() {
  const pm = fakeProviderManager([fakeProvider('pA'), fakeProvider('pB'), fakeProvider('pC')]);
  const reg = new VirtualModelRegistry({ providerManager: pm });
  reg.load({ virtualModels: {
    'coding-fast': { enabled: true, strategy: 'priority', candidates: [
      { provider: 'pA', model: 'glm-5.2', priority: 1 },
      { provider: 'pB', model: 'deepseek-v3', priority: 2 },
      { provider: 'pC', model: 'qwen-coder', priority: 3 },
    ] },
    'disabled-vm': { enabled: false, strategy: 'priority', candidates: [{ provider: 'pA', model: 'glm-5.2' }] },
  } });

  assert(reg.isVirtualModel('coding-fast'), 'registry: isVirtualModel true for enabled vm');
  assert(!reg.isVirtualModel('disabled-vm'), 'registry: isVirtualModel false for disabled vm');
  assert(!reg.isVirtualModel('nope'), 'registry: isVirtualModel false for unknown');

  assert(reg.listVirtualModels().length === 2, 'registry: listVirtualModels returns both', 'count=' + reg.listVirtualModels().length);
  assert(reg.getVirtualModel('coding-fast').candidates.length === 3, 'registry: getVirtualModel returns candidates');

  // reverse map
  eq(reg.virtualModelsForRealModel('glm-5.2').sort(), ['coding-fast', 'disabled-vm'], 'registry: reverse map for real model');

  // unknown id passthrough on resolve()
  eq(reg.resolve('nope'), ['nope'], 'registry: resolve passthrough for unknown id');
  // virtual model resolves to real model ids
  eq(reg.resolve('coding-fast'), ['glm-5.2', 'deepseek-v3', 'qwen-coder'], 'registry: resolve returns real model ids');
}

// ============================================================
// 4. Registry runtime CRUD
// ============================================================

function testRegistryCrud() {
  const pm = fakeProviderManager([fakeProvider('pA'), fakeProvider('pB')]);
  const reg = new VirtualModelRegistry({ providerManager: pm });
  reg.load({ virtualModels: {} });

  // Create via setVirtualModel
  const meta = {};
  let ok = reg.setVirtualModel('vm1', { enabled: true, strategy: 'round-robin', candidates: [{ provider: 'pA', model: 'm1', priority: 1, weight: 1 }] }, meta);
  assert(ok && reg.isVirtualModel('vm1'), 'crud: setVirtualModel creates', meta.errors && meta.errors.join(';'));

  // Invalid create
  meta.errors = []; meta.warnings = [];
  ok = reg.setVirtualModel('bad', { candidates: [] }, meta);
  assert(!ok && meta.errors.length > 0, 'crud: setVirtualModel rejects invalid', meta.errors.join(';'));

  // Update (replace) existing
  ok = reg.setVirtualModel('vm1', { enabled: true, strategy: 'priority', candidates: [{ provider: 'pB', model: 'm2', priority: 1 }] }, meta);
  assert(ok, 'crud: setVirtualModel replaces', meta.errors && meta.errors.join(';'));
  eq(reg.getVirtualModel('vm1').candidates[0].model, 'm2', 'crud: replace updates candidate');

  // toggle enable/disable
  ok = reg.setEnabled('vm1', false);
  assert(ok && !reg.isVirtualModel('vm1'), 'crud: setEnabled(false) disables');
  ok = reg.setEnabled('vm1', true);
  assert(ok && reg.isVirtualModel('vm1'), 'crud: setEnabled(true) re-enables');
  assert(!reg.setEnabled('ghost', true), 'crud: setEnabled on unknown returns false');

  // delete
  ok = reg.removeVirtualModel('vm1');
  assert(ok && !reg.getVirtualModel('vm1'), 'crud: removeVirtualModel removes');
  assert(!reg.removeVirtualModel('vm1'), 'crud: removeVirtualModel twice returns false');
}

// ============================================================
// 5. resolveCandidates() per strategy
// ============================================================

function testResolveCandidatesStrategies() {
  const pA = fakeProvider('pA', { priority: 1 });
  const pB = fakeProvider('pB', { priority: 2 });
  const pC = fakeProvider('pC', { priority: 3 });
  const pm = fakeProviderManager([pA, pB, pC]);

  function registryWith(vm) {
    const r = new VirtualModelRegistry({ providerManager: pm, healthMonitor: fakeHealth({}) });
    r.load({ virtualModels: { ['vm']: vm } });
    return r;
  }

  const cands = [
    { provider: 'pA', model: 'a', priority: 1, weight: 1, enabled: true },
    { provider: 'pB', model: 'b', priority: 2, weight: 1, enabled: true },
    { provider: 'pC', model: 'c', priority: 3, weight: 1, enabled: true },
  ];

  // priority
  let r = registryWith({ enabled: true, strategy: 'priority', candidates: cands });
  let ordered = r.resolveCandidates('vm').map((p) => p.id);
  eq(ordered, ['pA', 'pB', 'pC'], 'candidates(priority): ordered by priority asc');

  // round-robin: successive calls rotate the start
  r = registryWith({ enabled: true, strategy: 'round-robin', candidates: cands });
  const rr1 = r.resolveCandidates('vm').map((p) => p.id);
  const rr2 = r.resolveCandidates('vm').map((p) => p.id);
  assert(rr1[0] === 'pA' && rr2[0] === 'pB', 'candidates(round-robin): rotates starting provider', `rr1=${rr1.join(',')} rr2=${rr2.join(',')}`);
  assert(rr1.join(',') !== rr2.join(','), 'candidates(round-robin): produces different orders');

  // lowest-latency (requires health)
  r = new VirtualModelRegistry({
    providerManager: pm,
    healthMonitor: fakeHealth({ pA: { averageLatencyMs: 300 }, pB: { averageLatencyMs: 100 }, pC: { averageLatencyMs: 200 } }),
  });
  r.load({ virtualModels: { vm: { enabled: true, strategy: 'lowest-latency', candidates: cands } } });
  ordered = r.resolveCandidates('vm').map((p) => p.id);
  eq(ordered, ['pB', 'pC', 'pA'], 'candidates(lowest-latency): ordered by averageLatencyMs asc');

  // least-used
  r = new VirtualModelRegistry({
    providerManager: pm,
    healthMonitor: fakeHealth({ pA: { totalRequests: 50 }, pB: { totalRequests: 5 }, pC: { totalRequests: 20 } }),
  });
  r.load({ virtualModels: { vm: { enabled: true, strategy: 'least-used', candidates: cands } } });
  ordered = r.resolveCandidates('vm').map((p) => p.id);
  eq(ordered, ['pB', 'pC', 'pA'], 'candidates(least-used): ordered by totalRequests asc');

  // lowest-cost (candidate carries cost via provider spread; here provider.cost)
  const pAl = { ...fakeProvider('pA', { priority: 1 }), cost: 3 };
  const pBl = { ...fakeProvider('pB', { priority: 2 }), cost: 1 };
  const pCl = { ...fakeProvider('pC', { priority: 3 }), cost: 2 };
  const pmc = fakeProviderManager([pAl, pBl, pCl]);
  r = new VirtualModelRegistry({ providerManager: pmc, healthMonitor: fakeHealth({}) });
  r.load({ virtualModels: { vm: { enabled: true, strategy: 'lowest-cost', candidates: cands } } });
  ordered = r.resolveCandidates('vm').map((p) => p.id);
  eq(ordered, ['pB', 'pC', 'pA'], 'candidates(lowest-cost): ordered by cost asc');
  // falls back to priority when no cost data
  r = new VirtualModelRegistry({ providerManager: pm, healthMonitor: fakeHealth({}) });
  r.load({ virtualModels: { vm: { enabled: true, strategy: 'lowest-cost', candidates: cands } } });
  ordered = r.resolveCandidates('vm').map((p) => p.id);
  eq(ordered, ['pA', 'pB', 'pC'], 'candidates(lowest-cost no data): falls back to priority');

  // highest-success-rate
  r = new VirtualModelRegistry({
    providerManager: pm,
    healthMonitor: fakeHealth({ pA: { successRate: 95 }, pB: { successRate: 99 }, pC: { successRate: 80 } }),
  });
  r.load({ virtualModels: { vm: { enabled: true, strategy: 'highest-success-rate', candidates: cands } } });
  ordered = r.resolveCandidates('vm').map((p) => p.id);
  eq(ordered, ['pB', 'pA', 'pC'], 'candidates(highest-success-rate): ordered by successRate desc');

  // weighted: deterministic via injected RNG through routingStrategy.applyStrategy
  // We test that the result still contains all three candidates exactly once.
  r = registryWith({ enabled: true, strategy: 'weighted', candidates: cands });
  ordered = r.resolveCandidates('vm').map((p) => p.id);
  assert(ordered.length === 3, 'candidates(weighted): returns 3 unique', 'got ' + ordered.join(','));
  eq(ordered.slice().sort(), ['pA', 'pB', 'pC'], 'candidates(weighted): all candidates present once');

  // random: returns all three unique
  r = registryWith({ enabled: true, strategy: 'random', candidates: cands });
  ordered = r.resolveCandidates('vm').map((p) => p.id);
  assert(ordered.length === 3, 'candidates(random): returns 3 unique');
  eq(ordered.slice().sort(), ['pA', 'pB', 'pC'], 'candidates(random): all candidates present once');

  // unknown strategy falls back to priority
  r = registryWith({ enabled: true, strategy: 'nonexistent', candidates: cands });
  ordered = r.resolveCandidates('vm').map((p) => p.id);
  eq(ordered, ['pA', 'pB', 'pC'], 'candidates(unknown strategy): falls back to priority');
}

// ============================================================
// 6. resolveCandidates() filtering + failover contract
// ============================================================

function testFilteringAndFailoverContract() {
  const pA = fakeProvider('pA', { enabled: true });
  const pB = fakeProvider('pB', { enabled: true });
  const pD = fakeProvider('pD', { enabled: false });
  const pm = fakeProviderManager([pA, pB, pD]);

  const reg = new VirtualModelRegistry({ providerManager: pm, healthMonitor: fakeHealth({}) });
  reg.load({ virtualModels: {
    'vm': { enabled: true, strategy: 'priority', candidates: [
      { provider: 'pA', model: 'a', priority: 1, enabled: true },
      { provider: 'pD', model: 'd', priority: 2, enabled: true }, // disabled provider
      { provider: 'unknown', model: 'x', priority: 3, enabled: true }, // unknown provider
    ] },
  } });

  const ordered = reg.resolveCandidates('vm').map((p) => p.id);
  eq(ordered, ['pA'], 'filtering: disabled + unknown providers dropped', 'got ' + ordered.join(','));

  // Disabled candidate dropped even if provider is enabled
  const reg2 = new VirtualModelRegistry({ providerManager: pm, healthMonitor: fakeHealth({}) });
  reg2.load({ virtualModels: { vm: { enabled: true, strategy: 'priority', candidates: [
    { provider: 'pA', model: 'a', priority: 1, enabled: false },
    { provider: 'pB', model: 'b', priority: 2, enabled: true },
  ] } } });
  eq(reg2.resolveCandidates('vm').map((p) => p.id), ['pB'], 'filtering: disabled candidate dropped');

  // Backward-compat: getCandidateProviders('real-model-id') returns []
  assert(reg.resolveCandidates('not-a-vm').length === 0, 'filtering: unknown vm returns empty candidates');

  // Candidates carry real model id (per-provider target)
  const reg3 = new VirtualModelRegistry({ providerManager: pm, healthMonitor: fakeHealth({}) });
  reg3.load({ virtualModels: { vm: { enabled: true, strategy: 'priority', candidates: [
    { provider: 'pA', model: 'real-a', priority: 1 },
    { provider: 'pB', model: 'real-b', priority: 2 },
  ] } } });
  const cands3 = reg3.resolveCandidates('vm');
  eq(cands3[0].__virtualModelTarget.model, 'real-a', 'failover: candidate0 carries real-a target');
  eq(cands3[0].__virtualModelId, 'vm', 'failover: candidate0 carries virtual id for metrics');
  eq(cands3[1].__virtualModelTarget.model, 'real-b', 'failover: candidate1 carries real-b target');

  // Cross-virtual-model leakage check: another virtual model 'vm2' never
  // appears as a candidate of 'vm' — enforced because resolveCandidates
  // only iterates vm.candidates.
  const reg4 = new VirtualModelRegistry({ providerManager: pm, healthMonitor: fakeHealth({}) });
  reg4.load({ virtualModels: {
    'vm': { enabled: true, strategy: 'priority', candidates: [{ provider: 'pA', model: 'a', priority: 1 }] },
    'vm2': { enabled: true, strategy: 'priority', candidates: [{ provider: 'pB', model: 'b', priority: 1 }] },
  } });
  const vmCands = reg4.resolveCandidates('vm').map((p) => p.id);
  eq(vmCands, ['pA'], 'failover contract: vm candidates never include vm2 providers');
  // And the executor would iterate ONLY these — model-aware failover preserved.
}

// ============================================================
// Runner
// ============================================================

function run() {
  testConfigValidation();
  testConfigPersistence();
  testRegistryLoad();
  testRegistryCrud();
  testResolveCandidatesStrategies();
  testFilteringAndFailoverContract();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Virtual Models — Unit: ${passed}/${results.length} passed, ${failed} failed`);
  if (failed > 0) {
    results.filter((r) => !r.passed).forEach((r) => console.log('  FAIL: ' + r.name + (r.detail ? ' — ' + r.detail : '')));
    process.exitCode = 1;
  }
}

run();
