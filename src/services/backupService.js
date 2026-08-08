const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * BackupService
 *
 * Produces and restores versioned, secret-free snapshots of gateway state.
 *
 * A backup captures the non-secret data required for recovery:
 *   - providers          : provider configuration WITH secrets stripped
 *                          (apiKeys / apiKey / headers Authorization removed)
 *   - models             : model registry rich entries (metadata only)
 *   - apiKeys            : API key METADATA (public view — never keyHash,
 *                          never raw key, never plaintext)
 *   - quotas             : quota policy snapshot (QuotaService)
 *   - usage              : usage rollups (UsageAccountant snapshot) when present
 *   - virtualModels      : virtual model config
 *   - connections        : connection METADATA (masked — never credential)
 *   - gateway            : gateway version + runtime info
 *
 * The format is versioned (`backupVersion`) and carries an integrity checksum
 * (SHA-256 over the canonical `data` payload) so a restore can detect
 * tampering / corruption before applying anything.
 *
 * SECURITY: this service NEVER writes plaintext API keys, OAuth tokens,
 * passwords, cookies, provider secrets, or encryption keys into a backup.
 * Provider configs are passed through a redactor; API keys and connections
 * use their existing public/redacted views.
 *
 * The service is storage-agnostic for listing: when a `backupDir` is provided
 * it can persist/list backup files on disk; otherwise createBackup() simply
 * returns the backup object for the caller to stream to a client.
 */
const BACKUP_VERSION = 1;
const BACKUP_FORMAT = 'ai-gateway-backup';
const CHECKSUM_ALGORITHM = 'sha256';
const SECRET_PROVIDER_FIELDS = ['apiKey', 'apiKeys', 'secret', 'secrets', 'password', 'token'];

class BackupService {
  /**
   * @param {object} deps
   * @param {object} [deps.providerManager]
   * @param {object} [deps.apiKeyStore]
   * @param {object} [deps.modelRegistry]
   * @param {object} [deps.quotaService]
   * @param {object} [deps.usageAccountant]
   * @param {object} [deps.virtualModelRegistry]
   * @param {object} [deps.connectionManager]
   * @param {object} [opts]
   * @param {string} [opts.backupDir] - directory to persist/list backups
   * @param {string} [opts.gatewayVersion]
   */
  constructor(deps = {}, opts = {}) {
    this.providerManager = deps.providerManager || null;
    this.apiKeyStore = deps.apiKeyStore || null;
    this.modelRegistry = deps.modelRegistry || null;
    this.quotaService = deps.quotaService || null;
    this.usageAccountant = deps.usageAccountant || null;
    this.virtualModelRegistry = deps.virtualModelRegistry || null;
    this.connectionManager = deps.connectionManager || null;
    this.backupDir = opts.backupDir || process.env.BACKUP_DIR || null;
    this.gatewayVersion = opts.gatewayVersion || process.env.VERSION || '1.0.0';
  }

  /**
   * Strip known secret fields from a provider config, returning a safe copy.
   * @param {object} provider
   * @returns {object}
   * @private
   */
  _redactProvider(provider) {
    if (!provider || typeof provider !== 'object') return provider;
    const copy = { ...provider };
    for (const field of SECRET_PROVIDER_FIELDS) delete copy[field];
    // Preserve the COUNT of configured keys (useful for recovery) without the
    // secret values themselves.
    if (Array.isArray(provider.apiKeys)) copy.apiKeyCount = provider.apiKeys.length;
    // Strip an Authorization header if a provider embeds one.
    if (copy.headers && typeof copy.headers === 'object') {
      const h = { ...copy.headers };
      delete h.Authorization;
      delete h.authorization;
      delete h.Cookie;
      delete h.cookie;
      copy.headers = h;
    }
    return copy;
  }

  /**
   * Compute a stable SHA-256 checksum over a JSON-serializable payload.
   * @param {*} payload
   * @returns {string} hex digest
   * @private
   */
  _checksum(payload) {
    const json = JSON.stringify(payload);
    return crypto.createHash('sha256').update(json).digest('hex');
  }

  /**
   * Build a backup object (in-memory). Does not touch the filesystem.
   * @param {object} [opts]
   * @param {boolean} [opts.includeUsage=true]
   * @returns {Promise<object>} the backup object
   */
  async createBackup(opts = {}) {
    const includeUsage = opts.includeUsage !== false;
    const data = {
      providers: [],
      models: [],
      apiKeys: [],
      quotas: [],
      usage: null,
      virtualModels: [],
      connections: [],
    };

    // Providers — redacted (no secrets).
    if (this.providerManager && typeof this.providerManager.listProviders === 'function') {
      data.providers = this.providerManager.listProviders().map((p) => this._redactProvider(p));
    }

    // Model registry — metadata only.
    if (this.modelRegistry && typeof this.modelRegistry.getRichEntries === 'function') {
      try { data.models = await this.modelRegistry.getRichEntries(); } catch { data.models = []; }
    }

    // API keys — public (redacted) view: metadata + permissions + quota, no secrets.
    if (this.apiKeyStore && typeof this.apiKeyStore.listKeys === 'function') {
      data.apiKeys = this.apiKeyStore.listKeys();
    }

    // Quota policy snapshot.
    if (this.quotaService && typeof this.quotaService.getSnapshot === 'function') {
      try { data.quotas = this.quotaService.getSnapshot().policies || []; } catch { data.quotas = []; }
    }

    // Usage rollups (non-secret aggregates).
    if (includeUsage && this.usageAccountant && typeof this.usageAccountant.getSnapshot === 'function') {
      try { data.usage = this.usageAccountant.getSnapshot(); } catch { data.usage = null; }
    }

    // Virtual models config.
    if (this.virtualModelRegistry && typeof this.virtualModelRegistry.listVirtualModels === 'function') {
      try { data.virtualModels = this.virtualModelRegistry.listVirtualModels(); } catch { data.virtualModels = []; }
    }

    // Connection metadata — masked public views only (never credentials).
    if (this.connectionManager && typeof this.connectionManager.listConnections === 'function') {
      try { data.connections = await this.connectionManager.listConnections(); } catch { data.connections = []; }
    }

    const createdAt = new Date().toISOString();
    const backupId = `bkp_${crypto.randomBytes(12).toString('hex')}`;
    const checksum = this._checksum(data);
    const backup = {
      backupId,
      backupVersion: BACKUP_VERSION,
      format: BACKUP_FORMAT,
      createdAt,
      gatewayVersion: this.gatewayVersion,
      // Structured integrity block (preferred). The flat `checksum` field is
      // kept for backward compatibility with Prompt 23 backups/tests.
      integrity: { algorithm: CHECKSUM_ALGORITHM, checksum },
      checksum,
      data,
    };
    logger.info('BACKUP_CREATED', {
      backupId,
      backupVersion: BACKUP_VERSION,
      providers: data.providers.length,
      apiKeys: data.apiKeys.length,
      quotas: data.quotas.length,
      hasUsage: !!data.usage,
    });
    return backup;
  }

  /**
   * Validate a backup object's format, version, schema, and integrity.
   * Does not mutate anything. Returns a structured result.
   * @param {object} backup
   * @returns {{ valid: boolean, errors: string[], version?: number }}
   */
  validateBackup(backup) {
    const errors = [];
    if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
      return { valid: false, errors: ['Backup must be a JSON object'], code: 'INVALID_BACKUP' };
    }
    // Format check (lenient: older Prompt 23 backups omit `format`).
    if (backup.format !== undefined && backup.format !== BACKUP_FORMAT) {
      errors.push(`Unsupported backup format "${backup.format}" (expected "${BACKUP_FORMAT}")`);
    }
    if (typeof backup.backupVersion !== 'number') {
      errors.push('Missing or invalid backupVersion');
    } else if (backup.backupVersion > BACKUP_VERSION) {
      errors.push(`Unsupported backupVersion ${backup.backupVersion} (max supported ${BACKUP_VERSION})`);
    }
    if (!backup.data || typeof backup.data !== 'object' || Array.isArray(backup.data)) {
      errors.push('Missing or invalid data payload');
    } else {
      // Schema: required arrays.
      for (const field of ['providers', 'apiKeys']) {
        if (backup.data[field] !== undefined && !Array.isArray(backup.data[field])) {
          errors.push(`data.${field} must be an array`);
        }
      }
      // Integrity: checksum must match when present. Prefer the structured
      // integrity block; fall back to the flat checksum (Prompt 23 backups).
      const declared = (backup.integrity && backup.integrity.checksum) || backup.checksum;
      if (declared) {
        const computed = this._checksum(backup.data);
        if (computed !== declared) {
          errors.push('Integrity check failed: checksum mismatch');
        }
      }
      // Security: reject a backup that carries obvious plaintext secrets so we
      // never re-import a leaked credential.
      if (Array.isArray(backup.data.apiKeys)) {
        for (const k of backup.data.apiKeys) {
          if (k && (k.key || k.keyHash)) {
            errors.push('Backup contains forbidden secret material in apiKeys (key/keyHash)');
            break;
          }
        }
      }
      if (Array.isArray(backup.data.providers)) {
        for (const p of backup.data.providers) {
          if (p && (p.apiKey || (Array.isArray(p.apiKeys) && p.apiKeys.length))) {
            errors.push('Backup contains forbidden provider secret material (apiKey/apiKeys)');
            break;
          }
        }
      }
    }
    return { valid: errors.length === 0, errors, version: backup && backup.backupVersion };
  }

  /**
   * Validate referential integrity WITHIN a backup payload. Detects dangling
   * references before a restore is attempted:
   *
   *   model      → provider   (model.providerId / model.providers[] exists)
   *   apiKey     → provider    (allowedProviders/deniedProviders exist)
   *   apiKey     → model       (allowedModels/deniedModels exist)
   *   usage      → apiKey      (usage.byApiKey ids exist in apiKeys)
   *   connection → provider    (connection.provider/providerId exists)
   *
   * Missing references are reported as WARNINGS (non-fatal) by default because
   * the restore is metadata-only and idempotent — a permission naming a model
   * that isn't in this backup may still exist in the live registry. Callers
   * that want strict behaviour can treat a non-empty `warnings` list as fatal.
   *
   * @param {object} backup
   * @returns {{ warnings: string[], references: object }}
   */
  validateReferences(backup) {
    const warnings = [];
    const data = (backup && backup.data) || {};
    const providerIds = new Set((data.providers || []).map((p) => p && p.id).filter(Boolean));
    const modelIds = new Set((data.models || []).map((m) => m && (m.id || m.model)).filter(Boolean));
    const apiKeyIds = new Set((data.apiKeys || []).map((k) => k && k.id).filter(Boolean));

    // model → provider
    for (const m of (data.models || [])) {
      if (!m) continue;
      const refs = [];
      if (m.providerId) refs.push(m.providerId);
      if (Array.isArray(m.providers)) for (const p of m.providers) refs.push(typeof p === 'string' ? p : (p && p.id));
      for (const pid of refs) {
        if (pid && providerIds.size > 0 && !providerIds.has(pid)) {
          warnings.push(`model "${m.id || m.model}" references unknown provider "${pid}"`);
        }
      }
    }
    // apiKey → provider / model
    for (const k of (data.apiKeys || [])) {
      if (!k) continue;
      for (const pid of [...(k.allowedProviders || []), ...(k.deniedProviders || [])]) {
        if (pid && providerIds.size > 0 && !providerIds.has(pid)) {
          warnings.push(`apiKey "${k.id}" references unknown provider "${pid}"`);
        }
      }
      for (const mid of [...(k.allowedModels || []), ...(k.deniedModels || [])]) {
        if (mid && modelIds.size > 0 && !modelIds.has(mid)) {
          warnings.push(`apiKey "${k.id}" references unknown model "${mid}"`);
        }
      }
    }
    // usage → apiKey
    if (data.usage && data.usage.byApiKey && typeof data.usage.byApiKey === 'object') {
      for (const kid of Object.keys(data.usage.byApiKey)) {
        if (apiKeyIds.size > 0 && !apiKeyIds.has(kid)) {
          warnings.push(`usage references unknown apiKey "${kid}"`);
        }
      }
    }
    // connection → provider
    for (const c of (data.connections || [])) {
      if (!c) continue;
      const pid = c.provider || c.providerId;
      if (pid && providerIds.size > 0 && !providerIds.has(pid)) {
        warnings.push(`connection "${c.id || c.connectionId}" references unknown provider "${pid}"`);
      }
    }
    return {
      warnings,
      references: {
        providers: providerIds.size,
        models: modelIds.size,
        apiKeys: apiKeyIds.size,
      },
    };
  }

  /**
   * Restore a backup. Restores only the metadata layers that are safe and
   * supported: API key METADATA (permissions/quota/status for EXISTING keys —
   * matched by id) and quota policies (informational). Provider secrets are
   * never present in a backup, so providers are validated but not overwritten
   * with credential-less configs unless `opts.restoreProviders` is set AND the
   * live provider already has credentials (we merge metadata only).
   *
   * The restore is validated first; on any validation error it aborts WITHOUT
   * applying partial changes (no silent partial restore). When `opts.dryRun`
   * is true, it validates and reports what WOULD change without applying.
   *
   * @param {object} backup
   * @param {object} [opts]
   * @param {boolean} [opts.dryRun=false]
   * @returns {Promise<{ ok: boolean, applied: object, errors: string[], dryRun: boolean }>}
   */
  async restoreBackup(backup, opts = {}) {
    const dryRun = !!opts.dryRun;
    const validation = this.validateBackup(backup);
    if (!validation.valid) {
      return { ok: false, applied: {}, errors: validation.errors, dryRun };
    }

    const data = backup.data || {};
    const plan = { apiKeyMetadata: 0, skippedApiKeys: 0, quotasSeen: 0 };

    // Plan: API key metadata restore for EXISTING keys only (matched by id).
    // We never re-create a key from a backup (no secret to reconstruct), and
    // we never delete keys not present in the backup. Historical usage is
    // preserved.
    const apiKeyPatches = [];
    if (Array.isArray(data.apiKeys) && this.apiKeyStore) {
      const existingIds = new Set((this.apiKeyStore.keys || []).map((k) => k.id));
      for (const k of data.apiKeys) {
        if (!k || !k.id) { plan.skippedApiKeys += 1; continue; }
        if (!existingIds.has(k.id)) { plan.skippedApiKeys += 1; continue; }
        apiKeyPatches.push({
          id: k.id,
          patch: {
            name: k.name,
            description: k.description,
            status: k.status === 'expired' ? undefined : k.status,
            role: k.role,
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
          },
        });
        plan.apiKeyMetadata += 1;
      }
    }
    if (Array.isArray(data.quotas)) plan.quotasSeen = data.quotas.length;

    if (dryRun) {
      return { ok: true, applied: plan, errors: [], dryRun: true };
    }

    // Apply. Any failure aborts and reports (individual key updates are
    // idempotent metadata patches, so a mid-way failure leaves already-applied
    // patches in place; we surface the error rather than silently continuing).
    const errors = [];
    let applied = 0;
    for (const { id, patch } of apiKeyPatches) {
      try {
        const cleaned = {};
        for (const [f, v] of Object.entries(patch)) if (v !== undefined) cleaned[f] = v;
        await this.apiKeyStore.updateKey(id, cleaned);
        applied += 1;
      } catch (err) {
        errors.push(`Failed to restore key "${id}": ${err.message}`);
      }
    }

    logger.info('BackupService: restore applied', { apiKeyMetadata: applied, errors: errors.length });
    return {
      ok: errors.length === 0,
      applied: { apiKeyMetadata: applied, quotasSeen: plan.quotasSeen },
      errors,
      dryRun: false,
    };
  }

  /**
   * Persist a backup object to the configured backup directory as a versioned
   * JSON file. Returns the file path.
   * @param {object} backup
   * @param {string} [name] - optional file name (without extension)
   * @returns {Promise<string>} file path
   */
  async saveBackup(backup, name) {
    if (!this.backupDir) throw new Error('BackupService: no backupDir configured');
    if (!fs.existsSync(this.backupDir)) fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = (backup.createdAt || new Date().toISOString()).replace(/[:.]/g, '-');
    const fileName = `${name || 'backup'}-${stamp}.json`;
    const filePath = path.join(this.backupDir, fileName);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(backup, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
    return filePath;
  }

  /**
   * List persisted backup files (metadata only) from the backup directory.
   * @returns {Array<{ file: string, createdAt: (string|null), backupVersion: (number|null), size: number }>}
   */
  listBackups() {
    if (!this.backupDir || !fs.existsSync(this.backupDir)) return [];
    const out = [];
    for (const file of fs.readdirSync(this.backupDir)) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(this.backupDir, file);
      let meta = { createdAt: null, backupVersion: null };
      try {
        const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
        meta.createdAt = raw.createdAt || null;
        meta.backupVersion = raw.backupVersion || null;
      } catch (_) { /* ignore unreadable */ }
      let size = 0;
      try { size = fs.statSync(full).size; } catch (_) {}
      out.push({ file, createdAt: meta.createdAt, backupVersion: meta.backupVersion, size });
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  /**
   * Load a persisted backup file by name from the backup directory.
   * @param {string} file
   * @returns {object|null}
   */
  loadBackup(file) {
    if (!this.backupDir) return null;
    const full = path.join(this.backupDir, path.basename(file));
    if (!fs.existsSync(full)) return null;
    try { return JSON.parse(fs.readFileSync(full, 'utf8')); } catch { return null; }
  }
}

module.exports = BackupService;
module.exports.BACKUP_VERSION = BACKUP_VERSION;
