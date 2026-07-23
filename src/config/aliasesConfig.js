const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(process.cwd(), 'config', 'aliases.json');

const DEFAULT_CONFIG = { aliases: {} };

/**
 * Load model alias definitions from config/aliases.json.
 *
 * File shape:
 *   {
 *     "aliases": {
 *       "gpt-5": { "models": ["gpt-5", "gpt-4o-2024-08-06"] },
 *       "claude-sonnet": { "models": ["claude-3-5-sonnet"] }
 *     }
 *   }
 *
 * @param {string} [file] - override path to the aliases config file
 * @returns {object} { aliases: { [id]: { models: string[] } } }
 */
function loadAliasesConfig(file) {
  const config = { ...DEFAULT_CONFIG };
  const filePath = file || process.env.ALIASES_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (raw && typeof raw === 'object' && raw.aliases && typeof raw.aliases === 'object') {
        config.aliases = raw.aliases;
      }
    } catch {
      // fall through to defaults
    }
  }
  return config;
}

module.exports = {
  loadAliasesConfig,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_FILE,
};
