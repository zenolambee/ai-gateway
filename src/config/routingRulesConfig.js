const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(process.cwd(), 'config', 'routingRules.json');

const DEFAULT_CONFIG = { rules: [] };

/**
 * Load routing rules from config/routingRules.json.
 *
 * File shape:
 *   {
 *     "rules": [
 *       {
 *         "id": "skip-high-latency",
 *         "description": "Skip providers with latency > 3000ms",
 *         "when": { "provider.latency": { ">": 3000 } },
 *         "then": "skip"
 *       }
 *     ]
 *   }
 *
 * @param {string} [file] - override path to the routing rules config file
 * @returns {object} { rules: Array<object> }
 */
function loadRoutingRulesConfig(file) {
  const config = { ...DEFAULT_CONFIG };
  const filePath = file || process.env.ROUTING_RULES_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (raw && Array.isArray(raw.rules)) {
        config.rules = raw.rules;
      }
    } catch {
      // fall through to defaults
    }
  }
  return config;
}

/**
 * Validate a single model-based routing rule definition.
 *
 * Rule shape (model-based routing, Dashboard-managed):
 *   {
 *     id: string            — unique rule id (url-safe)
 *     model: string         — model id the rule applies to (required)
 *     strategy?: string     — routing strategy override for the model
 *     providerOrder?: [ids] — explicit provider order for the model
 *     connectionIds?: [ids] — allowed connection ids (informational allow-list
 *                             surfaced to the dashboard; eligibility still
 *                             enforced at selection time)
 *     enabled?: boolean     — default true
 *   }
 *
 * @param {object} rule
 * @returns {{valid:boolean, errors:string[]}}
 */
function validateModelRoutingRule(rule) {
  const errors = [];
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return { valid: false, errors: ['Rule must be an object'] };
  }
  if (typeof rule.id !== 'string' || !rule.id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(rule.id)) {
    errors.push('Rule "id" is required (letters, digits, . _ -; max 64 chars)');
  }
  if (typeof rule.model !== 'string' || !rule.model) {
    errors.push('Rule "model" is required (a model id from the Model Registry)');
  }
  if (rule.strategy !== undefined && rule.strategy !== null) {
    if (typeof rule.strategy !== 'string') errors.push('Rule "strategy" must be a string');
  }
  if (rule.providerOrder !== undefined && rule.providerOrder !== null) {
    if (!Array.isArray(rule.providerOrder) || rule.providerOrder.some((p) => typeof p !== 'string')) {
      errors.push('Rule "providerOrder" must be an array of provider ids');
    }
  }
  if (rule.connectionIds !== undefined && rule.connectionIds !== null) {
    if (!Array.isArray(rule.connectionIds) || rule.connectionIds.some((c) => typeof c !== 'string')) {
      errors.push('Rule "connectionIds" must be an array of connection ids');
    }
  }
  if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') {
    errors.push('Rule "enabled" must be a boolean');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Persist the model-based routing rules to config/routingRules.json so a
 * restart restores them. Preserves any declarative skip/prefer/demote rules
 * already stored in the file under "rules" (they share the file but are a
 * separate engine); model rules live under "modelRules".
 *
 * @param {Array<object>} modelRules
 * @param {string} [file]
 * @returns {boolean} success
 */
function saveModelRoutingRules(modelRules, file) {
  const filePath = file || process.env.ROUTING_RULES_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  try {
    let existing = {};
    if (fs.existsSync(filePath)) {
      try { existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) || {}; } catch { existing = {}; }
    }
    const out = {
      ...existing,
      rules: Array.isArray(existing.rules) ? existing.rules : [],
      modelRules: Array.isArray(modelRules) ? modelRules : [],
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(out, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Load model-based routing rules from config/routingRules.json
 * (the "modelRules" key; independent of the declarative "rules" list).
 *
 * @param {string} [file]
 * @returns {Array<object>}
 */
function loadModelRoutingRules(file) {
  const filePath = file || process.env.ROUTING_RULES_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (raw && Array.isArray(raw.modelRules)) return raw.modelRules;
    } catch {
      // fall through
    }
  }
  return [];
}

module.exports = {
  loadRoutingRulesConfig,
  loadModelRoutingRules,
  saveModelRoutingRules,
  validateModelRoutingRule,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_FILE,
};
