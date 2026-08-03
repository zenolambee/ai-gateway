const logger = require('../utils/logger');
const EncryptionService = require('./EncryptionService');

/**
 * TokenManager
 *
 * Owns persistence of OAuth/account token records. Fields persisted (via the
 * registry's storage backend, encrypted):
 *   accessToken, refreshToken, scope, accountId, providerId, status,
 *   expiresAt, refreshAt, lastRefreshedAt, tokenType, error
 *
 * This component is storage-agnostic (it delegates to ConnectionRegistry
 * save/load) and always encrypts credentials through the EncryptionService
 * before they reach disk. It also centralizes the refresh-retry bookkeeping
 * (attempts, backoff, nextRetryAt).
 *
 * Interface:
 *   save(account, token)
 *   get(accountId)
 *   update(accountId, patch)
 *   remove(accountId)
 */
class TokenManager {
  /**
   * @param {object} opts
   * @param {ConnectionRegistry} [opts.registry]
   * @param {EncryptionService} [opts.encryption]
   */
  constructor(opts = {}) {
    this._registry = opts.registry || null;
    this._encryption = opts.encryption || new EncryptionService({});
    this._tokens = new Map(); // accountId -> decrypted token record (memory cache)
  }

  _getRegistry() {
    // Allow a getter-style registry for late binding.
    const r = this._registry;
    return typeof r === 'function' ? r() : r;
  }

  /**
   * Build the encrypted, persisted token record from a decrypted token object.
   */
  _envelope(token) {
    const { accessToken, refreshToken } = token;
    const safe = { ...token };
    delete safe.accessToken;
    delete safe.refreshToken;
    // Keep a status flag and non-secret fields plain; encrypt the secrets.
    return {
      status: token.status || 'active',
      accountId: token.accountId,
      providerId: token.providerId,
      scope: token.scope || null,
      expiresAt: token.expiresAt || null,
      refreshAt: token.refreshAt || null,
      lastRefreshedAt: token.lastRefreshedAt || null,
      tokenType: token.tokenType || 'Bearer',
      attempts: token.attempts || 0,
      nextRetryAt: token.nextRetryAt || null,
      lastError: token.lastError || null,
      credential: this._encryption.encrypt({
        accessToken,
        refreshToken,
      }),
    };
  }

  /**
   * Persist a token record for an account. The `account.credential` is taken
   * as the source of truth; a separately provided `token` object may override.
   * @param {object} account
   * @param {object} [token]
   * @returns {Promise<object>} decrypted token
   */
  async save(account, token = {}) {
    const cred = account.credential || {};
    const t = {
      accessToken: token.accessToken !== undefined ? token.accessToken : cred.accessToken,
      refreshToken: token.refreshToken !== undefined ? token.refreshToken : cred.refreshToken,
      scope: token.scope !== undefined ? token.scope : (account.scope || cred.scope || null),
      accountId: account.accountId,
      providerId: account.providerId,
      status: token.status || 'active',
      expiresAt: token.expiresAt !== undefined ? token.expiresAt : account.expiresAt,
      refreshAt: token.refreshAt !== undefined ? token.refreshAt : account.refreshAt,
      tokenType: token.tokenType || cred.tokenType || 'Bearer',
      lastRefreshedAt: token.lastRefreshedAt !== undefined ? token.lastRefreshedAt : account.lastRefreshedAt,
      attempts: token.attempts || 0,
      nextRetryAt: token.nextRetryAt || null,
      lastError: token.lastError || null,
    };
    const envelope = this._envelope(t);
    const registry = this._getRegistry();
    if (registry) {
      await registry._saveAccount({ ...account, token: envelope, expiresAt: t.expiresAt, refreshAt: t.refreshAt, lastRefreshedAt: t.lastRefreshedAt }, account.authType);
    }
    this._tokens.set(account.accountId, { ...t });
    return t;
  }

  /**
   * Retrieve the decrypted token record for an account.
   * @param {string} accountId
   * @returns {Promise<object|null>}
   */
  async get(accountId) {
    if (this._tokens.has(accountId)) return { ...this._tokens.get(accountId) };
    const registry = this._getRegistry();
    if (!registry) return null;
    const account = await registry._loadAccount(accountId);
    if (!account || !account.token) return null;
    const envelope = account.token;
    const decrypted = this._encryption.decrypt(envelope.credential) || {};
    const t = {
      accessToken: decrypted.accessToken,
      refreshToken: decrypted.refreshToken,
      status: envelope.status,
      accountId,
      providerId: account.providerId,
      scope: envelope.scope,
      expiresAt: envelope.expiresAt,
      refreshAt: envelope.refreshAt,
      lastRefreshedAt: envelope.lastRefreshedAt,
      tokenType: envelope.tokenType,
      attempts: envelope.attempts || 0,
      nextRetryAt: envelope.nextRetryAt || null,
      lastError: envelope.lastError || null,
    };
    this._tokens.set(accountId, { ...t });
    return t;
  }

  /**
   * Patch a token record for an account.
   * @param {string} accountId
   * @param {object} patch
   * @returns {Promise<object|null>}
   */
  async update(accountId, patch = {}) {
    const current = await this.get(accountId);
    if (!current) return null;
    const merged = { ...current, ...patch };
    const registry = this._getRegistry();
    const account = registry ? await registry._loadAccount(accountId) : { accountId, providerId: current.providerId };
    if (!account) return null;
    const t = await this.save(account, merged);
    return t;
  }

  /**
   * Remove a token record for an account.
   */
  async remove(accountId) {
    this._tokens.delete(accountId);
    const registry = this._getRegistry();
    if (registry) {
      const account = await registry._loadAccount(accountId);
      if (account && account.token) {
        delete account.token;
        await registry._saveAccount(account, account.authType);
      }
    }
    return true;
  }

  /** All cached (decrypted) tokens in memory — for the scheduler. */
  list() {
    return [...this._tokens.values()].map((t) => ({ ...t }));
  }

  /** Clear the in-memory cache. */
  reset() {
    this._tokens.clear();
  }
}

module.exports = TokenManager;
