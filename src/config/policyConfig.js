const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(process.cwd(), 'config', 'policies.json');

/**
 * Default policy configuration. Empty by default — when no policies are
 * configured the policy engine is a no-op (every request falls through to
 * the existing routing handled by ModelRouter + RoutingRuleEngine +
 * RoutingStrategy). Backward compatible out of the box.
 *
 * Each policy entry is keyed by `id` and carries:
 *
 *   {
 *     "id": "rainy-day-routing",
 *     "name": "Send EU users to EU region providers",
 *     "description": "(optional)",
 *     "enabled": true,
 *     "priority": 100,                    // lower = evaluated first
 *     "tags": ["prod", "eu"],             // optional, for grouping in dashboard
 *     "when": { ...conditions... },       // see PolicyEngine.evaluateCondition
 *     "then": { ...actions... },          // see PolicyEngine.ACTIONS
 *     "weight": 1,                       // optional, for weighted resolution
 *     "default": false,                  // optional: evaluated after all else
 *     "fallback": false,                 // optional: only when nothing else matches
 *   }
 *
 * Conditions and the variety of facts available are documented in
 * policyEngine.js — the config layer only enforces shape.
 */
const DEFAULT_CONFIG = {
  enabled: false,
  policies: [],
};

const VALID_DECISIONS = [
  // Routing
  'select_provider', 'select_api_key', 'select_virtual_model',
  'force_provider', 'force_model', 'redirect', 'reject',
  // Limits / approval
  'apply_rate_limit', 'apply_budget_limit', 'apply_quota', 'require_approval',
  // Observability
  'log_decision',
];

/**
 * Validate a policy config. Returns { valid, errors }.
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePolicyConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['policy config must be an object'] };
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    errors.push('policies.enabled must be boolean');
  }
  if (config.policies !== undefined) {
    if (!Array.isArray(config.policies)) {
      errors.push('policies.policies must be an array');
    } else {
      const seen = new Set();
      config.policies.forEach((p, i) => {
        const where = `policies.policies[${i}]`;
        if (!p || typeof p !== 'object') { errors.push(`${where}: must be an object`); return; }
        if (!p.id || typeof p.id !== 'string') { errors.push(`${where}.id: required string`); return; }
        if (seen.has(p.id)) { errors.push(`${where}.id: duplicate id "${p.id}"`); return; }
        seen.add(p.id);
        if (!p.name || typeof p.name !== 'string') errors.push(`${where}.name: required string`);
        if (p.description !== undefined && typeof p.description !== 'string') errors.push(`${where}.description: must be a string`);
        if (p.enabled !== undefined && typeof p.enabled !== 'boolean') errors.push(`${where}.enabled: must be boolean`);
        if (p.priority !== undefined && (typeof p.priority !== 'number' || !Number.isFinite(p.priority))) errors.push(`${where}.priority: must be a number`);
        if (p.weight !== undefined && (typeof p.weight !== 'number' || p.weight < 0 || !Number.isFinite(p.weight))) errors.push(`${where}.weight: must be a non-negative finite number`);
        if (p.default !== undefined && typeof p.default !== 'boolean') errors.push(`${where}.default: must be boolean`);
        if (p.fallback !== undefined && typeof p.fallback !== 'boolean') errors.push(`${where}.fallback: must be boolean`);
        if (p.tags !== undefined && !Array.isArray(p.tags)) errors.push(`${where}.tags: must be an array of strings`);
        if (!p.when || typeof p.when !== 'object') errors.push(`${where}.when: required object`);
        if (!p.then || typeof p.then !== 'object') errors.push(`${where}.then: required object`);
        if (p.then) {
          // The `then` field is a sparse map of allowed decisions; at least
          // one declared decision is required. Each decision may carry its
          // own argument object (e.g. { force_provider: { providerId: 'anthropic' } }
          // or simply { reject: true } / { reject: { reason: 'route_to_violation' } }).
          const decisions = Object.keys(p.then);
          if (decisions.length === 0) errors.push(`${where}.then: at least one decision required`);
          for (const d of decisions) {
            if (!VALID_DECISIONS.includes(d)) errors.push(`${where}.then.${d}: unknown decision (allowed: ${VALID_DECISIONS.join(', ')})`);
          }
          // Per-decision shape sanity for the most typed decisions.
          if (p.then.force_provider && (typeof p.then.force_provider !== 'object' || typeof p.then.force_provider.providerId !== 'string')) {
            errors.push(`${where}.then.force_provider: must be { providerId: string }`);
          }
          if (p.then.select_provider && (typeof p.then.select_provider !== 'object' || typeof p.then.select_provider.providerId !== 'string')) {
            errors.push(`${where}.then.select_provider: must be { providerId: string }`);
          }
          if (p.then.select_virtual_model && (typeof p.then.select_virtual_model !== 'object' || typeof p.then.select_virtual_model.modelId !== 'string')) {
            errors.push(`${where}.then.select_virtual_model: must be { modelId: string }`);
          }
          if (p.then.force_model && (typeof p.then.force_model !== 'object' || typeof p.then.force_model.modelId !== 'string')) {
            errors.push(`${where}.then.force_model: must be { modelId: string }`);
          }
          if (p.then.redirect && (typeof p.then.redirect !== 'object' || typeof p.then.redirect.url !== 'string')) {
            errors.push(`${where}.then.redirect: must be { url: string }`);
          }
          if (p.then.apply_rate_limit && typeof p.then.apply_rate_limit !== 'object') {
            errors.push(`${where}.then.apply_rate_limit: must be object`);
          }
          if (p.then.apply_budget_limit && typeof p.then.apply_budget_limit !== 'object') {
            errors.push(`${where}.then.apply_budget_limit: must be object`);
          }
          if (p.then.apply_quota && typeof p.then.apply_quota !== 'object') {
            errors.push(`${where}.then.apply_quota: must be object`);
          }
          if (p.then.require_approval && typeof p.then.require_approval !== 'object') {
            errors.push(`${where}.then.require_approval: must be object (e.g. { approver: 'admin' })`);
          }
        }
      });
    }
  }
  return { valid: errors.length === 0, errors };
}

function deepMerge(target, source) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function loadPolicyConfig(file) {
  const fileArg = file || process.env.POLICIES_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  let config = deepMerge(DEFAULT_CONFIG, {});
  if (fs.existsSync(fileArg)) {
    try {
      const raw = fs.readFileSync(fileArg, 'utf8');
      const parsed = JSON.parse(raw);
      config = deepMerge(config, parsed);
    } catch (err) { /* silent — keep defaults to preserve backward compat */ }
  }
  if (process.env.POLICY_ENABLED === 'true') config.enabled = true;
  else if (process.env.POLICY_ENABLED === 'false') config.enabled = false;
  return config;
}

function savePolicyConfig(config, file) {
  const fileArg = file || process.env.POLICIES_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  const { valid, errors } = validatePolicyConfig(config);
  if (!valid) return { ok: false, errors };
  const dir = path.dirname(fileArg);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fileArg}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, fileArg);
  return { ok: true };
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_FILE,
  VALID_DECISIONS,
  loadPolicyConfig,
  savePolicyConfig,
  validatePolicyConfig,
};
