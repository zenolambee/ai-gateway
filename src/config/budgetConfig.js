const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(process.cwd(), 'config', 'budgets.json');

/**
 * Default budget configuration. Empty by default so the gateway runs WITHOUT
 * budget enforcement until a budget is explicitly defined (backward compat).
 *
 * Each budget entry is keyed by `id` and tracked across rolling windows:
 *   - window: 'daily' | 'weekly' | 'monthly'
 *   - scope: 'global' | 'project' | 'organization' | 'user'
 *   - scopeId: free-form id (project key / org / user key). Omit for global.
 *   - limit: USD cost cap. 0 means "no enforce, just track".
 *   - warnThresholdPercent & stopThresholdPercent: 50..100 (default 80/100).
 *   - onExceed: 'stop' (default) | 'warn' | 'continue'
 *
 * All state lives in memory. State IS NOT persisted across restarts but the
 * config IS, via config/budgets.json (validate-then-write atomic save).
 */
const DEFAULT_CONFIG = {
  enabled: false,
  budgets: [], // [{ id, name, scope, scopeId?, window, limit, currency, onExceed, warnThresholdPercent, stopThresholdPercent }]
};

function validateBudgetConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['budget config must be an object'] };
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    errors.push('budgets.enabled must be boolean');
  }
  if (config.budgets !== undefined) {
    if (!Array.isArray(config.budgets)) {
      errors.push('budgets.budgets must be an array');
    } else {
      const seen = new Set();
      config.budgets.forEach((b, i) => {
        if (!b || typeof b !== 'object') {
          errors.push(`budgets.budgets[${i}]: must be an object`);
          return;
        }
        if (!b.id || typeof b.id !== 'string') {
          errors.push(`budgets.budgets[${i}].id: required string`);
          return;
        }
        if (seen.has(b.id)) { errors.push(`budgets.budgets[${i}].id: duplicate id "${b.id}"`); return; }
        seen.add(b.id);
        if (!b.name || typeof b.name !== 'string') {
          errors.push(`budgets.budgets[${i}].name: required string`);
        }
        const scope = b.scope;
        if (!['global', 'project', 'organization', 'user'].includes(scope)) {
          errors.push(`budgets.budgets[${i}].scope: must be one of global|project|organization|user`);
        }
        if (scope && scope !== 'global' && !b.scopeId) {
          errors.push(`budgets.budgets[${i}].scopeId: required when scope="${scope}"`);
        }
        if (!['daily', 'weekly', 'monthly'].includes(b.window)) {
          errors.push(`budgets.budgets[${i}].window: must be one of daily|weekly|monthly`);
        }
        if (typeof b.limit !== 'number' || b.limit < 0 || !Number.isFinite(b.limit)) {
          errors.push(`budgets.budgets[${i}].limit: must be a non-negative finite number`);
        }
        if (b.onExceed !== undefined && !['stop', 'warn', 'continue'].includes(b.onExceed)) {
          errors.push(`budgets.budgets[${i}].onExceed: must be one of stop|warn|continue`);
        }
        if (b.warnThresholdPercent !== undefined && (typeof b.warnThresholdPercent !== 'number' || b.warnThresholdPercent < 0 || b.warnThresholdPercent > 100)) {
          errors.push(`budgets.budgets[${i}].warnThresholdPercent: must be 0..100`);
        }
        if (b.stopThresholdPercent !== undefined && (typeof b.stopThresholdPercent !== 'number' || b.stopThresholdPercent < 0 || b.stopThresholdPercent > 100)) {
          errors.push(`budgets.budgets[${i}].stopThresholdPercent: must be 0..100`);
        }
        if (b.warnThresholdPercent !== undefined && b.stopThresholdPercent !== undefined && b.warnThresholdPercent > b.stopThresholdPercent) {
          errors.push(`budgets.budgets[${i}]: warnThresholdPercent (warn) cannot exceed stopThresholdPercent (stop)`);
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

function loadBudgetConfig(file) {
  const fileArg = file || process.env.BUDGETS_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  let config = deepMerge(DEFAULT_CONFIG, {});
  if (fs.existsSync(fileArg)) {
    try {
      const raw = fs.readFileSync(fileArg, 'utf8');
      const parsed = JSON.parse(raw);
      config = deepMerge(config, parsed);
    } catch (err) { /* silent — keep defaults */ }
  }
  if (process.env.BUDGET_ENABLED === 'true') config.enabled = true;
  else if (process.env.BUDGET_ENABLED === 'false') config.enabled = false;
  return config;
}

function saveBudgetConfig(config, file) {
  const fileArg = file || process.env.BUDGETS_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  const { valid, errors } = validateBudgetConfig(config);
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
  loadBudgetConfig,
  saveBudgetConfig,
  validateBudgetConfig,
};
