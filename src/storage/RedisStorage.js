/**
 * RedisStorage
 *
 * Redis-backed implementation of StorageProvider. Uses ioredis. When Redis
 * connection fails, all methods silently fall back to the provided
 * `fallback` MemoryStorage — the gateway never crashes due to Redis being
 * unavailable.
 *
 * All keys are prefixed with the configured namespace to support
 * multi-instance deployments without key collisions.
 */

const StorageProvider = require('./StorageProvider');
const logger = require('../utils/logger');

class RedisStorage extends StorageProvider {
  /**
   * @param {object} [opts]
   * @param {string} [opts.prefix='ai_gateway']
   * @param {string} [opts.url] - Redis URL (e.g. redis://localhost:6379)
   * @param {object} [opts.redis] - pre-configured ioredis instance
   * @param {object} [opts.fallback] - MemoryStorage instance for graceful degradation
   * @param {number} [opts.connectTimeoutMs=5000]
   * @param {number} [opts.maxRetries=3]
   */
  constructor(opts = {}) {
    super({ prefix: opts.prefix || 'ai_gateway' });
    this._fallback = opts.fallback || null;
    this._connected = false;
    this._connectAttempted = false;

    if (opts.redis) {
      this._client = opts.redis;
      this._connected = true;
    } else if (opts.url) {
      this._connectWithRetry(opts);
    } else {
      this._client = null;
    }
  }

  _connectWithRetry(opts) {
    const Redis = this._tryRequireRedis();
    if (!Redis) {
      logger.warn('RedisStorage: ioredis not available, using fallback storage');
      return;
    }

    try {
      this._client = new Redis(opts.url, {
        lazyConnect: true,
        connectTimeout: opts.connectTimeoutMs || 5000,
        maxRetriesPerRequest: null,
        retryStrategy: (times) => {
          if (times > (opts.maxRetries || 3)) {
            logger.warn('RedisStorage: max retries reached, falling back to memory storage');
            this._client = null;
            if (this._client && typeof this._client.disconnect === 'function') {
              try { this._client.disconnect(); } catch (_) {}
            }
            return null; // stop retrying
          }
          return Math.min(times * 200, 2000);
        },
      });

      this._client.on('error', (err) => {
        logger.warn('RedisStorage: connection error', { error: err.message });
        if (!this._connected) {
          this._client = null;
        }
      });

      this._client.on('ready', () => {
        this._connected = true;
        logger.info('RedisStorage: connected');
      });

      this._client.on('close', () => {
        this._connected = false;
      });
    } catch (err) {
      logger.warn('RedisStorage: failed to create client, using fallback', { error: err.message });
      this._client = null;
    }
  }

  _tryRequireRedis() {
    try { return require('ioredis'); } catch { return null; }
  }

  _isReady() {
    return !!(this._client && this._connected);
  }

  _maybeFallback() {
    if (!this._isReady() && this._fallback) {
      return this._fallback;
    }
    return null;
  }

  _prefix(key) { return this._key(key); }

  // ---------------------------------------------------------------
  // Key-value
  // ---------------------------------------------------------------

  async set(key, value, ttlMs) {
    const fb = this._maybeFallback();
    if (fb) return fb.set(key, value, ttlMs);
    const k = this._prefix(key);
    const serialized = JSON.stringify(value);
    if (ttlMs != null && ttlMs > 0) {
      await this._client.set(k, serialized, 'PX', Math.round(ttlMs));
    } else {
      await this._client.set(k, serialized);
    }
  }

  async get(key) {
    const fb = this._maybeFallback();
    if (fb) return fb.get(key);
    const raw = await this._client.get(this._prefix(key));
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  async del(key) {
    const fb = this._maybeFallback();
    if (fb) return fb.del(key);
    const n = await this._client.del(this._prefix(key));
    return n > 0;
  }

  async has(key) {
    const fb = this._maybeFallback();
    if (fb) return fb.has(key);
    const n = await this._client.exists(this._prefix(key));
    return n === 1;
  }

  // ---------------------------------------------------------------
  // Atomic counters
  // ---------------------------------------------------------------

  async incr(key, by = 1) {
    const fb = this._maybeFallback();
    if (fb) return fb.incr(key, by);
    const k = this._prefix(key);
    if (by === 1) return this._client.incr(k);
    return this._client.incrby(k, by);
  }

  async decr(key, by = 1) {
    const fb = this._maybeFallback();
    if (fb) return fb.decr(key, by);
    const k = this._prefix(key);
    if (by === 1) return this._client.decr(k);
    return this._client.decrby(k, by);
  }

  // ---------------------------------------------------------------
  // Hash maps
  // ---------------------------------------------------------------

  async hset(key, fields) {
    const fb = this._maybeFallback();
    if (fb) return fb.hset(key, fields);
    const k = this._prefix(key);
    const entries = [];
    for (const [field, value] of Object.entries(fields)) {
      entries.push(field, JSON.stringify(value));
    }
    if (entries.length > 0) await this._client.hset(k, ...entries);
  }

  async hget(key, field) {
    const fb = this._maybeFallback();
    if (fb) return fb.hget(key, field);
    const raw = await this._client.hget(this._prefix(key), field);
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  async hgetall(key) {
    const fb = this._maybeFallback();
    if (fb) return fb.hgetall(key);
    const raw = await this._client.hgetall(this._prefix(key));
    if (!raw || Object.keys(raw).length === 0) return null;
    const result = {};
    for (const [field, value] of Object.entries(raw)) {
      try { result[field] = JSON.parse(value); } catch { result[field] = value; }
    }
    return result;
  }

  async hincr(key, field, by = 1) {
    const fb = this._maybeFallback();
    if (fb) return fb.hincr(key, field, by);
    return this._client.hincrby(this._prefix(key), field, by);
  }

  async hdel(key, field) {
    const fb = this._maybeFallback();
    if (fb) return fb.hdel(key, field);
    const n = await this._client.hdel(this._prefix(key), field);
    return n > 0;
  }

  // ---------------------------------------------------------------
  // Sets
  // ---------------------------------------------------------------

  async sadd(key, ...members) {
    const fb = this._maybeFallback();
    if (fb) return fb.sadd(key, ...members);
    return this._client.sadd(this._prefix(key), ...members);
  }

  async smembers(key) {
    const fb = this._maybeFallback();
    if (fb) return fb.smembers(key);
    return this._client.smembers(this._prefix(key));
  }

  async srem(key, ...members) {
    const fb = this._maybeFallback();
    if (fb) return fb.srem(key, ...members);
    return this._client.srem(this._prefix(key), ...members);
  }

  // ---------------------------------------------------------------
  // Expiry / TTL
  // ---------------------------------------------------------------

  async expire(key, ttlMs) {
    const fb = this._maybeFallback();
    if (fb) return fb.expire(key, ttlMs);
    const n = await this._client.pexpire(this._prefix(key), Math.round(ttlMs));
    return n === 1;
  }

  async ttl(key) {
    const fb = this._maybeFallback();
    if (fb) return fb.ttl(key);
    return this._client.pttl(this._prefix(key));
  }

  // ---------------------------------------------------------------
  // Scan
  // ---------------------------------------------------------------

  async keys(pattern = '*') {
    const fb = this._maybeFallback();
    if (fb) return fb.keys(pattern);
    const fullPattern = this._prefix(pattern);
    let cursor = '0';
    const results = [];
    do {
      const [nextCursor, keys] = await this._client.scan(cursor, 'MATCH', fullPattern, 'COUNT', 100);
      cursor = nextCursor;
      results.push(...keys);
    } while (cursor !== '0');
    return results;
  }

  async flush() {
    const fb = this._maybeFallback();
    if (fb) return fb.flush();
    const allKeys = await this.keys('*');
    for (const k of allKeys) {
      await this._client.del(k);
    }
  }

  // ---------------------------------------------------------------
  // Lock
  // ---------------------------------------------------------------

  async lock(name, ttlMs = 5000) {
    const fb = this._maybeFallback();
    if (fb) return fb.lock(name, ttlMs);
    const k = this._prefix(`lock:${name}`);
    const acquired = await this._client.set(k, '1', 'PX', Math.round(ttlMs), 'NX');
    if (!acquired) return null;
    return {
      release: async () => { await this._client.del(k); },
    };
  }

  // ---------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------

  async ping() {
    const fb = this._maybeFallback();
    if (fb) return fb.ping();
    if (!this._isReady()) return false;
    try {
      const result = await this._client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Gracefully close the Redis connection.
   */
  async close() {
    if (this._client && typeof this._client.quit === 'function') {
      try { await this._client.quit(); } catch (_) {}
    }
    this._connected = false;
  }
}

module.exports = RedisStorage;
