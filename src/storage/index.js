/**
 * Storage factory
 *
 * Creates the appropriate StorageProvider based on configuration:
 *
 *   STORAGE_PROVIDER=redis   -> RedisStorage (falls back to MemoryStorage)
 *   STORAGE_PROVIDER=memory  -> MemoryStorage (default)
 *   anything else            -> MemoryStorage
 *
 * When Redis is configured but unavailable, a warning is logged and
 * MemoryStorage is used transparently — the gateway never fails to start
 * due to storage backend issues.
 */

const logger = require('../utils/logger');

let MemoryStorage;
let RedisStorage;

/**
 * @param {object} [opts]
 * @param {string} [opts.provider='memory'] - 'memory' | 'redis'
 * @param {string} [opts.redisUrl]
 * @param {string} [opts.prefix='ai_gateway']
 * @param {object} [opts.fallback] - pre-created MemoryStorage for Redis fallback
 * @returns {Promise<{storage: object, type: string}>}
 */
async function createStorage(opts = {}) {
  const provider = (opts.provider || process.env.STORAGE_PROVIDER || 'memory').toLowerCase();
  const prefix = opts.prefix || process.env.REDIS_PREFIX || 'ai_gateway';
  const redisUrl = opts.redisUrl || process.env.REDIS_URL || null;

  if (provider === 'redis') {
    if (!RedisStorage) RedisStorage = require('./RedisStorage');
    if (!MemoryStorage) MemoryStorage = require('./MemoryStorage');

    const fallback = opts.fallback || new MemoryStorage({ prefix });

    if (!redisUrl) {
      logger.warn('STORAGE_PROVIDER=redis but REDIS_URL is not set — falling back to MemoryStorage');
      return { storage: fallback, type: 'memory' };
    }

    try {
      const storage = new RedisStorage({
        prefix,
        url: redisUrl,
        fallback,
        connectTimeoutMs: 5000,
        maxRetries: 2,
      });

      // Test connectivity with a short timeout. If it fails, fall back.
      const healthy = await Promise.race([
        storage.ping(),
        new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);

      if (healthy) {
        logger.info('Storage: connected to Redis', { prefix, url: redisUrl.replace(/\/\/.*@/, '//***@') });
        return { storage, type: 'redis' };
      }

      logger.warn('Storage: Redis ping failed — falling back to MemoryStorage');
      return { storage: fallback, type: 'memory' };
    } catch (err) {
      logger.warn('Storage: Redis connection failed — falling back to MemoryStorage', { error: err.message });
      return { storage: fallback, type: 'memory' };
    }
  }

  // Default: MemoryStorage
  if (!MemoryStorage) MemoryStorage = require('./MemoryStorage');
  const storage = new MemoryStorage({ prefix });
  return { storage, type: 'memory' };
}

module.exports = { createStorage };
