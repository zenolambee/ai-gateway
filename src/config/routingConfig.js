const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(process.cwd(), 'config', 'routing.json');

/**
 * Default routing configuration.
 *
 *   - strategy            : provider routing strategy (priority |
 *                           fastest-response | lowest-latency |
 *                           round-robin | least-used | weighted | random)
 *   - keySelectionStrategy: per-provider key selection strategy (priority |
 *                           round-robin | random | least-used | weighted)
 *
 * Both default to the historical behaviour (priority for providers,
 * round-robin for keys) so existing deployments are unaffected.
 */
const DEFAULT_CONFIG = {
  strategy: 'priority',
  keySelectionStrategy: 'round-robin',
};

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
 *   ROUTING_KEY_SELECTION_STRATEGY=priority|round-robin|random|least-used|weighted
 *
 * @param {string} [file] - override path to the routing config file
 * @returns {object} merged configuration
 */
function loadRoutingConfig(file) {
  let config = { ...DEFAULT_CONFIG };

  // 1. Load from JSON file
  const filePath = file || process.env.ROUTING_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (raw && typeof raw === 'object') {
        if (typeof raw.strategy === 'string') config.strategy = raw.strategy;
        if (typeof raw.keySelectionStrategy === 'string') config.keySelectionStrategy = raw.keySelectionStrategy;
      }
    } catch {
      // fall through to env
    }
  }

  // 2. Override with env vars
  if (process.env.ROUTING_STRATEGY !== undefined && process.env.ROUTING_STRATEGY !== '') {
    config.strategy = process.env.ROUTING_STRATEGY;
  }
  if (process.env.ROUTING_KEY_SELECTION_STRATEGY !== undefined && process.env.ROUTING_KEY_SELECTION_STRATEGY !== '') {
    config.keySelectionStrategy = process.env.ROUTING_KEY_SELECTION_STRATEGY;
  }

  return config;
}

module.exports = {
  loadRoutingConfig,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_FILE,
};
