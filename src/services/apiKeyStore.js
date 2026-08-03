const logger = require('../utils/logger');
const { loadApiKeys } = require('../config/apiKeysConfig');

/**
 * ApiKeyStore
 *
 * A config-driven, storage-backed store of gateway API keys. Each key
 * carries metadata (name, status, optional expiration, optional
 * provider/model restrictions, role, creation/update times, usage counters,
 * quota, permissions, metadata, tags). The store validates a presented
 * Bearer token against the configured keys and enforces status, expiration,
 * and restrictions.
 *
 * Source of truth:
 *   - Startup: keys are loaded from `config/apiKeys.json` and/or the
 *     `GATEWAY_API_KEYS` env var (via `load()`, synchronous — preserved for
 *     backward compatibility).
 *   - When a StorageProvider is attached, every mutation (create / update /
 *     usage / delete) is persisted through it, and the store restores the
 *     full persisted state on `hydrate()`. Admin-created keys therefore
 *     survive a restart; status/expiration/role/restrictions/usage counters
 *     all persist.
 *
 * Automatic migration:
 *   - On first `load()` with storage attached, the config-defined keys are
 *     imported into the storage backend exactly once (guarded by a migration
 *     marker). Repeated loads never produce duplicates.
 *
 * Backward compatibility:
 *   - `.keys` (Array) and `.keysByKey` (Map) remain the synchronous in-memory
 *     cache and may be read directly, exactly as before.
 *   - `load()` remains synchronous and returns `this`.
 *   - All existing public methods (`isEnabled`, `listKeys`, `getActiveKeys`,
 *     `validate`, `canAccessProvider`, `canAccessModel`, `isAdmin`,
 *     `publicView`) behave identically.
 *
 * Redis unavailability: the storage backend (see src/storage) already falls
 * back to MemoryStorage transparently, so the store inherits that behavior —
 * it never fails to start.
 */
class ApiKeyStore {
  /**
   * @param {object} [opts]
   * @param {object|Function} [opts.storageProvider] - a StorageProvider
   *   instance, or a getter function returning the current StorageProvider
   *   (so an async Redis upgrade is picked up automatically).
   * @param {string} [opts.prefix='gatewayKey'] - storage namespace prefix
   */
  constructor(opts = {}) {
    this.keys = [];
    this.keysByKey = new Map();
    this.loaded = false;
    this._store = opts.storageProvider || null;
    this._prefix = opts.prefix || 'gatewayKey';
    this._migrationDone = false;
    this._managed = new Set(); // ids explicitly written via store methods
  }

  /** Resolve the current StorageProvider (instance or getter). */
  _getStore() {
    const s = this._store;
    if (typeof s === 'function') return s();
    return s;
  }

  _storageKey(id) {
    return `${this._prefix}:${id}`;
  }

  /**
   * Whether a fully-prefixed storage key (including the storage provider's own
   * namespace) belongs to this store's key namespace.
   */
  _isNamespaceKey(fullKey) {
    return fullKey.includes(`${this._prefix}:`);
  }

  /** Persist a full key record (fire-and-forget). */
  _persist(record) {
    const store = this._getStore();
    if (!store || !record) return Promise.resolve();
    return store.set(this._storageKey(record.id), this._serialize(record)).catch((err) => {
      logger.warn('ApiKeyStore: persist failed', { id: record.id, error: err.message });
    });
  }

  /** Delete a key record from storage (fire-and-forget). */
  _remove(id) {
    const store = this._getStore();
    if (!store || !id) return Promise.resolve();
    return store.del(this._storageKey(id)).catch(() => {});
  }

  /** Lightweight migration marker read/write. */
  async _migrationFlag() {
    const store = this._getStore();
    if (!store) return false;
    try {
      return !!(await store.get(`${this._prefix}:migrationDone`));
    } catch {
      return false;
    }
  }

  async _setMigrationFlag() {
    const store = this._getStore();
    if (!store) return;
    try {
      await store.set(`${this._prefix}:migrationDone`, { doneAt: Date.now() });
    } catch (_) {}
  }

  /**
   * Strip volatile/functions before persisting so the stored record is a plain
   * JSON-serializable object.
   */
  _serialize(record) {
    const out = { ...record };
    delete out._persistedAt;
    return out;
  }

  /**
   * Load (or reload) API key definitions from config.
   *
   * Synchronous and backward compatible: `this.keys`/`this.keysByKey` are
   * populated immediately. When a StorageProvider is attached, an async
   * post-load pass (migration + restore) is triggered in the background.
   *
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

    // Async: migrate config -> storage (once) + restore persisted state.
    this._postLoadPromise = this._postLoad().catch((err) => {
      logger.warn('ApiKeyStore: post-load hydration failed', { error: err.message });
    });

    logger.info('ApiKeyStore initialized', {
      total: keys.length,
      active: this.getActiveKeys().length,
      enabled: this.isEnabled(),
    });
    return this;
  }

  /**
   * Post-load pass: run the one-time config -> storage migration, then
   * restore the full persisted state (admin-created keys, status changes,
   * usage counters, restrictions, etc.) into the in-memory cache.
   * @private
   */
  async _postLoad() {
    const store = this._getStore();
    if (!store) return;

    const migrated = await this._migrationFlag();
    if (!migrated) {
      await this._migrateConfigToStorage();
    }
    await this._restoreFromStorage();
  }

  /**
   * Import all currently-loaded config keys into storage. Guarded by the
   * migration flag so it runs once. Skips ids already present in storage
   * (no duplicates) and never deletes existing (e.g. admin-created) records.
   * @returns {Promise<{imported: number, skipped: number}>}
   * @private
   */
  async _migrateConfigToStorage() {
    const store = this._getStore();
    if (!store) return { imported: 0, skipped: 0 };

    let imported = 0;
    let skipped = 0;
    for (const record of this.keys) {
      const existing = await store.get(this._storageKey(record.id));
      if (existing) {
        skipped += 1;
        continue;
      }
      await this._persist(record);
      imported += 1;
    }
    await this._setMigrationFlag();

    logger.info('ApiKeyStore: config -> storage migration complete', { imported, skipped });
    return { imported, skipped };
  }

  /**
   * Restore the full persisted state from storage into the in-memory cache.
   * For each persisted id, the persisted record is authoritative and replaces
   * any config-loaded record with the same id. Records that exist only in
   * storage (created via the admin API) are appended.
   * @returns {Promise<number>} number of records restored
   * @private
   */
  async _restoreFromStorage() {
    const store = this._getStore();
    if (!store) return 0;

    let allKeys;
    try {
      // NOTE: storage.keys() returns FULLY-prefixed keys (including the storage
      // provider's own namespace), so we match on our namespace marker and rely
      // on the stored record's own `id` field rather than parsing the key.
      allKeys = await store.keys('*');
    } catch {
      return 0;
    }

    const records = [];
    let restored = 0;
    for (const fullKey of allKeys) {
      if (!this._isNamespaceKey(fullKey)) continue;
      const marker = `${this._prefix}:`;
      const idx = fullKey.indexOf(marker);
      // fullKey is storage-prefixed; truncate back to our own namespace key so
      // the storage provider applies its prefix exactly once on read.
      const unprefixed = fullKey.slice(idx);
      const id = unprefixed.slice(marker.length);
      if (!id || id === 'migrationDone') continue;
      let rec;
      try {
        rec = await store.get(unprefixed);
      } catch {
        rec = null;
      }
      if (!rec || typeof rec !== 'object') continue;
      records.push(rec);
    }

    // Merge restored records into the in-memory cache. Records explicitly
    // written via createKey/updateKey/recordUsage are already persisted, so we
    // skip them here to avoid clobbering newer state with a stale snapshot.
    const byKey = new Map(this.keys.map((r) => [r.key, r]));
    for (const r of records) {
      if (this._managed.has(r.id)) continue;
      if (r.key) byKey.set(r.key, r);
    }
    this.keys = [...byKey.values()];
    this.keysByKey = byKey;
    restored = records.length;

    if (restored > 0) {
      logger.info('ApiKeyStore: restored persisted state', {
        total: this.keys.length,
        restored,
        active: this.getActiveKeys().length,
      });
    }
    return restored;
  }

  /**
   * Explicitly run the config -> storage migration (idempotent). Intended for
   * startup/tooling; `load()` triggers it automatically.
   * @returns {Promise<object>}
   */
  async migrate() {
    const store = this._getStore();
    if (!store) return { imported: 0, skipped: 0, error: 'no storage provider' };
    const result = await this._migrateConfigToStorage();
    return result;
  }

  /**
   * Explicitly restore persisted state from storage. `load()` triggers this
   * automatically. Returns the number of records restored.
   * @returns {Promise<number>}
   */
  async hydrate() {
    // Await any in-flight post-load migration/restore first so callers get a
    // fully-hydrated view.
    if (this._postLoadPromise) {
      await this._postLoadPromise;
    }
    return this._restoreFromStorage();
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
   * Record usage for a key. Increments `usageCount` and updates `lastUsed`,
   * then persists. Called from the auth middleware alongside the usage
   * tracker so the counter survives a restart.
   * @param {string} keyId
   * @returns {Promise<void>}
   */
  async recordUsage(keyId) {
    const record = this.keys.find((k) => k.id === keyId);
    if (!record) return;
    const now = Math.floor(Date.now() / 1000);
    record.lastUsed = now;
    record.usageCount = (typeof record.usageCount === 'number' ? record.usageCount : 0) + 1;
    record.updatedAt = now;
    this._managed.add(record.id);
    await this._persist(record);
  }

  /**
   * Create a new key. Adds it to the in-memory cache and persists it.
   * Returns the created record (raw, with key).
   * @param {object} payload
   * @returns {Promise<object>}
   */
  async createKey(payload = {}) {
    const now = Math.floor(Date.now() / 1000);
    const key = payload.key;
    const record = {
      id: payload.id || key,
      key,
      name: payload.name || `key-${now}`,
      description: payload.description,
      status: this._resolveStatus(payload),
      role: payload.role === 'admin' ? 'admin' : 'user',
      expiresAt: typeof payload.expiresAt === 'number' ? payload.expiresAt : undefined,
      allowedProviders: Array.isArray(payload.allowedProviders) ? payload.allowedProviders : undefined,
      deniedProviders: Array.isArray(payload.deniedProviders) ? payload.deniedProviders : undefined,
      allowedModels: Array.isArray(payload.allowedModels) ? payload.allowedModels : undefined,
      deniedModels: Array.isArray(payload.deniedModels) ? payload.deniedModels : undefined,
      permissions: Array.isArray(payload.permissions) ? payload.permissions : payload.permissions,
      rateLimit: payload.rateLimit,
      quota: payload.quota,
      metadata: payload.metadata,
      tags: Array.isArray(payload.tags) ? payload.tags : undefined,
      createdAt: now,
      updatedAt: now,
      lastUsed: typeof payload.lastUsed === 'number' ? payload.lastUsed : null,
      usageCount: typeof payload.usageCount === 'number' ? payload.usageCount : 0,
    };
    this.keys.push(record);
    this.keysByKey.set(record.key, record);
    this._managed.add(record.id);
    await this._persist(record);
    return record;
  }

  /**
   * Update a key's fields by id. Returns the updated record, or null when the
   * key does not exist. Persists when anything changed.
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object|null>}
   */
  async updateKey(id, patch = {}) {
    const record = this.keys.find((k) => k.id === id);
    if (!record) return null;

    const allowed = [
      'status', 'role', 'expiresAt', 'name', 'description', 'allowedProviders',
      'deniedProviders', 'allowedModels', 'deniedModels', 'permissions',
      'rateLimit', 'quota', 'metadata', 'tags', 'enabled', 'revoked',
    ];
    let changed = false;
    for (const field of allowed) {
      if (patch[field] === undefined) continue;
      if (field === 'enabled') {
        record.status = patch[field] ? 'active' : 'inactive';
      } else if (field === 'revoked') {
        if (patch[field]) record.status = 'inactive';
      } else {
        record[field] = patch[field];
      }
      changed = true;
    }

    if (changed) {
      record.updatedAt = Math.floor(Date.now() / 1000);
      // Rebuild the key index in case the key value changed.
      if (patch.key && patch.key !== record.key) {
        this.keysByKey.delete(record.key);
        record.key = patch.key;
        this.keysByKey.set(record.key, record);
      }
      this._managed.add(record.id);
      await this._persist(record);
    }
    return record;
  }

  /**
   * Delete a key by id. Removes it from the cache and storage.
   * Returns true when removed, false when not found.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async deleteKey(id) {
    const idx = this.keys.findIndex((k) => k.id === id);
    if (idx < 0) return false;
    const [record] = this.keys.splice(idx, 1);
    this.keysByKey.delete(record.key);
    await this._remove(id);
    return true;
  }

  /**
   * Resolve `status` from a payload, honoring the new `enabled`/`revoked`
   * fields while remaining backward compatible with the existing `status`.
   * @private
   */
  _resolveStatus(payload) {
    if (payload.revoked) return 'inactive';
    if (payload.enabled !== undefined) return payload.enabled ? 'active' : 'inactive';
    return payload.status === 'inactive' ? 'inactive' : 'active';
  }

  /**
   * Check whether a key is allowed to access a specific provider. When the
   * key has no `allowedProviders` restriction, all providers are allowed.
   * @param {object} keyRecord
   * @param {string} providerId
   * @returns {boolean}
   */
  canAccessProvider(keyRecord, providerId) {
    if (!keyRecord) return true;
    if (Array.isArray(keyRecord.deniedProviders) && keyRecord.deniedProviders.includes(providerId)) {
      return false;
    }
    if (!keyRecord.allowedProviders) return true;
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
    if (!keyRecord) return true;
    if (Array.isArray(keyRecord.deniedModels) && keyRecord.deniedModels.includes(modelId)) {
      return false;
    }
    if (!keyRecord.allowedModels) return true;
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
   */
  publicView(k) {
    return {
      id: k.id,
      name: k.name,
      description: k.description,
      status: k.status,
      role: k.role || 'user',
      expiresAt: k.expiresAt,
      allowedProviders: k.allowedProviders,
      deniedProviders: k.deniedProviders,
      allowedModels: k.allowedModels,
      deniedModels: k.deniedModels,
      permissions: k.permissions,
      rateLimit: k.rateLimit,
      quota: k.quota,
      metadata: k.metadata,
      tags: k.tags,
      createdAt: k.createdAt,
      updatedAt: k.updatedAt,
      lastUsed: k.lastUsed,
      usageCount: k.usageCount,
      keyPrefix: k.key ? `${k.key.slice(0, 4)}...${k.key.slice(-4)}` : '',
    };
  }

  /**
   * Return a public (redacted) view of a key record — never exposes the raw
   * key value, only a masked prefix.
   * @param {object} k
   * @returns {object}
   * @private
   */
  _publicView(k) {
    return this.publicView(k);
  }
}

module.exports = ApiKeyStore;
