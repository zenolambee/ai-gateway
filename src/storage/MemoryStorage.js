/**
 * MemoryStorage
 *
 * In-memory implementation of StorageProvider using plain Maps. All data
 * lives in the process heap. This is the default backend — it always works
 * and requires no external dependencies.
 *
 * Keys are namespaced via the prefix option. TTL is checked lazily on read
 * (expired keys act as if deleted).
 */

const StorageProvider = require('./StorageProvider');

class MemoryStorage extends StorageProvider {
  constructor(opts = {}) {
    super(opts);
    this._data = new Map();
    this._ttls = new Map(); // key -> expiresAt (ms timestamp)
    this._sets = new Map(); // key -> Set
  }

  /** Lazily purge expired keys before access. */
  _purge(key) {
    const expiresAt = this._ttls.get(key);
    if (expiresAt && Date.now() >= expiresAt) {
      this._data.delete(key);
      this._ttls.delete(key);
      this._sets.delete(key);
      return true;
    }
    return false;
  }

  _fullKey(key) { return this._key(key); }

  async set(key, value, ttlMs) {
    const k = this._fullKey(key);
    this._data.set(k, value);
    if (ttlMs != null && ttlMs > 0) {
      this._ttls.set(k, Date.now() + ttlMs);
    } else {
      this._ttls.delete(k);
    }
  }

  async get(key) {
    const k = this._fullKey(key);
    this._purge(k);
    return this._data.has(k) ? this._data.get(k) : null;
  }

  async del(key) {
    const k = this._fullKey(key);
    const existed = this._data.has(k);
    this._data.delete(k);
    this._ttls.delete(k);
    this._sets.delete(k);
    return existed;
  }

  async has(key) {
    const k = this._fullKey(key);
    this._purge(k);
    return this._data.has(k);
  }

  async incr(key, by = 1) {
    const k = this._fullKey(key);
    const cur = (typeof this._data.get(k) === 'number') ? this._data.get(k) : 0;
    const next = cur + by;
    this._data.set(k, next);
    return next;
  }

  async decr(key, by = 1) {
    return this.incr(key, -by);
  }

  async hset(key, fields) {
    const k = this._fullKey(key);
    let h = this._data.get(k);
    if (!h || typeof h !== 'object' || Array.isArray(h)) {
      h = {};
      this._data.set(k, h);
    }
    Object.assign(h, fields);
  }

  async hget(key, field) {
    const k = this._fullKey(key);
    this._purge(k);
    const h = this._data.get(k);
    return (h && typeof h === 'object' && !Array.isArray(h)) ? (h[field] !== undefined ? h[field] : null) : null;
  }

  async hgetall(key) {
    const k = this._fullKey(key);
    this._purge(k);
    const h = this._data.get(k);
    return (h && typeof h === 'object' && !Array.isArray(h)) ? { ...h } : null;
  }

  async hincr(key, field, by = 1) {
    const k = this._fullKey(key);
    let h = this._data.get(k);
    if (!h || typeof h !== 'object' || Array.isArray(h)) {
      h = {};
      this._data.set(k, h);
    }
    const cur = typeof h[field] === 'number' ? h[field] : 0;
    h[field] = cur + by;
    return h[field];
  }

  async hdel(key, field) {
    const k = this._fullKey(key);
    const h = this._data.get(k);
    if (h && typeof h === 'object' && !Array.isArray(h)) {
      const existed = field in h;
      delete h[field];
      return existed;
    }
    return false;
  }

  async sadd(key, ...members) {
    const k = this._fullKey(key);
    if (!this._sets.has(k)) {
      this._sets.set(k, new Set());
    }
    const s = this._sets.get(k);
    let added = 0;
    for (const m of members) {
      if (!s.has(m)) { s.add(m); added += 1; }
    }
    return added;
  }

  async smembers(key) {
    const k = this._fullKey(key);
    const s = this._sets.get(k);
    return s ? [...s] : [];
  }

  async srem(key, ...members) {
    const k = this._fullKey(key);
    const s = this._sets.get(k);
    if (!s) return 0;
    let removed = 0;
    for (const m of members) {
      if (s.delete(m)) removed += 1;
    }
    return removed;
  }

  async expire(key, ttlMs) {
    const k = this._fullKey(key);
    if (!this._data.has(k) && !this._sets.has(k)) return false;
    this._ttls.set(k, Date.now() + ttlMs);
    return true;
  }

  async ttl(key) {
    const k = this._fullKey(key);
    if (!this._data.has(k) && !this._sets.has(k)) return -2;
    const expiresAt = this._ttls.get(k);
    if (!expiresAt) return -1;
    const remaining = expiresAt - Date.now();
    return remaining > 0 ? remaining : -2;
  }

  async keys(pattern = '*') {
    const all = [...this._data.keys(), ...this._sets.keys()];
    const unique = [...new Set(all)];
    if (pattern === '*') return unique;
    const re = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return unique.filter((k) => re.test(k));
  }

  async flush() {
    this._data.clear();
    this._ttls.clear();
    this._sets.clear();
  }

  async lock(name, ttlMs = 5000) {
    const k = this._fullKey(`lock:${name}`);
    if (this._data.has(k)) {
      this._purge(k);
      if (this._data.has(k)) return null;
    }
    this._data.set(k, true);
    this._ttls.set(k, Date.now() + ttlMs);
    return {
      release: async () => {
        this._data.delete(k);
        this._ttls.delete(k);
      },
    };
  }

  async ping() { return true; }
}

module.exports = MemoryStorage;
