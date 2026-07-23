const logger = require('../utils/logger');

/**
 * RoutingRuleEngine
 *
 * Evaluates routing rules against a routing context (provider, api key,
 * model, health, latency) and returns a list of actions — most commonly
 * "skip" (skip this candidate) or "prefer" (move this candidate to the
 * front). Rules are defined in a declarative JSON shape so they can be
 * persisted and hot-reloaded.
 *
 * Rule shape:
 *   {
 *     "id": "skip-high-latency",
 *     "description": "Skip providers with latency > 3000ms",
 *     "when": { "provider.latency": { ">": 3000 } },
 *     "then": "skip"
 *   }
 *
 *   {
 *     "id": "skip-cooldown-keys",
 *     "when": { "key.cooldown": true },
 *     "then": "skip"
 *   }
 *
 *   {
 *     "id": "skip-unhealthy",
 *     "when": { "provider.healthy": false },
 *     "then": "skip"
 *   }
 *
 * Compound conditions (AND / OR / NOT):
 *   { "when": { "and": [ { "provider.latency": { ">": 3000 } }, { "provider.healthy": true } ] } }
 *   { "when": { "or":  [ { "key.cooldown": true }, { "key.successRate": { "<": 50 } } ] } }
 *   { "when": { "not": { "provider.healthy": true } } }
 *
 * Supported facts (read from the routing context):
 *   - provider.latency       : number (averageLatencyMs)
 *   - provider.healthy      : boolean (circuit closed)
 *   - provider.successRate   : number (0-100)
 *   - provider.priority      : number
 *   - provider.weight        : number
 *   - key.cooldown           : boolean
 *   - key.successRate        : number (0-100)
 *   - key.latency            : number (averageLatencyMs)
 *   - key.totalRequests      : number
 *
 * Supported operators: ==, !=, >, >=, <, <=, in, not-in
 *
 * Actions: "skip" (exclude candidate), "prefer" (move to front), "demote" (move to back)
 */

const ACTIONS = new Set(['skip', 'prefer', 'demote', 'allow']);

/**
 * Evaluate a single condition against a fact context.
 * @param {object} cond - { [factPath]: { [op]: value } } or { and|or|not: ... }
 * @param {object} facts - { provider: {...}, key: {...} }
 * @returns {boolean}
 */
function evaluateCondition(cond, facts) {
  if (!cond || typeof cond !== 'object') return true;

  // Compound: AND
  if (Array.isArray(cond.and)) {
    return cond.and.every((c) => evaluateCondition(c, facts));
  }
  // Compound: OR
  if (Array.isArray(cond.or)) {
    return cond.or.some((c) => evaluateCondition(c, facts));
  }
  // Compound: NOT
  if (cond.not !== undefined) {
    return !evaluateCondition(cond.not, facts);
  }

  // Leaf: { "fact.path": { op: value } }
  for (const [factPath, test] of Object.entries(cond)) {
    const factValue = getFact(factPath, facts);
    if (!evaluateTest(test, factValue)) return false;
  }
  return true;
}

/**
 * Read a dotted fact path from the facts object.
 * @param {string} path - e.g. "provider.latency"
 * @param {object} facts
 * @returns {*}
 */
function getFact(path, facts) {
  const parts = String(path).split('.');
  let cur = facts;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Evaluate a test object against a fact value.
 * @param {object|string|number|boolean} test
 * @param {*} factValue
 * @returns {boolean}
 */
function evaluateTest(test, factValue) {
  if (test === null || test === undefined || typeof test !== 'object' || Array.isArray(test)) {
    return factValue === test;
  }
  for (const [op, operand] of Object.entries(test)) {
    switch (op) {
      case '==': if (factValue !== operand) return false; break;
      case '!=': if (factValue === operand) return false; break;
      case '>':  if (!(typeof factValue === 'number' && factValue > operand)) return false; break;
      case '>=': if (!(typeof factValue === 'number' && factValue >= operand)) return false; break;
      case '<':  if (!(typeof factValue === 'number' && factValue < operand)) return false; break;
      case '<=': if (!(typeof factValue === 'number' && factValue <= operand)) return false; break;
      case 'in': if (!Array.isArray(operand) || !operand.includes(factValue)) return false; break;
      case 'not-in': if (!Array.isArray(operand) || operand.includes(factValue)) return false; break;
      default: return false;
    }
  }
  return true;
}

/**
 * Build the facts object for a candidate provider + optional key.
 * @param {object} provider - provider config
 * @param {object} health - provider health snapshot (from healthMonitor)
 * @param {object} [keyHealth] - per-key health (from apiKeyManager)
 * @returns {object}
 */
function buildFacts(provider, health, keyHealth) {
  return {
    provider: {
      id: provider ? provider.id : undefined,
      latency: health ? health.averageLatencyMs : 0,
      healthy: health ? health.online : true,
      successRate: health ? health.successRate : 100,
      priority: provider ? provider.priority : 0,
      weight: provider ? provider.weight : 1,
    },
    key: keyHealth ? {
      cooldown: keyHealth.status === 'COOLDOWN' || keyHealth.status === 'RATE_LIMITED',
      successRate: keyHealth.stats ? keyHealth.stats.successRate : 100,
      latency: keyHealth.stats ? keyHealth.stats.averageLatencyMs : 0,
      totalRequests: keyHealth.stats ? keyHealth.stats.totalRequests : 0,
    } : {
      cooldown: false,
      successRate: 100,
      latency: 0,
      totalRequests: 0,
    },
  };
}

/**
 * RoutingRuleEngine
 *
 * Holds a list of routing rules and evaluates them against candidates. A
 * rule with action "skip" excludes a candidate; "prefer" moves it to the
 * front; "demote" moves it to the back; "allow" keeps it.
 */
class RoutingRuleEngine {
  constructor() {
    this.rules = [];
  }

  /**
   * Load rules from an array of rule definitions.
   * @param {Array<object>} rules
   */
  load(rules) {
    this.rules = [];
    if (!Array.isArray(rules)) return;
    for (const r of rules) {
      if (r && r.id && r.when && r.then && ACTIONS.has(r.then)) {
        this.rules.push({ id: r.id, description: r.description || '', when: r.when, then: r.then });
      }
    }
    logger.info('RoutingRuleEngine initialized', { rules: this.rules.length });
  }

  /**
   * Add or update a single rule at runtime (admin API).
   * @param {object} rule
   */
  setRule(rule) {
    if (!rule || !rule.id || !rule.when || !rule.then || !ACTIONS.has(rule.then)) return false;
    const idx = this.rules.findIndex((r) => r.id === rule.id);
    const entry = {
      id: rule.id,
      description: rule.description || '',
      when: rule.when,
      then: rule.then,
    };
    if (idx >= 0) this.rules[idx] = entry;
    else this.rules.push(entry);
    return true;
  }

  /**
   * Remove a rule by id.
   * @param {string} id
   */
  removeRule(id) {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  /**
   * Return all rules (for admin API).
   * @returns {Array<object>}
   */
  listRules() {
    return this.rules.map((r) => ({ ...r }));
  }

  /**
   * Apply the rules to a list of candidate providers. Returns a new
   * ordered + filtered array. Candidates that match a "skip" rule are
   * removed; "prefer" candidates move to the front; "demote" move to
   * the back. Rules are evaluated in order; the first matching rule
   * determines the action for each candidate.
   *
   * @param {Array<object>} candidates - provider configs
   * @param {object} ctx
   * @param {object} [ctx.health] - providerId -> health snapshot
   * @param {object} [ctx.keyHealth] - providerId -> [keyHealth]
   * @returns {Array<object>} filtered + ordered candidates
   */
  applyRules(candidates, ctx = {}) {
    if (this.rules.length === 0 || !Array.isArray(candidates) || candidates.length === 0) {
      return candidates ? [...candidates] : [];
    }
    const health = ctx.health || {};
    const keyHealth = ctx.keyHealth || {};

    const kept = [];
    const preferred = [];
    const demoted = [];

    for (const provider of candidates) {
      const ph = health[provider.id] || null;
      // Use the first key's health for this provider (good enough for
      // rule evaluation; the executor does per-key selection later).
      const kh = keyHealth[provider.id] && keyHealth[provider.id][0] ? keyHealth[provider.id][0] : null;
      const facts = buildFacts(provider, ph, kh);

      let action = 'allow';
      for (const rule of this.rules) {
        if (evaluateCondition(rule.when, facts)) {
          action = rule.then;
          break; // first match wins
        }
      }

      if (action === 'skip') continue;
      if (action === 'prefer') preferred.push(provider);
      else if (action === 'demote') demoted.push(provider);
      else kept.push(provider);
    }

    return [...preferred, ...kept, ...demoted];
  }
}

module.exports = RoutingRuleEngine;
module.exports.evaluateCondition = evaluateCondition;
module.exports.evaluateTest = evaluateTest;
module.exports.buildFacts = buildFacts;
