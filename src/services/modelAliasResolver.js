const logger = require('../utils/logger');

/**
 * ModelAliasResolver
 *
 * Maps client-sent model aliases to the canonical model ids that providers
 * actually serve. The client always sends the alias (e.g. "gpt-5"); the
 * gateway resolves it to one or more backing model ids (e.g. "gpt-5",
 * "gpt-4o-2024-08-06") and the providers that serve them.
 *
 * Aliases are loaded from config/aliases.json and/or per-model `aliases`
 * arrays in the ModelRegistry. When no alias is configured for a given
 * id, `resolve()` returns the input unchanged — so existing OpenAI-
 * compatible clients that send the real model id keep working without
 * any configuration change.
 *
 * Alias config shape (config/aliases.json):
 *   {
 *     "aliases": {
 *       "gpt-5": { "models": ["gpt-5", "gpt-4o-2024-08-06"] },
 *       "claude-sonnet": { "models": ["claude-3-5-sonnet", "claude-3-sonnet"] },
 *       "kimi-k3": { "models": ["moonshot-v1-128k"] }
 *     }
 *   }
 *
 * The `models` array lists the canonical model ids the alias maps to. The
 * resolver returns the FIRST id that has at least one enabled provider
 * (so the gateway can fail over across models when one is unavailable).
 */
class ModelAliasResolver {
  constructor() {
    // alias -> { models: string[] }
    this.aliases = {};
    // reverse map: canonicalModelId -> [alias, ...] (for the registry)
    this._reverse = new Map();
    this.loaded = false;
  }

  /**
   * Load alias definitions from a config object.
   * @param {object} config - { aliases: { [aliasId]: { models: string[] } } }
   * @returns {ModelAliasResolver} this
   */
  load(config) {
    this.aliases = {};
    this._reverse = new Map();
    if (config && typeof config === 'object' && config.aliases && typeof config.aliases === 'object') {
      for (const [alias, def] of Object.entries(config.aliases)) {
        if (def && Array.isArray(def.models) && def.models.length > 0) {
          this.aliases[alias] = { models: [...def.models] };
          for (const m of def.models) {
            if (!this._reverse.has(m)) this._reverse.set(m, []);
            this._reverse.get(m).push(alias);
          }
        }
      }
    }
    this.loaded = true;
    logger.info('ModelAliasResolver initialized', {
      aliases: Object.keys(this.aliases).length,
    });
    return this;
  }

  /**
   * Add or update an alias at runtime (admin API).
   * @param {string} alias
   * @param {string[]} models
   */
  setAlias(alias, models) {
    if (!alias || typeof alias !== 'string') return;
    if (!Array.isArray(models)) return;
    // Remove old reverse mappings
    const old = this.aliases[alias];
    if (old) {
      for (const m of old.models) {
        const arr = this._reverse.get(m);
        if (arr) {
          const idx = arr.indexOf(alias);
          if (idx >= 0) arr.splice(idx, 1);
          if (arr.length === 0) this._reverse.delete(m);
        }
      }
    }
    this.aliases[alias] = { models: [...models] };
    for (const m of models) {
      if (!this._reverse.has(m)) this._reverse.set(m, []);
      this._reverse.get(m).push(alias);
    }
  }

  /**
   * Remove an alias.
   * @param {string} alias
   */
  removeAlias(alias) {
    const def = this.aliases[alias];
    if (!def) return false;
    for (const m of def.models) {
      const arr = this._reverse.get(m);
      if (arr) {
        const idx = arr.indexOf(alias);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) this._reverse.delete(m);
      }
    }
    delete this.aliases[alias];
    return true;
  }

  /**
   * Resolve an alias (or raw model id) to the list of canonical model ids
   * that it maps to. When the input is not a configured alias, returns
   * [input] — so the gateway treats it as a direct model id.
   *
   * @param {string} aliasOrModel
   * @returns {string[]} canonical model ids (length >= 1)
   */
  resolve(aliasOrModel) {
    if (!aliasOrModel || typeof aliasOrModel !== 'string') return [];
    const def = this.aliases[aliasOrModel];
    if (def && def.models.length > 0) return def.models;
    return [aliasOrModel];
  }

  /**
   * Whether a given string is a configured alias.
   * @param {string} aliasOrModel
   * @returns {boolean}
   */
  isAlias(aliasOrModel) {
    return !!this.aliases[aliasOrModel];
  }

  /**
   * Return all configured aliases (for admin API).
   * @returns {object}
   */
  listAliases() {
    const out = {};
    for (const [alias, def] of Object.entries(this.aliases)) {
      out[alias] = { models: [...def.models] };
    }
    return out;
  }

  /**
   * Return the aliases that map to a given canonical model id.
   * @param {string} modelId
   * @returns {string[]}
   */
  aliasesForModel(modelId) {
    return this._reverse.get(modelId) || [];
  }
}

module.exports = ModelAliasResolver;
