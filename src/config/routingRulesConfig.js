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

module.exports = {
  loadRoutingRulesConfig,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_FILE,
};
