/**
 * StorageProvider
 *
 * Abstract storage interface for gateway state. Every method has a sensible
 * default (no-op or throws) so implementations need only override what they
 * support.
 *
 * Two built-in implementations:
 *   MemoryStorage  — in-memory Maps (default, always works)
 *   RedisStorage   — Redis-backed (requires ioredis, fallback to memory on
 *                    connection failure)
 *
 * All keys are namespaced (prefix) to support multi-instance deployments.
 * All values are JSON-serialized. TTL is optional per key.
 */

class StorageProvider {
  /**
   * @param {object} [opts]
   * @param {string} [opts.prefix=''] - key namespace prefix
   */
  constructor(opts = {}) {
    this.prefix = opts.prefix || '';
  }

  /** Full key with prefix applied. */
  _key(k) { return this.prefix ? `${this.prefix}:${k}` : k; }

  // ---------------------------------------------------------------
  // Key-value
  // ---------------------------------------------------------------

  /**
   * Set a value. When ttlMs is provided, the key auto-expires.
   * @param {string} key
   * @param {*} value - JSON-serializable value
   * @param {number} [ttlMs]
   * @returns {Promise<void>}
   */
  async set(key, value, ttlMs) { throw new Error('Not implemented'); }

  /**
   * Get a value. Returns null when not found or expired.
   * @param {string} key
   * @returns {Promise<*>}
   */
  async get(key) { throw new Error('Not implemented'); }

  /**
   * Delete a key.
   * @param {string} key
   * @returns {Promise<boolean>} true if deleted
   */
  async del(key) { throw new Error('Not implemented'); }

  /**
   * Check if a key exists.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async has(key) { throw new Error('Not implemented'); }

  // ---------------------------------------------------------------
  // Atomic counters
  // ---------------------------------------------------------------

  /**
   * Atomic increment. Returns the new value.
   * @param {string} key
   * @param {number} [by=1]
   * @returns {Promise<number>}
   */
  async incr(key, by = 1) { throw new Error('Not implemented'); }

  /**
   * Atomic decrement. Returns the new value.
   * @param {string} key
   * @param {number} [by=1]
   * @returns {Promise<number>}
   */
  async decr(key, by = 1) { throw new Error('Not implemented'); }

  // ---------------------------------------------------------------
  // Hash maps (groups of fields under one key)
  // ---------------------------------------------------------------

  /**
   * Set one or more fields in a hash.
   * @param {string} key
   * @param {object} fields - { fieldName: value, ... }
   * @returns {Promise<void>}
   */
  async hset(key, fields) { throw new Error('Not implemented'); }

  /**
   * Get a single field from a hash.
   * @param {string} key
   * @param {string} field
   * @returns {Promise<*>}
   */
  async hget(key, field) { throw new Error('Not implemented'); }

  /**
   * Get all fields from a hash.
   * @param {string} key
   * @returns {Promise<object|null>}
   */
  async hgetall(key) { throw new Error('Not implemented'); }

  /**
   * Atomic increment a field in a hash. Returns new value.
   * @param {string} key
   * @param {string} field
   * @param {number} [by=1]
   * @returns {Promise<number>}
   */
  async hincr(key, field, by = 1) { throw new Error('Not implemented'); }

  /**
   * Delete a field from a hash.
   * @param {string} key
   * @param {string} field
   * @returns {Promise<boolean>}
   */
  async hdel(key, field) { throw new Error('Not implemented'); }

  // ---------------------------------------------------------------
  // Sets
  // ---------------------------------------------------------------

  /**
   * Add members to a set.
   * @param {string} key
   * @param {...string} members
   * @returns {Promise<number>} number of new members added
   */
  async sadd(key, ...members) { throw new Error('Not implemented'); }

  /**
   * Get all members of a set.
   * @param {string} key
   * @returns {Promise<string[]>}
   */
  async smembers(key) { throw new Error('Not implemented'); }

  /**
   * Remove members from a set.
   * @param {string} key
   * @param {...string} members
   * @returns {Promise<number>}
   */
  async srem(key, ...members) { throw new Error('Not implemented'); }

  // ---------------------------------------------------------------
  // Expiry / TTL
  // ---------------------------------------------------------------

  /**
   * Set a TTL on a key (in milliseconds).
   * @param {string} key
   * @param {number} ttlMs
   * @returns {Promise<boolean>}
   */
  async expire(key, ttlMs) { throw new Error('Not implemented'); }

  /**
   * Get the remaining TTL of a key (in milliseconds). Returns -1 when no
   * TTL is set, -2 when the key does not exist.
   * @param {string} key
   * @returns {Promise<number>}
   */
  async ttl(key) { throw new Error('Not implemented'); }

  // ---------------------------------------------------------------
  // Scan / enumeration
  // ---------------------------------------------------------------

  /**
   * Return all keys matching a pattern. Use with caution on large data sets.
   * @param {string} [pattern='*']
   * @returns {Promise<string[]>}
   */
  async keys(pattern = '*') { throw new Error('Not implemented'); }

  /**
   * Clear all data in the current namespace.
   * @returns {Promise<void>}
   */
  async flush() { throw new Error('Not implemented'); }

  // ---------------------------------------------------------------
  // Lock (distributed mutex, best-effort)
  // ---------------------------------------------------------------

  /**
   * Acquire a lock. Returns a lock object or null when already held.
   * @param {string} name
   * @param {number} [ttlMs=5000] - lock auto-release
   * @returns {Promise<{release: Function}|null>}
   */
  async lock(name, ttlMs = 5000) { throw new Error('Not implemented'); }

  // ---------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------

  /**
   * Check if the storage backend is healthy.
   * @returns {Promise<boolean>}
   */
  async ping() { return true; }
}

module.exports = StorageProvider;
