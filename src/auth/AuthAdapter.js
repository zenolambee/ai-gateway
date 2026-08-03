const logger = require('../utils/logger');

/**
 * AuthAdapter
 *
 * Abstract authentication adapter for a "Connect Account" flow. Every adapter
 * implements the same interface so the core gateway never needs to know how a
 * specific provider (OpenAI, Grok, Claude, Gemini, Copilot, Cursor, Windsurf,
 * Kimi, Qwen, ...) authenticates.
 *
 * A provider selects one of the supported auth types:
 *   - api-key         : simple static API key/token
 *   - oauth           : OAuth 2.0 (authorization-code, client-credentials)
 *   - device-code     : OAuth device-authorization flow
 *   - browser-login   : session-based browser login (cookies)
 *   - session         : arbitrary session/cookie secrets
 *   - custom          : fully custom adapter
 *
 * Interface contract — adapters should implement ALL of these so the registry
 * can drive the lifecycle uniformly:
 *
 *   connect(config)          : establish/return an authenticated credential
 *   refresh(account)         : refresh an expiring credential
 *   disconnect(account)      : revoke / remove the stored credential
 *   status(account)          : { state, ... } — connected|disconnected|expired|refreshing|reconnecting
 *   validate(credential)     : boolean — is the credential currently usable
 *   save(account)            : persist the account credential via the registry
 *   load(accountId)          : restore a persisted account into this adapter
 *
 * Storage is handled by the ConnectionRegistry — adapters NEVER touch a
 * storage backend directly. They only exchange plain objects with the
 * registry through save()/load().
 *
 * Unknown/extra fields in an account record are preserved so a custom adapter
 * can carry its own state without core changes.
 */
class AuthAdapter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.type='custom'] - auth type identifier
   */
  constructor(opts = {}) {
    this.type = opts.type || 'custom';
    this._registry = null;
    this._httpClient = null;
    this._encryption = null;
    this._providerCatalog = null;
  }

  /** Called once by the registry during setup. */
  _attach(registry) {
    this._registry = registry;
    this._httpClient = this._httpClient || (registry._httpClient || null);
    this._encryption = this._encryption || (registry._encryption || null);
  }

  /** Human-readable label for the auth type. */
  label() {
    return this.type;
  }

  /**
   * Establish authentication. Returns an account credential descriptor.
   * @param {object} config - provider-specific auth config
   * @returns {Promise<object>}
   */
  async connect(config) {
    throw new Error(`${this.type}: connect() not implemented`);
  }

  /**
   * Refresh an expiring credential. Returns the updated account.
   * @param {object} account
   * @returns {Promise<object>}
   */
  async refresh(account) {
    throw new Error(`${this.type}: refresh() not implemented`);
  }

  /**
   * Disconnect/revoke. Returns the account id that was removed.
   * @param {object} account
   * @returns {Promise<string>}
   */
  async disconnect(account) {
    throw new Error(`${this.type}: disconnect() not implemented`);
  }

  /**
   * Report the current connection state.
   * @param {object} account
   * @returns {Promise<object>} { state, connectedAt?, expiresAt? }
   */
  async status(account) {
    return { state: account && account.credential ? 'connected' : 'disconnected' };
  }

  /**
   * Whether a stored credential is currently usable (not expired).
   * @param {object} account
   * @returns {boolean}
   */
  validate(account) {
    if (!account || !account.credential) return false;
    if (account.expiresAt && Date.now() >= account.expiresAt) return false;
    return true;
  }

  /**
   * Persist an account through the registry (adapters never touch storage
   * directly).
   * @param {object} account
   * @returns {Promise<object>}
   */
  async save(account) {
    if (!this._registry) return account;
    return this._registry._saveAccount(account, this.type);
  }

  /**
   * Load a persisted account by id.
   * @param {string} accountId
   * @returns {Promise<object|null>}
   */
  async load(accountId) {
    if (!this._registry) return null;
    return this._registry._loadAccount(accountId);
  }

  /** No-op logger helper for adapters. */
  _log(msg, meta) {
    logger.info(`AuthAdapter(${this.type}): ${msg}`, meta || {});
  }
}

module.exports = AuthAdapter;
