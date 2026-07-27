const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(process.cwd(), 'config', 'quotas.json');

/**
 * Default quota policy config. Empty by default — the gateway runs with
 * no quota enforcement until a policy is defined. This is IN ADDITION to
 * the existing rateLimiter (which still handles per-key daily request /
 * token quotas for backwards compatibility). This service covers the
 * richer dimension matrix required by Sprint 12:
 *
 *   scope  : 'api_key' | 'provider' | 'virtual_model' | 'user' | 'organization' | 'project'
 *   limit  : 'requests' | 'input_tokens' | 'output_tokens' | 'total_tokens' | 'cost'
 *   window : 'daily' | 'weekly' | 'monthly'
 *   action : 'reject' | 'switch_api_key' | 'switch_provider' | 'switch_virtual_model' | 'continue' | 'notify'
 *
 * Each quota policy entry is keyed by id and is matched against incoming
 * requests via its (scope, scopeId) pair.
 */
const DEFAULT_CONFIG = {
  enabled: false,
  policies: [], // [{ id, name, scope, scopeId?, limit, window, value, action, notifyTo? }]
};

const VALID_SCOPES = ['api_key', 'provider', 'virtual_model', 'user', 'organization', 'project'];
const VALID_LIMITS = ['requests', 'input_tokens', 'output_tokens', 'total_tokens', 'cost'];
const VALID_WINDOWS = ['daily', 'weekly', 'monthly'];
const VALID_ACTIONS = ['reject', 'switch_api_key', 'switch_provider', 'switch_virtual_model', 'continue', 'notify'];

function validateQuotaConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['quota config must be an object'] };
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    errors.push('quotas.enabled must be boolean');
  }
  if (config.policies !== undefined) {
    if (!Array.isArray(config.policies)) {
      errors.push('quotas.policies must be an array');
    } else {
      const seen = new Set();
      config.policies.forEach((p, i) => {
        if (!p || typeof p !== 'object') { errors.push(`quotas.policies[${i}]: must be object`); return; }
        if (!p.id || typeof p.id !== 'string') { errors.push(`quotas.policies[${i}].id: required string`); return; }
        if (seen.has(p.id)) { errors.push(`quotas.policies[${i}].id: duplicate id`); return; }
        seen.add(p.id);
        if (!p.name || typeof p.name !== 'string') errors.push(`quotas.policies[${i}].name: required string`);
        if (!VALID_SCOPES.includes(p.scope)) errors.push(`quotas.policies[${i}].scope: must be one of ${VALID_SCOPES.join('|')}`);
        if (p.scope && p.scope !== 'api_key' && p.scope !== 'provider' && p.scope !== 'virtual_model' && !p.scopeId) {
          errors.push(`quotas.policies[${i}].scopeId: required when scope="${p.scope}"`);
        }
        if (!VALID_LIMITS.includes(p.limit)) errors.push(`quotas.policies[${i}].limit: must be one of ${VALID_LIMITS.join('|')}`);
        if (!VALID_WINDOWS.includes(p.window)) errors.push(`quotas.policies[${i}].window: must be one of ${VALID_WINDOWS.join('|')}`);
        if (typeof p.value !== 'number' || p.value < 0 || !Number.isFinite(p.value)) errors.push(`quotas.policies[${i}].value: must be a non-negative finite number`);
        if (p.action !== undefined && !VALID_ACTIONS.includes(p.action)) errors.push(`quotas.policies[${i}].action: must be one of ${VALID_ACTIONS.join('|')}`);
        if (p.notifyTo !== undefined && typeof p.notifyTo !== 'string') errors.push(`quotas.policies[${i}].notifyTo: must be string`);
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

function loadQuotaConfig(file) {
  const fileArg = file || process.env.QUOTAS_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  let config = deepMerge(DEFAULT_CONFIG, {});
  if (fs.existsSync(fileArg)) {
    try {
      const raw = fs.readFileSync(fileArg, 'utf8');
      const parsed = JSON.parse(raw);
      config = deepMerge(config, parsed);
    } catch (err) { /* silent — keep defaults */ }
  }
  if (process.env.QUOTA_ENABLED === 'true') config.enabled = true;
  else if (process.env.QUOTA_ENABLED === 'false') config.enabled = false;
  return config;
}

function saveQuotaConfig(config, file) {
  const fileArg = file || process.env.QUOTAS_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  const { valid, errors } = validateQuotaConfig(config);
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
  VALID_SCOPES,
  VALID_LIMITS,
  VALID_WINDOWS,
  VALID_ACTIONS,
  loadQuotaConfig,
  saveQuotaConfig,
  validateQuotaConfig,
};
