const logger = require('../utils/logger');
const { createStorage } = require('../storage');
const EncryptionService = require('./EncryptionService');

/**
 * ConnectionRegistry
 *
 * Owns the "Connect Account" lifecycle for every provider. It is the ONLY
 * component that talks to the storage backend — auth adapters exchange plain
 * account objects through save()/load() and never know how they are stored.
 *
 * Responsibilities:
 *   - create/retrieve adapters via the AuthAdapterFactory
 *   - connect / refresh / disconnect / status / validate for any provider
 *   - persist account records under a namespaced key (JSON)
 *   - restore accounts on startup (storage-backed, survives restart)
 *   - expose connection state for the dashboard
 *
 * Account record fields (all optional except providerId):
 *   { providerId, accountId, authType, name, credential, connectedAt,
 *     expiresAt, refreshAt, lastRefreshedAt, meta }
 */
class ConnectionRegistry {
  /**
   * @param {object} opts
   * @param {AuthAdapterFactory} [opts.factory]
   * @param {object|Function} [opts.storageProvider]
   * @param {string} [opts.prefix='gatewayAccount']
   */
  constructor(opts = {}) {
    this.factory = opts.factory || null;
    this._store = opts.storageProvider || null;
    this._prefix = opts.prefix || 'gatewayAccount';
    this._encryption = opts.encryption || new EncryptionService({});
    this._httpClient = opts.httpClient || null;
    this._tokenManager = null;
    this._scheduler = null;
    this.accounts = new Map(); // accountId -> account
    this.loaded = false;
  }

  _getStore() {
    const s = this._store;
    return typeof s === 'function' ? s() : s;
  }

  _storageKey(accountId) {
    return `${this._prefix}:${accountId}`;
  }

  _adapter(providerId, authType) {
    if (!this.factory) {
      throw new Error('ConnectionRegistry: no auth adapter factory attached');
    }
    // Provider-specific adapter takes precedence; else instantiate by auth type.
    const adapter = this.factory.create(providerId, authType);
    adapter._attach(this);
    adapter._httpClient = adapter._httpClient || this._httpClient;
    adapter._encryption = adapter._encryption || this._encryption;
    // Give the adapter access to the configured provider catalog (if any).
    adapter._providerCatalog = adapter._providerCatalog || this._providerCatalog || null;
    return adapter;
  }

  /**
   * Return a copy of an account with its credential decrypted (for adapter
   * lifecycle methods). Loaded accounts carry an encrypted credential envelope.
   * @private
   */
  _plain(account) {
    if (!account || !account.credential) return account;
    const copy = { ...account };
    if (typeof account.credential === 'object' && account.credential.data && account.credential.iv) {
      copy.credential = this._decryptCredential(account.credential);
    }
    return copy;
  }

  /**
   * Create a connection for a provider.
   * @param {object} config { providerId, authType, ...provider-specific }
   * @returns {Promise<object>} account
   */
  async connect(config = {}) {
    const providerId = config.providerId;
    if (!providerId) throw new Error('connect: providerId is required');
    const authType = this.factory ? this.factory.normalize(config.authType) : (config.authType || 'custom');
    const adapter = this._adapter(providerId, authType);
    const account = await adapter.connect({ ...config, authType, registry: this });
    account.authType = authType;
    // Persist via the registry (adapter.save calls back into us).
    await this._saveAccount(account, authType);
    this.accounts.set(account.accountId, account);
    if (this._tokenManager) {
      await this._tokenManager.save(account);
    }
    return this._public(account, adapter);
  }

  /**
   * Refresh a connection by account id.
   * @param {string} accountId
   * @returns {Promise<object>}
   */
  async refresh(accountId) {
    const raw = this.accounts.get(accountId) || (await this._loadAccount(accountId));
    if (!raw) throw new Error(`refresh: account "${accountId}" not found`);
    const account = this._plain(raw);
    const adapter = this._adapter(account.providerId, account.authType);
    const refreshed = await adapter.refresh(account);
    refreshed.authType = account.authType;
    await this._saveAccount(refreshed, account.authType);
    this.accounts.set(refreshed.accountId, refreshed);
    if (this._tokenManager) {
      await this._tokenManager.save(refreshed);
    }
    return this._public(refreshed, adapter);
  }

  /**
   * Disconnect an account by id. Removes it from the registry and storage.
   * @param {string} accountId
   * @returns {Promise<boolean>}
   */
  async disconnect(accountId) {
    const raw = this.accounts.get(accountId) || (await this._loadAccount(accountId));
    if (!raw) return false;
    const account = this._plain(raw);
    const adapter = this._adapter(account.providerId, account.authType);
    try {
      await adapter.disconnect(account);
    } catch (err) {
      logger.warn('ConnectionRegistry: adapter disconnect threw', { error: err.message });
    }
    this.accounts.delete(accountId);
    if (this._tokenManager) {
      await this._tokenManager.remove(accountId).catch(() => {});
    }
    const store = this._getStore();
    if (store) {
      try { await store.del(this._storageKey(accountId)); } catch (_) {}
    }
    return true;
  }

  /**
   * Return the effective connection status for an account.
   * @param {string} accountId
   * @returns {Promise<object>}
   */
  async status(accountId) {
    const raw = this.accounts.get(accountId) || (await this._loadAccount(accountId));
    if (!raw) return { state: 'disconnected', accountId };
    const account = this._plain(raw);
    const adapter = this._adapter(account.providerId, account.authType);
    const s = await adapter.status(account);
    return { accountId, providerId: account.providerId, authType: account.authType, name: account.name, ...s };
  }

  /**
   * Validate the stored credential for an account.
   * @param {string} accountId
   * @returns {boolean}
   */
  async validate(accountId) {
    const raw = this.accounts.get(accountId) || (await this._loadAccount(accountId));
    if (!raw) return false;
    const account = this._plain(raw);
    const adapter = this._adapter(account.providerId, account.authType);
    return adapter.validate(account);
  }

  /** List all managed accounts with status. */
  async listAccounts() {
    const out = [];
    for (const account of this.accounts.values()) {
      const adapter = this._adapter(account.providerId, account.authType);
      out.push(await this._public(account, adapter));
    }
    return out;
  }

  /**
   * Return a redacted, status-annotated view of an account for the UI.
   * The credential is decrypted in-memory for adapter.status()/validate() but
   * NEVER included in the returned object.
   */
  async _public(account, adapter) {
    const plain = this._plain(account);
    let status;
    try { status = await adapter.status(plain); } catch (_) { status = { state: 'disconnected' }; }
    const valid = adapter.validate(plain);
    const copy = { ...account };
    delete copy.credential; // never expose secrets in the API view
    delete copy.token;      // never expose the encrypted token envelope via UI
    return { ...copy, state: status.state, status, valid };
  }

  /**
   * Encrypt a credential object into a storage-safe envelope.
   * @param {object|*} credential
   * @returns {*}
   * @private
   */
  _encryptCredential(credential) {
    if (!credential) return credential;
    if (this._encryption) return this._encryption.encrypt(credential);
    return credential;
  }

  /**
   * Decrypt a stored credential envelope back to a plain object.
   * @param {*} envelope
   * @returns {*}
   * @private
   */
  _decryptCredential(envelope) {
    if (!envelope || typeof envelope !== 'object') return envelope;
    if (this._encryption) return this._encryption.decrypt(envelope);
    return envelope;
  }

  /**
   * Persist an account via the registry's storage backend.
   * @param {object} account
   * @param {string} [authType]
   * @returns {Promise<object>}
   * @private  (called by adapters via this.save())
   */
  async _saveAccount(account, authType) {
    if (authType) account.authType = authType;
    const store = this._getStore();
    if (store) {
      const toStore = JSON.parse(JSON.stringify(account));
      if (toStore.credential) {
        toStore.credential = this._encryptCredential(toStore.credential);
      }
      try {
        await store.set(this._storageKey(account.accountId), toStore);
      } catch (err) {
        logger.warn('ConnectionRegistry: save failed', { error: err.message });
      }
    }
    this.accounts.set(account.accountId, account);
    return account;
  }

  /**
   * Load a persisted account from storage (credentials stay encrypted; call
   * `_decryptCredential` to obtain plaintext).
   * @param {string} accountId
   * @returns {Promise<object|null>}
   * @private  (called by adapters via this.load())
   */
  async _loadAccount(accountId) {
    if (this.accounts.has(accountId)) return this.accounts.get(accountId);
    const store = this._getStore();
    if (!store) return null;
    try {
      const rec = await store.get(this._storageKey(accountId));
      if (rec && typeof rec === 'object') {
        this.accounts.set(accountId, rec);
        return rec;
      }
    } catch (_) {}
    return null;
  }

  /**
   * Restore all persisted accounts into memory. Called at startup (or after a
   * storage upgrade) so connections survive a restart.
   * @returns {Promise<number>}
   */
  async hydrate() {
    const store = this._getStore();
    if (!store) return 0;
    let keys = [];
    try {
      keys = await store.keys('*');
    } catch (_) { return 0; }
    let count = 0;
    for (const fullKey of keys) {
      const marker = `${this._prefix}:`;
      if (!fullKey.includes(marker)) continue;
      const idx = fullKey.indexOf(marker);
      const accountId = fullKey.slice(idx + marker.length);
      try {
        const rec = await store.get(fullKey.slice(idx));
        if (rec && typeof rec === 'object') {
          this.accounts.set(accountId, rec);
          count += 1;
        }
      } catch (_) {}
    }
    this.loaded = true;
    if (count > 0) {
      logger.info('ConnectionRegistry: restored connections', { count });
    }
    return count;
  }

  /** Access to the auth factory for the Connect Account UI metadata. */
  authTypes() {
    return this.factory ? this.factory.listTypes() : [];
  }

  /** Set the token manager (late binding). */
  setTokenManager(tm) { this._tokenManager = tm; }

  /** Set the refresh scheduler (late binding). */
  setScheduler(s) { this._scheduler = s; }

  /** Get the token manager (created lazily if possible). */
  getTokenManager() {
    if (!this._tokenManager) {
      const TokenManager = require('./TokenManager');
      this._tokenManager = new TokenManager({ registry: this, encryption: this._encryption });
    }
    return this._tokenManager;
  }

  /** Get the refresh scheduler (created lazily if possible). */
  getScheduler() {
    if (!this._scheduler) {
      const RefreshScheduler = require('./RefreshScheduler');
      this._scheduler = new RefreshScheduler({ registry: this });
    }
    return this._scheduler;
  }

  /** Set the linked HTTP client (for adapters). */
  setHttpClient(client) { this._httpClient = client; }

  /** Set the provider catalog (metadata for adapters). */
  setProviderCatalog(catalog) { this._providerCatalog = catalog; }

  /** Fetch the decrypted token record for an account (via TokenManager). */
  async getToken(accountId) {
    return this.getTokenManager().get(accountId);
  }

  /** Number of managed accounts. */
  get size() { return this.accounts.size; }
}

module.exports = ConnectionRegistry;
module.exports._createStorage = createStorage;
