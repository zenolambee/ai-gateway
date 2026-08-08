const fs = require('fs');
const path = require('path');

const DEFAULT_API_KEYS_FILE = path.join(process.cwd(), 'config', 'apiKeys.json');

/**
 * Expand ${VAR} placeholders inside a string using process.env.
 */
function expandEnvVars(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    return process.env[varName] !== undefined ? process.env[varName] : match;
  });
}

/**
 * Normalize a raw key entry from config/env into a canonical shape.
 *
 * Supported input shapes:
 *   - string                       -> { key: <string>, status: 'active' }
 *   - { key, name, status, ... }   -> as-is with defaults applied
 *
 * @param {string|object} entry
 * @param {number} index
 * @returns {object|null}
 */
function normalizeKeyEntry(entry, index) {
  if (!entry) return null;

  if (typeof entry === 'string') {
    const key = expandEnvVars(entry);
    if (!key) return null;
    return {
      id: key,
      key,
      name: `key-${index}`,
      status: 'active',
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  if (typeof entry === 'object' && !Array.isArray(entry)) {
    const key = expandEnvVars(entry.key);
    // A record is valid when it carries either a plaintext key OR a keyHash
    // (hashed-only records created via the secure-generation path).
    if (!key && !entry.keyHash) return null;
    return {
      id: entry.id || key || (entry.keyHash ? `key_${String(entry.keyHash).slice(0, 16)}` : undefined),
      key: key || undefined,
      keyHash: entry.keyHash,
      keyPrefix: entry.keyPrefix,
      name: entry.name || `key-${index}`,
      status: entry.status === 'inactive' ? 'inactive' : (entry.status === 'revoked' ? 'revoked' : 'active'),
      role: entry.role === 'admin' ? 'admin' : 'user',
      userId: entry.userId,
      expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : undefined,
      allowedProviders: Array.isArray(entry.allowedProviders) ? entry.allowedProviders : undefined,
      allowedModels: Array.isArray(entry.allowedModels) ? entry.allowedModels : undefined,
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Math.floor(Date.now() / 1000),
      description: entry.description,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : undefined,
      revokedAt: typeof entry.revokedAt === 'number' ? entry.revokedAt : undefined,
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : undefined,
      revoked: typeof entry.revoked === 'boolean' ? entry.revoked : undefined,
      lastUsed: typeof entry.lastUsed === 'number' ? entry.lastUsed : undefined,
      usageCount: typeof entry.usageCount === 'number' ? entry.usageCount : 0,
      permissions: entry.permissions,
      deniedProviders: Array.isArray(entry.deniedProviders) ? entry.deniedProviders : undefined,
      deniedModels: Array.isArray(entry.deniedModels) ? entry.deniedModels : undefined,
      rateLimit: entry.rateLimit,
      quota: entry.quota,
      metadata: entry.metadata,
      tags: Array.isArray(entry.tags) ? entry.tags : undefined,
    };
  }

  return null;
}

/**
 * Load API key definitions from config/apiKeys.json and/or the
 * GATEWAY_API_KEYS environment variable.
 *
 * The env var, when set, is a JSON array of key entries (same shape as the
 * JSON file) OR a comma-separated list of bare key strings. Keys from the
 * env var are merged with keys from the file (env takes precedence on
 * duplicate key ids).
 *
 * @param {string} [file] - override path to the api keys config file
 * @returns {Array<object>} normalized key records
 */
function loadApiKeys(file) {
  const keys = [];
  const byId = new Map();

  // 1. Load from JSON file
  const filePath = file || process.env.API_KEYS_CONFIG_FILE || DEFAULT_API_KEYS_FILE;
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw.keys) ? raw.keys : []);
      list.forEach((entry, i) => {
        const rec = normalizeKeyEntry(entry, i);
        if (rec) byId.set(rec.id, rec);
      });
    } catch (err) {
      // surfaced by the caller; return what we have
    }
  }

  // 2. Load from GATEWAY_API_KEYS env var
  const envKeys = process.env.GATEWAY_API_KEYS;
  if (envKeys) {
    let entries;
    try {
      const parsed = JSON.parse(envKeys);
      entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      // comma-separated bare key strings
      entries = envKeys.split(',').map((k) => k.trim()).filter(Boolean);
    }
    entries.forEach((entry, i) => {
      const rec = normalizeKeyEntry(entry, i);
      if (rec) byId.set(rec.id, rec);
    });
  }

  return [...byId.values()];
}

module.exports = {
  loadApiKeys,
  normalizeKeyEntry,
  DEFAULT_API_KEYS_FILE,
};
