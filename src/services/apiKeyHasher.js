const crypto = require('crypto');

/**
 * ApiKeyHasher
 *
 * Centralized, dependency-free secret handling for gateway API keys. This is
 * the ONLY place that knows how a raw API key is generated, hashed, and
 * fingerprinted — controllers, stores, and middleware never re-implement any
 * of this logic.
 *
 * Design:
 *   - generate(): cryptographically-secure random key with a recognizable,
 *     non-secret prefix (default "sk-gw-") so operators can tell gateway keys
 *     apart. The random material is 32 bytes (256 bits) base62-encoded.
 *   - hash(rawKey): deterministic SHA-256 hex digest. The digest is what gets
 *     persisted; the raw key is shown to the operator exactly once at creation
 *     and never stored.
 *   - fingerprint(rawKey): a short, non-reversible identifier ("keyPrefix")
 *     safe to display in lists/logs — first 8 chars of the visible prefix plus
 *     the last 4 chars of the key. Never enough to reconstruct the key.
 *   - verify(rawKey, keyHash): constant-time comparison of the hash.
 *
 * SHA-256 is used (not bcrypt/scrypt) because gateway API keys are
 * high-entropy random tokens (256 bits), not user-chosen passwords — a slow
 * KDF adds latency to every request without adding meaningful brute-force
 * resistance for 256-bit random input. This matches the existing
 * EncryptionService approach (also SHA-256 based) and keeps validation on the
 * hot path cheap.
 */
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const DEFAULT_PREFIX = 'sk-gw-';

function base62Encode(buf) {
  // Encode raw bytes into a base62 string (bijective enough for a token).
  let out = '';
  for (let i = 0; i < buf.length; i += 1) {
    out += BASE62[buf[i] % 62];
  }
  return out;
}

class ApiKeyHasher {
  /**
   * @param {object} [opts]
   * @param {string} [opts.prefix='sk-gw-'] - visible, non-secret key prefix
   */
  constructor(opts = {}) {
    this._prefix = opts.prefix || DEFAULT_PREFIX;
  }

  /**
   * Generate a new cryptographically-secure API key.
   * @param {object} [opts]
   * @param {string} [opts.prefix] - override the key prefix for this key
   * @returns {{ rawKey:string, keyHash:string, keyPrefix:string }}
   */
  generate(opts = {}) {
    const prefix = opts.prefix || this._prefix;
    const random = base62Encode(crypto.randomBytes(32));
    const rawKey = `${prefix}${random}`;
    return {
      rawKey,
      keyHash: this.hash(rawKey),
      keyPrefix: this.fingerprint(rawKey),
    };
  }

  /**
   * Compute the deterministic hash of a raw key. This is what is persisted.
   * @param {string} rawKey
   * @returns {string} hex SHA-256 digest
   */
  hash(rawKey) {
    if (!rawKey || typeof rawKey !== 'string') return null;
    return crypto.createHash('sha256').update(rawKey).digest('hex');
  }

  /**
   * Compute a short, non-reversible fingerprint safe for display/logging.
   * Format: "<first 8 chars>...<last 4 chars>".
   * @param {string} rawKey
   * @returns {string}
   */
  fingerprint(rawKey) {
    if (!rawKey || typeof rawKey !== 'string') return '';
    if (rawKey.length <= 12) return `${rawKey.slice(0, 2)}...`;
    return `${rawKey.slice(0, 8)}...${rawKey.slice(-4)}`;
  }

  /**
   * Constant-time verify a presented raw key against a stored hash.
   * @param {string} rawKey
   * @param {string} keyHash - stored hex digest
   * @returns {boolean}
   */
  verify(rawKey, keyHash) {
    if (!rawKey || !keyHash) return false;
    const computed = this.hash(rawKey);
    if (!computed || computed.length !== keyHash.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(keyHash));
    } catch {
      return false;
    }
  }
}

module.exports = ApiKeyHasher;
module.exports.DEFAULT_PREFIX = DEFAULT_PREFIX;
