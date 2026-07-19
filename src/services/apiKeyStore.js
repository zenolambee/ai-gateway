const logger = require('../utils/logger');
const { loadApiKeys } = require('../config/apiKeysConfig');

/**
 * ApiKeyStore
 *
 * A config-driven store of gateway API keys. Each key carries metadata
 * (name, status, optional expiration, optional provider/model restrictions,
 * creation time). The store validates a presented Bearer token against the
 * configured keys and enforces status, expiration, and restrictions.
 *
 * Keys are loaded from `config/apiKeys.json` and/or the `GATEWAY_API_KEYS`
 * env var at construction time. The store is in-memory and immutable for the
 * lifetime of the process (reload via `load()`).
 *
 * When no keys are configured, the store reports `enabled = false` so the
 * auth middleware can run in open-gateway mode (no keys = no auth).
 *
 * NO retry, NO HTTP — pure in-memory validation.
 */
class ApiKeyStore {
  constructor() {
    this.keys = [];
    this.keysByKey = new Map();
    this.loaded = false;
  }

  /**
   * Load (or reload) API key definitions from config.
   * @param {string} [file] - override path to the api keys config file
   * @returns {ApiKeyStore} this (for chaining)
   */
  load(file) {
    const keys = loadApiKeys(file);
    this.keys = keys;
    this.keysByKey = new Map();
    for (const k of keys) {
      this.keysByKey.set(k.key, k);
    }
    this.loaded = true;
    logger.info('ApiKeyStore initialized', {
      total: keys.length,
      active: this.getActiveKeys().length,
      enabled: this.isEnabled(),
    });
    return this;
  }

  /**
   * Whether authentication is enabled. When no keys are configured, the
   * gateway runs in open mode (no auth required).
   * @returns {boolean}
   */
  isEnabled() {
    return this.keysByKey.size > 0;
  }

  /**
   * Return all configured keys (metadata only — never expose the raw key).
   * @returns {Array<object>}
   */
  listKeys() {
    return this.keys.map((k) => this._publicView(k));
  }

  /**
   * Return only active, non-expired keys.
   * @returns {Array<object>}
   */
  getActiveKeys() {
    const now = Math.floor(Date.now() / 1000);
    return this.keys.filter((k) => k.status === 'active' && (!k.expiresAt || k.expiresAt > now));
  }

  /**
   * Validate a presented Bearer token. Returns the key record (with
   * restrictions) when valid, or an error descriptor when invalid.
   *
   * Checks (in order):
   *   1. Key exists in the store
   *   2. Status is 'active'
   *   3. Not expired (when expiresAt is set)
   *
   * Restriction checks (provider/model) are NOT done here — they require
   * request context and are enforced by the auth middleware after the model
   * is known. This method returns the key record so the middleware can
   * perform those checks.
   *
   * @param {string} presentedKey - the raw key from the Bearer header
   * @returns {{ valid: boolean, key?: object, error?: { code: string, message: string } }}
   */
  validate(presentedKey) {
    if (!presentedKey || typeof presentedKey !== 'string') {
      return { valid: false, error: { code: 'MISSING_API_KEY', message: "No API key provided. Set the 'Authorization: Bearer <key>' header." } };
    }

    const record = this.keysByKey.get(presentedKey);
    if (!record) {
      return { valid: false, error: { code: 'INVALID_API_KEY', message: 'Invalid API key provided.' } };
    }

    if (record.status === 'inactive') {
      return { valid: false, error: { code: 'DISABLED_API_KEY', message: 'This API key has been disabled.' } };
    }

    if (record.expiresAt) {
      const now = Math.floor(Date.now() / 1000);
      if (record.expiresAt <= now) {
        return { valid: false, error: { code: 'EXPIRED_API_KEY', message: 'This API key has expired.' } };
      }
    }

    return { valid: true, key: record };
  }

  /**
   * Check whether a key is allowed to access a specific provider. When the
   * key has no `allowedProviders` restriction, all providers are allowed.
   * @param {object} keyRecord
   * @param {string} providerId
   * @returns {boolean}
   */
  canAccessProvider(keyRecord, providerId) {
    if (!keyRecord || !keyRecord.allowedProviders) return true;
    if (!Array.isArray(keyRecord.allowedProviders)) return true;
    return keyRecord.allowedProviders.includes(providerId);
  }

  /**
   * Check whether a key is allowed to access a specific model. When the key
   * has no `allowedModels` restriction, all models are allowed.
   * @param {object} keyRecord
   * @param {string} modelId
   * @returns {boolean}
   */
  canAccessModel(keyRecord, modelId) {
    if (!keyRecord || !keyRecord.allowedModels) return true;
    if (!Array.isArray(keyRecord.allowedModels)) return true;
    return keyRecord.allowedModels.includes(modelId);
  }

  /**
   * Check whether a key record has the admin role.
   * @param {object} keyRecord
   * @returns {boolean}
   */
  isAdmin(keyRecord) {
    return !!(keyRecord && keyRecord.role === 'admin');
  }

  /**
   * Return a public (redacted) view of a key record — never exposes the raw
   * key value, only a masked prefix.
   * @param {object} k
   * @returns {object}
   * @private
   */
  _publicView(k) {
    return {
      id: k.id,
      name: k.name,
      status: k.status,
      role: k.role || 'user',
      expiresAt: k.expiresAt,
      allowedProviders: k.allowedProviders,
      allowedModels: k.allowedModels,
      createdAt: k.createdAt,
      keyPrefix: k.key ? `${k.key.slice(0, 4)}...${k.key.slice(-4)}` : '',
    };
  }
}

module.exports = ApiKeyStore;
