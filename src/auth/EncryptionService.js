const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * EncryptionService
 *
 * Encrypts and decrypts credential secrets before they are persisted. Uses
 * AES-256-GCM with a secret key derived from the GATEWAY_SECRET_KEY env var
 * (or a stored/generated key file). Every persisted credential is returned as
 * an encrypted envelope so a storage backend compromise does not leak tokens.
 *
 * Interface:
 *   encrypt(plainObject) -> { v, iv, tag, data }   (ct base64)
 *   decrypt(envelope)    -> plainObject
 *
 * The adapter / token manager only ever sees the envelope on disk; plaintext
 * lives only in memory.
 */
class EncryptionService {
  /**
   * @param {object} [opts]
   * @param {string} [opts.secret] - 32-byte secret (hex/base64) or arbitrary string
   * @param {string} [opts.keyPath] - file path to persist a generated key
   */
  constructor(opts = {}) {
    this._algorithm = 'aes-256-gcm';
    this._keyFilePath = opts.keyPath || (process.env.GATEWAY_SECRET_FILE || null);
    this._key = this._loadKey(opts);
    if (!this._key) {
      logger.warn('EncryptionService: no secret key configured; credentials will be stored with a generated process-local key (values will not survive a restart unencrypted). Set GATEWAY_SECRET_KEY for durable encryption.');
      this._key = crypto.randomBytes(32);
      this._ephemeral = true;
    }
  }

  _loadKey(opts) {
    if (opts.secret) {
      return this._deriveKey(opts.secret);
    }
    const env = process.env.GATEWAY_SECRET_KEY;
    if (env) {
      return this._deriveKey(env);
    }
    // Optional: persist a generated key so it survives restarts.
    if (this._keyFilePath) {
      try {
        const fs = require('fs');
        if (fs.existsSync(this._keyFilePath)) {
          const b = Buffer.from(fs.readFileSync(this._keyFilePath, 'utf8').trim(), 'hex');
          if (b.length === 32) return b;
        }
        const k = crypto.randomBytes(32);
        fs.writeFileSync(this._keyFilePath, k.toString('hex'));
        return k;
      } catch (_) {}
    }
    return null;
  }

  _deriveKey(secret) {
    // Deterministically derive a 32-byte key from any secret string.
    return crypto.createHash('sha256').update(String(secret)).digest();
  }

  /**
   * Encrypt a plain object into a JSON-safe envelope.
   * @param {object} plain
   * @returns {{ v:number, iv:string, tag:string, data:string }}
   */
  encrypt(plain) {
    if (plain === undefined || plain === null) return plain;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(this._algorithm, this._key, iv);
    const str = typeof plain === 'string' ? plain : JSON.stringify(plain);
    const enc = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: enc.toString('base64'),
    };
  }

  /**
   * Decrypt an envelope back to a plain object.
   * @param {object|string|*} envelope
   * @returns {*}
   */
  decrypt(envelope) {
    if (!envelope || typeof envelope !== 'object' || !envelope.data || !envelope.iv) {
      return envelope;
    }
    try {
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      const data = Buffer.from(envelope.data, 'base64');
      const decipher = crypto.createDecipheriv(this._algorithm, this._key, iv);
      decipher.setAuthTag(tag);
      const str = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      try { return JSON.parse(str); } catch { return str; }
    } catch (err) {
      logger.error('EncryptionService: decrypt failed', { error: err.message });
      return null;
    }
  }

  /** True when a durable key is configured (survives restart). */
  get isDurable() {
    return !this._ephemeral;
  }
}

module.exports = EncryptionService;
