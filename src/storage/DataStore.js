/**
 * DataStore
 *
 * A Map-like data structure that syncs through an optional StorageProvider.
 * Writes go to both the in-memory cache (for fast sync reads) and the
 * storage backend (for persistence across restarts). Reads come from the
 * in-memory cache.
 *
 * When no storageProvider is given (or it's null), this behaves exactly
 * like a regular Map — perfect for backward compatibility.
 *
 * The store is NOT generic — it stores JSON-serializable values. For
 * mutable objects (like counters), callers must explicitly write back
 * after mutation via set() or the dedicated incr() method.
 *
 * Usage:
 *   const store = new DataStore({ name: 'my-service', storage });
 *   await store.set('key', { count: 1 });
 *   const val = await store.get('key');
 *   await store.incr('counter');    // atomic increment via storage
 *   await store.delete('key');
 */

const logger = require('../utils/logger');

class DataStore {
  /**
   * @param {object} opts
   * @param {string} opts.name - human-readable name for log messages
   * @param {object} [opts.storage] - StorageProvider instance (optional)
   * @param {string} [opts.prefix] - sub-namespace within the storage prefix
   * @param {boolean} [opts.syncOnWrite=true] - write-through to storage
   */
  constructor(opts = {}) {
    if (!opts.name) throw new Error('DataStore requires a name');
    this.name = opts.name;
    this._cache = new Map();
    this._storage = opts.storage || null;
    this._prefix = opts.prefix || '';
    this._sync = opts.syncOnWrite !== false;
  }

  _storageKey(key) {
    return this._prefix ? `${this._prefix}:${key}` : key;
  }

  /**
   * Set a value. Writes to cache and (optionally) storage.
   */
  async set(key, value, ttlMs) {
    this._cache.set(key, value);
    if (this._storage && this._sync) {
      try {
        await this._storage.set(this._storageKey(key), value, ttlMs);
      } catch (err) {
        logger.warn(`DataStore(${this.name}): set failed`, { key, error: err.message });
      }
    }
  }

  /**
   * Get a value from cache (or storage on cache miss).
   */
  async get(key) {
    if (this._cache.has(key)) return this._cache.get(key);
    if (this._storage) {
      try {
        const val = await this._storage.get(this._storageKey(key));
        if (val !== null) {
          this._cache.set(key, val);
          return val;
        }
      } catch (err) {
        logger.warn(`DataStore(${this.name}): get failed`, { key, error: err.message });
      }
    }
    return undefined;
  }

  /**
   * Check if a key exists.
   */
  async has(key) {
    if (this._cache.has(key)) return true;
    if (this._storage) {
      try {
        const exists = await this._storage.has(this._storageKey(key));
        return exists;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Delete a key from cache and storage.
   */
  async delete(key) {
    const existed = this._cache.delete(key);
    if (this._storage) {
      try {
        const deleted = await this._storage.del(this._storageKey(key));
        return deleted || existed;
      } catch {
        return existed;
      }
    }
    return existed;
  }

  /**
   * Atomic increment. When storage is available, the increment is atomic
   * there. When not, it's done in-memory.
   */
  async incr(key, by = 1) {
    if (this._storage) {
      try {
        const newVal = await this._storage.incr(this._storageKey(key), by);
        this._cache.set(key, newVal);
        return newVal;
      } catch (err) {
        logger.warn(`DataStore(${this.name}): incr failed`, { key, error: err.message });
      }
    }
    // Fallback: in-memory increment
    const cur = (typeof this._cache.get(key) === 'number') ? this._cache.get(key) : 0;
    const next = cur + by;
    this._cache.set(key, next);
    return next;
  }

  /**
   * Atomic hash field increment.
   */
  async hincr(key, field, by = 1) {
    if (this._storage) {
      try {
        const newVal = await this._storage.hincr(this._storageKey(key), field, by);
        // Update cache
        let h = this._cache.get(key);
        if (!h || typeof h !== 'object') { h = {}; this._cache.set(key, h); }
        h[field] = newVal;
        return newVal;
      } catch (err) {
        logger.warn(`DataStore(${this.name}): hincr failed`, { key, field, error: err.message });
      }
    }
    // Fallback in-memory
    let h = this._cache.get(key);
    if (!h || typeof h !== 'object') { h = {}; this._cache.set(key, h); }
    const cur = typeof h[field] === 'number' ? h[field] : 0;
    h[field] = cur + by;
    return h[field];
  }

  /**
   * Set hash fields.
   */
  async hset(key, fields) {
    let h = this._cache.get(key);
    if (!h || typeof h !== 'object') { h = {}; this._cache.set(key, h); }
    Object.assign(h, fields);

    if (this._storage) {
      try {
        await this._storage.hset(this._storageKey(key), fields);
      } catch (err) {
        logger.warn(`DataStore(${this.name}): hset failed`, { key, error: err.message });
      }
    }
  }

  /**
   * Get a hash field.
   */
  async hget(key, field) {
    const h = this._cache.get(key);
    if (h && typeof h === 'object' && field in h) return h[field];
    if (this._storage) {
      try {
        const val = await this._storage.hget(this._storageKey(key), field);
        if (val !== null) {
          if (!h || typeof h !== 'object') { this._cache.set(key, {}); }
          this._cache.get(key)[field] = val;
          return val;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Get all hash fields.
   */
  async hgetall(key) {
    const h = this._cache.get(key);
    if (h && typeof h === 'object' && !Array.isArray(h)) return { ...h };
    if (this._storage) {
      try {
        const all = await this._storage.hgetall(this._storageKey(key));
        if (all) {
          this._cache.set(key, { ...all });
          return all;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Delete a hash field.
   */
  async hdel(key, field) {
    let h = this._cache.get(key);
    let existed = false;
    if (h && typeof h === 'object') {
      existed = field in h;
      delete h[field];
    }
    if (this._storage) {
      try {
        await this._storage.hdel(this._storageKey(key), field);
      } catch {
        // ignore
      }
    }
    return existed;
  }

  /**
   * Return all cached keys. Note: this does NOT scan the storage backend.
   */
  cachedKeys() {
    return [...this._cache.keys()];
  }

  /**
   * Return all cached values.
   */
  cachedValues() {
    return [...this._cache.values()];
  }

  /**
   * Return all cached entries.
   */
  cachedEntries() {
    return [...this._cache.entries()];
  }

  /**
   * Number of cached entries.
   */
  get size() {
    return this._cache.size;
  }

  /**
   * Clear all data (cache + storage).
   */
  async clear() {
    this._cache.clear();
    if (this._storage) {
      try {
        // Delete all keys matching our prefix pattern
        const pattern = this._storageKey('*');
        const keys = await this._storage.keys(pattern);
        for (const k of keys) {
          await this._storage.del(k);
        }
      } catch (err) {
        logger.warn(`DataStore(${this.name}): clear failed`, { error: err.message });
      }
    }
  }
}

module.exports = DataStore;
