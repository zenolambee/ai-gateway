const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(process.cwd(), 'config', 'routing.json');

/**
 * Default routing configuration.
 *
 *   - strategy             : global provider routing strategy (priority |
 *                            fastest-response | lowest-latency |
 *                            round-robin | least-used | weighted | random)
 *   - connectionStrategy   : global connection (account) selection strategy
 *                            (priority | round-robin | least-used | weighted |
 *                            random | fastest-response)
 *   - keySelectionStrategy : per-provider API key selection strategy
 *                            (priority | round-robin | random | least-used |
 *                            weighted)
 *   - providerStrategies   : optional per-provider connection strategy
 *                            overrides { providerId: strategyId }
 *
 * All default to the historical behaviour (priority for providers,
 * round-robin for keys) so existing deployments are unaffected.
 */
const DEFAULT_CONFIG = {
  strategy: 'priority',
  connectionStrategy: 'priority',
  keySelectionStrategy: 'round-robin',
  providerStrategies: {},
};

/**
 * Strategies valid for provider-level routing (must exist in
 * src/services/routingStrategy.js).
 */
const PROVIDER_STRATEGIES = [
  'priority', 'round-robin', 'least-used', 'weighted', 'random',
  'fastest-response', 'lowest-latency', 'lowest-cost', 'highest-success-rate',
];

/**
 * Strategies valid for connection-level selection (implemented by
 * src/services/accountManager.js). `fastest` is kept as the historical
 * alias of fastest-response.
 */
const CONNECTION_STRATEGIES = [
  'priority', 'round-robin', 'least-used', 'weighted', 'random',
  'fastest', 'fastest-response', 'lowest-latency',
];

/**
 * Parse a string env var, returning the default when unset or empty.
 */
function envStr(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

/**
 * Load routing configuration from config/routing.json and/or ROUTING_*
 * environment variables. Env vars override file values.
 *
 * Supported env vars:
 *   ROUTING_STRATEGY=priority|fastest-response|lowest-latency|round-robin|least-used|weighted|random
 *   ROUTING_CONNECTION_STRATEGY=priority|round-robin|least-used|weighted|random|fastest
 *   ROUTING_KEY_SELECTION_STRATEGY=priority|round-robin|random|least-used|weighted
 *
 * @param {string} [file] - override path to the routing config file
 * @returns {object} merged configuration
 */
function loadRoutingConfig(file) {
  let config = { ...DEFAULT_CONFIG, providerStrategies: {} };

  // 1. Load from JSON file
  const filePath = file || process.env.ROUTING_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (raw && typeof raw === 'object') {
        if (typeof raw.strategy === 'string') config.strategy = raw.strategy;
        if (typeof raw.connectionStrategy === 'string') config.connectionStrategy = raw.connectionStrategy;
        if (typeof raw.keySelectionStrategy === 'string') config.keySelectionStrategy = raw.keySelectionStrategy;
        if (raw.providerStrategies && typeof raw.providerStrategies === 'object' && !Array.isArray(raw.providerStrategies)) {
          config.providerStrategies = { ...raw.providerStrategies };
        }
      }
    } catch {
      // fall through to env
    }
  }

  // 2. Override with env vars
  if (process.env.ROUTING_STRATEGY !== undefined && process.env.ROUTING_STRATEGY !== '') {
    config.strategy = process.env.ROUTING_STRATEGY;
  }
  if (process.env.ROUTING_CONNECTION_STRATEGY !== undefined && process.env.ROUTING_CONNECTION_STRATEGY !== '') {
    config.connectionStrategy = process.env.ROUTING_CONNECTION_STRATEGY;
  }
  if (process.env.ROUTING_KEY_SELECTION_STRATEGY !== undefined && process.env.ROUTING_KEY_SELECTION_STRATEGY !== '') {
    config.keySelectionStrategy = process.env.ROUTING_KEY_SELECTION_STRATEGY;
  }

  return config;
}

/**
 * Validate a routing config patch. Returns { valid, errors, patch } where
 * `patch` contains only the sanitized fields. Unknown strategies and
 * malformed values are rejected — the gateway never crashes on a bad
 * routing config (the caller falls back to the previous/default value).
 *
 * @param {object} body - candidate patch
 * @returns {{valid:boolean, errors:string[], patch:object}}
 */
function validateRoutingPatch(body) {
  const errors = [];
  const patch = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be an object'], patch };
  }
  if (body.strategy !== undefined) {
    if (typeof body.strategy === 'string' && PROVIDER_STRATEGIES.includes(body.strategy)) {
      patch.strategy = body.strategy;
    } else {
      errors.push(`Unknown provider routing strategy "${body.strategy}". Available: ${PROVIDER_STRATEGIES.join(', ')}`);
    }
  }
  if (body.connectionStrategy !== undefined) {
    if (typeof body.connectionStrategy === 'string' && CONNECTION_STRATEGIES.includes(body.connectionStrategy)) {
      patch.connectionStrategy = body.connectionStrategy;
    } else {
      errors.push(`Unknown connection strategy "${body.connectionStrategy}". Available: ${CONNECTION_STRATEGIES.join(', ')}`);
    }
  }
  if (body.keySelectionStrategy !== undefined) {
    if (typeof body.keySelectionStrategy === 'string'
      && ['priority', 'round-robin', 'random', 'least-used', 'weighted'].includes(body.keySelectionStrategy)) {
      patch.keySelectionStrategy = body.keySelectionStrategy;
    } else {
      errors.push(`Unknown key selection strategy "${body.keySelectionStrategy}"`);
    }
  }
  if (body.providerStrategies !== undefined) {
    if (body.providerStrategies && typeof body.providerStrategies === 'object' && !Array.isArray(body.providerStrategies)) {
      const clean = {};
      for (const [pid, sid] of Object.entries(body.providerStrategies)) {
        if (sid === null) continue; // null clears the override
        if (typeof sid === 'string' && CONNECTION_STRATEGIES.includes(sid)) clean[pid] = sid;
        else errors.push(`Unknown connection strategy "${sid}" for provider "${pid}"`);
      }
      patch.providerStrategies = clean;
    } else {
      errors.push('providerStrategies must be an object mapping providerId -> strategy');
    }
  }
  return { valid: errors.length === 0, errors, patch };
}

/**
 * Persist the routing configuration to config/routing.json so a restart
 * (or a config hot-reload) restores the same strategies. Best-effort:
 * write failures are reported to the caller but never thrown into the
 * request path. Only the known routing keys are written.
 *
 * @param {object} config - full routing config object
 * @param {string} [file] - override path (testing)
 * @returns {boolean} success
 */
function saveRoutingConfig(config, file) {
  const filePath = file || process.env.ROUTING_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  try {
    const out = {
      strategy: typeof config.strategy === 'string' ? config.strategy : DEFAULT_CONFIG.strategy,
      connectionStrategy: typeof config.connectionStrategy === 'string'
        ? config.connectionStrategy : DEFAULT_CONFIG.connectionStrategy,
      keySelectionStrategy: typeof config.keySelectionStrategy === 'string'
        ? config.keySelectionStrategy : DEFAULT_CONFIG.keySelectionStrategy,
      providerStrategies: (config.providerStrategies && typeof config.providerStrategies === 'object'
        && !Array.isArray(config.providerStrategies)) ? config.providerStrategies : {},
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(out, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  loadRoutingConfig,
  saveRoutingConfig,
  validateRoutingPatch,
  PROVIDER_STRATEGIES,
  CONNECTION_STRATEGIES,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_FILE,
};
