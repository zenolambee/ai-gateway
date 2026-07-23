/**
 * Unit tests for the RoutingRuleEngine and ModelAliasResolver.
 *
 * Run:  node examples/ruleEngine.unit.js
 */

const RoutingRuleEngine = require('../src/services/routingRuleEngine');
const { evaluateCondition, evaluateTest, buildFacts } = require('../src/services/routingRuleEngine');
const ModelAliasResolver = require('../src/services/modelAliasResolver');

require('../src/utils/logger').info = () => {};
require('../src/utils/logger').warn = () => {};
require('../src/utils/logger').error = () => {};

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

function makeProvider(id, opts = {}) {
  return { id, name: id, enabled: true, baseURL: 'http://localhost', supportedModels: ['m'], priority: opts.priority || 1, weight: opts.weight || 1 };
}

// ============================================================
// Rule Engine — condition evaluation
// ============================================================

function testEvaluateTest() {
  record('== match', evaluateTest({ '==': 5 }, 5));
  record('== no match', !evaluateTest({ '==': 5 }, 6));
  record('!= match', evaluateTest({ '!=': 5 }, 6));
  record('> match', evaluateTest({ '>': 3 }, 5));
  record('> no match', !evaluateTest({ '>': 5 }, 5));
  record('>= match', evaluateTest({ '>=': 5 }, 5));
  record('< match', evaluateTest({ '<': 5 }, 3));
  record('<= match', evaluateTest({ '<=': 5 }, 5));
  record('in match', evaluateTest({ 'in': [1, 2, 3] }, 2));
  record('in no match', !evaluateTest({ 'in': [1, 2] }, 3));
  record('not-in match', evaluateTest({ 'not-in': [1, 2] }, 3));
  record('scalar equality', evaluateTest(5, 5));
  record('scalar inequality', !evaluateTest(5, 6));
}

function testLeafCondition() {
  const facts = { provider: { latency: 5000 } };
  record('leaf condition match', evaluateCondition({ 'provider.latency': { '>': 3000 } }, facts));
  record('leaf condition no match', !evaluateCondition({ 'provider.latency': { '>': 6000 } }, facts));
}

function testAndCondition() {
  const facts = { provider: { latency: 5000, healthy: true } };
  record('AND both true', evaluateCondition({ and: [{ 'provider.latency': { '>': 3000 } }, { 'provider.healthy': true }] }, facts));
  record('AND one false', !evaluateCondition({ and: [{ 'provider.latency': { '>': 6000 } }, { 'provider.healthy': true }] }, facts));
}

function testOrCondition() {
  const facts = { provider: { latency: 5000, healthy: false } };
  record('OR one true', evaluateCondition({ or: [{ 'provider.latency': { '>': 3000 } }, { 'provider.healthy': true }] }, facts));
  record('OR both false', !evaluateCondition({ or: [{ 'provider.latency': { '>': 6000 } }, { 'provider.healthy': true }] }, facts));
}

function testNotCondition() {
  const facts = { provider: { healthy: false } };
  record('NOT true -> false', !evaluateCondition({ not: { 'provider.healthy': false } }, facts));
  record('NOT false -> true', evaluateCondition({ not: { 'provider.healthy': true } }, facts));
}

function testBuildFacts() {
  const provider = makeProvider('a', { priority: 2 });
  const health = { averageLatencyMs: 100, online: true, successRate: 95 };
  const keyHealth = { status: 'ACTIVE', stats: { successRate: 90, averageLatencyMs: 50, totalRequests: 10 } };
  const facts = buildFacts(provider, health, keyHealth);
  record('facts.provider.latency', facts.provider.latency === 100);
  record('facts.provider.healthy', facts.provider.healthy === true);
  record('facts.provider.successRate', facts.provider.successRate === 95);
  record('facts.provider.priority', facts.provider.priority === 2);
  record('facts.key.cooldown', facts.key.cooldown === false);
  record('facts.key.successRate', facts.key.successRate === 90);
  record('facts.key.latency', facts.key.latency === 50);
  record('facts.key.totalRequests', facts.key.totalRequests === 10);
}

// ============================================================
// Rule Engine — applyRules
// ============================================================

function testSkipRule() {
  const engine = new RoutingRuleEngine();
  engine.load([{ id: 'skip-high-lat', when: { 'provider.latency': { '>': 3000 } }, then: 'skip' }]);
  const candidates = [makeProvider('a'), makeProvider('b'), makeProvider('c')];
  const health = { a: { averageLatencyMs: 5000, online: true, successRate: 100 }, b: { averageLatencyMs: 100, online: true, successRate: 100 }, c: { averageLatencyMs: 200, online: true, successRate: 100 } };
  const out = engine.applyRules(candidates, { health });
  record('skip rule removes high-latency provider', out.length === 2 && !out.find((p) => p.id === 'a'), `out=${out.map(p=>p.id).join(',')}`);
}

function testPreferRule() {
  const engine = new RoutingRuleEngine();
  engine.load([{ id: 'prefer-fast', when: { 'provider.latency': { '<': 200 } }, then: 'prefer' }]);
  const candidates = [makeProvider('a'), makeProvider('b'), makeProvider('c')];
  const health = { a: { averageLatencyMs: 500, online: true, successRate: 100 }, b: { averageLatencyMs: 100, online: true, successRate: 100 }, c: { averageLatencyMs: 300, online: true, successRate: 100 } };
  const out = engine.applyRules(candidates, { health });
  record('prefer rule moves fast provider to front', out[0].id === 'b', `order=${out.map(p=>p.id).join(',')}`);
}

function testDemoteRule() {
  const engine = new RoutingRuleEngine();
  engine.load([{ id: 'demote-low-success', when: { 'provider.successRate': { '<': 80 } }, then: 'demote' }]);
  const candidates = [makeProvider('a'), makeProvider('b')];
  const health = { a: { averageLatencyMs: 100, online: true, successRate: 50 }, b: { averageLatencyMs: 100, online: true, successRate: 99 } };
  const out = engine.applyRules(candidates, { health });
  record('demote rule moves low-success to back', out[out.length - 1].id === 'a', `order=${out.map(p=>p.id).join(',')}`);
}

function testNoRules() {
  const engine = new RoutingRuleEngine();
  const candidates = [makeProvider('a'), makeProvider('b')];
  const out = engine.applyRules(candidates, {});
  record('no rules -> all candidates kept', out.length === 2, `len=${out.length}`);
}

function testSkipUnhealthy() {
  const engine = new RoutingRuleEngine();
  engine.load([{ id: 'skip-unhealthy', when: { 'provider.healthy': false }, then: 'skip' }]);
  const candidates = [makeProvider('a'), makeProvider('b')];
  const health = { a: { online: false, averageLatencyMs: 0, successRate: 0 }, b: { online: true, averageLatencyMs: 0, successRate: 100 } };
  const out = engine.applyRules(candidates, { health });
  record('skip unhealthy provider', out.length === 1 && out[0].id === 'b', `out=${out.map(p=>p.id).join(',')}`);
}

function testSetRule() {
  const engine = new RoutingRuleEngine();
  const ok = engine.setRule({ id: 'test', when: { 'provider.latency': { '>': 100 } }, then: 'skip' });
  record('setRule adds rule', ok && engine.listRules().length === 1);
  // Update existing
  engine.setRule({ id: 'test', when: { 'provider.latency': { '>': 200 } }, then: 'prefer' });
  record('setRule updates existing', engine.listRules()[0].then === 'prefer');
}

function testRemoveRule() {
  const engine = new RoutingRuleEngine();
  engine.load([{ id: 'x', when: { 'provider.latency': { '>': 100 } }, then: 'skip' }]);
  const removed = engine.removeRule('x');
  record('removeRule succeeds', removed && engine.listRules().length === 0);
  record('removeRule missing -> false', !engine.removeRule('nonexistent'));
}

function testCompoundRule() {
  const engine = new RoutingRuleEngine();
  engine.load([{
    id: 'skip-slow-and-unhealthy',
    when: { and: [{ 'provider.latency': { '>': 3000 } }, { 'provider.healthy': false }] },
    then: 'skip',
  }]);
  const candidates = [makeProvider('a'), makeProvider('b'), makeProvider('c')];
  const health = {
    a: { averageLatencyMs: 5000, online: false, successRate: 50 },
    b: { averageLatencyMs: 5000, online: true, successRate: 99 },
    c: { averageLatencyMs: 100, online: true, successRate: 99 },
  };
  const out = engine.applyRules(candidates, { health });
  // a should be skipped (slow AND unhealthy), b should be kept (slow but healthy)
  record('compound AND skips only matching', out.length === 2 && out.find((p) => p.id === 'b'), `out=${out.map(p=>p.id).join(',')}`);
}

// ============================================================
// ModelAliasResolver
// ============================================================

function testAliasResolve() {
  const resolver = new ModelAliasResolver();
  resolver.load({ aliases: { 'gpt-5': { models: ['gpt-5', 'gpt-4o'] } } });
  record('resolve known alias', resolver.resolve('gpt-5').join(',') === 'gpt-5,gpt-4o', `models=${resolver.resolve('gpt-5').join(',')}`);
  record('resolve unknown -> [input]', resolver.resolve('unknown-model')[0] === 'unknown-model');
  record('isAlias true for known', resolver.isAlias('gpt-5'));
  record('isAlias false for unknown', !resolver.isAlias('unknown-model'));
}

function testAliasSetRemove() {
  const resolver = new ModelAliasResolver();
  resolver.setAlias('claude', ['claude-3-5-sonnet']);
  record('setAlias works', resolver.resolve('claude')[0] === 'claude-3-5-sonnet');
  resolver.setAlias('claude', ['claude-3-opus']);
  record('setAlias updates', resolver.resolve('claude')[0] === 'claude-3-opus');
  const removed = resolver.removeAlias('claude');
  record('removeAlias succeeds', removed);
  record('removed alias not found', !resolver.isAlias('claude'));
}

function testAliasesForModel() {
  const resolver = new ModelAliasResolver();
  resolver.load({ aliases: { 'a1': { models: ['m1', 'm2'] }, 'a2': { models: ['m1'] } } });
  const aliases = resolver.aliasesForModel('m1').sort();
  record('aliasesForModel returns both', aliases.length === 2 && aliases.includes('a1') && aliases.includes('a2'), `aliases=${aliases.join(',')}`);
  record('aliasesForModel empty for unknown', resolver.aliasesForModel('nope').length === 0);
}

function testListAliases() {
  const resolver = new ModelAliasResolver();
  resolver.load({ aliases: { 'a': { models: ['m1'] }, 'b': { models: ['m2'] } } });
  const list = resolver.listAliases();
  record('listAliases returns all', Object.keys(list).length === 2);
  record('listAliases has models', Array.isArray(list.a.models) && list.a.models[0] === 'm1');
}

// ============================================================
// Main
// ============================================================

function main() {
  console.log('=== Rule Engine Unit Tests ===\n');
  testEvaluateTest();
  testLeafCondition();
  testAndCondition();
  testOrCondition();
  testNotCondition();
  testBuildFacts();

  console.log('\n=== Rule Engine applyRules ===\n');
  testSkipRule();
  testPreferRule();
  testDemoteRule();
  testNoRules();
  testSkipUnhealthy();
  testSetRule();
  testRemoveRule();
  testCompoundRule();

  console.log('\n=== ModelAliasResolver ===\n');
  testAliasResolve();
  testAliasSetRemove();
  testAliasesForModel();
  testListAliases();

  const failed = results.filter((r) => !r.passed);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length > 0) {
    console.error('FAILED TESTS:');
    failed.forEach((f) => console.error(`  - ${f.name}: ${f.detail}`));
    process.exit(1);
  }
}

main();
