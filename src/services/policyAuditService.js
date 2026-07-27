/**
 * PolicyAuditService
 *
 * Persistent-ish audit ledger for Sprint 13 policy decisions. Captures one
 * record per request that ran through the policy engine (when enabled)
 * with: matched policy ids, ignored policy ids, the final routing
 * decision, the rejection/budget/quota actions taken, the per-request
 * execution time, and the eventual provider / api key that won selection.
 *
 * Records live in a bounded ring buffer (default 5000). Optional disk
 * persistence via `persistencePath` (validate-then-write atomic save
 * mirroring Sprint 12's UsageAccountant). When the policy engine is
 * disabled the middleware does not call record() — no overhead.
 *
 * The audit log is read-only from the request path (the read API is what
 * the admin dashboard uses) and the write API is called from the policy
 * middleware & request executor.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const DEFAULT_MAX_ENTRIES = 5000;

class PolicyAuditService {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=5000]
   * @param {string} [opts.persistencePath]
   * @param {boolean} [opts.persist=false]
   * @param {number} [opts.flushIntervalMs=0]
   */
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries != null ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
    this.entries = [];
    this.seq = 0;
    this.persist = !!opts.persist;
    this.persistencePath = opts.persistencePath || process.env.POLICY_AUDIT_FILE || null;
    this.flushIntervalMs = opts.flushIntervalMs || 0;
    this._flushTimer = null;
    if (this.persist && this.persistencePath) {
      this._loadFromDisk();
      if (this.flushIntervalMs > 0) {
        this._flushTimer = setInterval(() => this._flushToDisk(), this.flushIntervalMs).unref();
      }
    }
  }

  /**
   * Record one audit entry. Returns the persisted entry (or null on bad
   * input).
   * @param {object} args
   * @param {string} [args.requestId]
   * @param {string} [args.apiKeyId]
   * @param {string} [args.providerId] - selected / forced provider (null pre-route)
   * @param {string} [args.apiKeyIdSelected]
   * @param {string} [args.virtualModelId]
   * @param {string} [args.model]
   * @param {string} [args.operation]
   * @param {object} [args.matchedPolicies=[]] - [{ id, name, priority }]
   * @param {object} [args.ignoredPolicies=[]] - [{ id, reason }]
   * @param {object} [args.decision]
   * @param {string} [args.routingDecision] - human-readable summary
   * @param {string} [args.reason]
   * @param {boolean} [args.rejected]
   * @param {object} [args.quotaAction] - { kind, policyId }
   * @param {object} [args.budgetAction] - { kind, policyId }
   * @param {number} [args.executionTimeMs]
   * @param {number} [args.timestamp]
   * @returns {object|null}
   */
  record(args = {}) {
    if (!args || typeof args !== 'object') return null;
    const seq = ++this.seq;
    const entry = {
      seq,
      id: `paudit-${seq}`,
      requestId: args.requestId || null,
      apiKeyId: args.apiKeyId || null,
      providerId: args.providerId || null,
      apiKeyIdSelected: args.apiKeyIdSelected || null,
      virtualModelId: args.virtualModelId || null,
      model: args.model || null,
      operation: args.operation || null,
      matchedPolicies: Array.isArray(args.matchedPolicies) ? args.matchedPolicies : [],
      ignoredPolicies: Array.isArray(args.ignoredPolicies) ? args.ignoredPolicies : [],
      decision: args.decision || null,
      routingDecision: args.routingDecision || null,
      reason: args.reason || null,
      rejected: !!args.rejected,
      quotaAction: args.quotaAction || null,
      budgetAction: args.budgetAction || null,
      executionTimeMs: typeof args.executionTimeMs === 'number' ? args.executionTimeMs : 0,
      timestamp: args.timestamp || Date.now(),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    if (this.persist && this.persistencePath && !this._flushTimer) this._scheduleFlush();
    return entry;
  }

  /**
   * List audit entries with optional filters.
   * @param {object} [opts]
   * @param {number} [opts.sinceSeq]
   * @param {number} [opts.limit=100]
   * @param {boolean} [opts.rejectedOnly]
   * @param {string} [opts.policyId] - entries that matched this policy
   * @param {string} [opts.apiKeyId]
   * @param {string} [opts.providerId]
   * @returns {Array<object>}
   */
  list(opts = {}) {
    let out = this.entries;
    if (opts.sinceSeq != null) out = out.filter((e) => e.seq > opts.sinceSeq);
    if (opts.rejectedOnly) out = out.filter((e) => e.rejected);
    if (opts.policyId) out = out.filter((e) => e.matchedPolicies.some((p) => p.id === opts.policyId));
    if (opts.apiKeyId) out = out.filter((e) => e.apiKeyId === opts.apiKeyId);
    if (opts.providerId) out = out.filter((e) => e.providerId === opts.providerId);
    const limit = opts.limit != null ? Math.min(opts.limit, this.maxEntries) : 100;
    return out.slice(-limit).reverse();
  }

  /**
   * Get a single audit entry by seq.
   * @param {number} seq
   * @returns {object|null}
   */
  get(seq) { return this.entries.find((e) => e.seq === seq) || null; }

  /**
   * Dashboard summary stats.
   * @returns {object}
   */
  getSnapshot() {
    const total = this.entries.length;
    let rejected = 0, matched = 0, avgMs = 0, totalMs = 0;
    const byPolicy = {};
    for (const e of this.entries) {
      if (e.rejected) rejected += 1;
      if (e.matchedPolicies && e.matchedPolicies.length) matched += 1;
      totalMs += e.executionTimeMs || 0;
      for (const p of (e.matchedPolicies || [])) {
        byPolicy[p.id] = (byPolicy[p.id] || 0) + 1;
      }
    }
    avgMs = total > 0 ? Math.round(totalMs / total) : 0;
    return { total, rejected, matched, avgExecutionTimeMs: avgMs, byPolicy };
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => { this._flushTimer = null; this._flushToDisk(); }, 200);
    if (this._flushTimer && this._flushTimer.unref) this._flushTimer.unref();
  }

  _flushToDisk() {
    if (!this.persistencePath) return;
    try {
      const dir = path.dirname(this.persistencePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.persistencePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ seq: this.seq, entries: this.entries, savedAt: Date.now() }), 'utf8');
      fs.renameSync(tmp, this.persistencePath);
    } catch (err) {
      logger.warn('PolicyAuditService flush failed', { error: err && err.message });
    }
  }

  _loadFromDisk() {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistencePath, 'utf8'));
      this.seq = raw.seq || 0;
      this.entries = Array.isArray(raw.entries) ? raw.entries.slice(-this.maxEntries) : [];
    } catch (err) {
      logger.warn('PolicyAuditService load failed', { error: err && err.message });
    }
  }

  /**
   * Force flush (admin /admin/api/policies/audit/flush).
   */
  flush() { this._flushToDisk(); }

  reset() { this.entries = []; this.seq = 0; }
}

module.exports = PolicyAuditService;
module.exports.DEFAULT_MAX_ENTRIES = DEFAULT_MAX_ENTRIES;
