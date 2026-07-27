/**
 * UsageAccountant
 *
 * Enhanced, dimension-aware token & cost ledger (Sprint 12). Lives NEXT TO
 * the existing UsageTracker (which the auth middleware uses for per-key
 * request counts) — keep both for backward compat. The UsageAccountant
 * adds support for:
 *
 *   - the finer-grained token types required by the Sprint 12 spec:
 *     input / output / cached / reasoning / total tokens per request.
 *   - attribution: per (model, provider, api_key, virtual_model, user,
 *     organization, project) totals + cost.
 *   - per-request entry history (ring buffer of the last N).
 *   - in-memory persistence: the ledger can be flushed to a JSON file
 *     (config/usage.json) on a debounced timer and reloaded on boot.
 *
 * Public write API (called by the executor after a successful response):
 *   recordRequest({ requestId, apiKeyId, providerId, model, virtualModelId,
 *                   userId, organizationId, projectId,
 *                   inputTokens, outputTokens, cachedTokens, reasoningTokens,
 *                   totalTokens, cost, operation, status, latencyMs })
 *
 * Public read API (called by analytics / admin dashboard):
 *   getSnapshot({ dimensions? })
 *   query({ groupBy, filters, sinceSeq })
 *   listRecent(n)
 *
 * Optional persistence: pass `{ persistencePath }` in the constructor
 * (or set USAGE_LEDGER_FILE). State is flushed passively (no in-flight
 * batching) to keep the hot path cheap; failures are logged but never
 * block the request.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2000;

function _ensureKey(map, key, factory) {
  let v = map.get(key);
  if (!v) { v = factory(); map.set(key, v); }
  return v;
}

function aggCounters() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0 };
}

class UsageAccountant {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=2000] - bounded ring buffer of raw entries
   * @param {string} [opts.persistencePath] - optional path for ledger dump
   * @param {boolean} [opts.persist] - when true, write ledger periodically
   * @param {number} [opts.flushIntervalMs] - if persisting, debounce cadence (0=off)
   */
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries != null ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
    // raw ring buffer of per-request records
    this.entries = [];
    this.seq = 0;
    // dimension rollups
    this.byModel = new Map();
    this.byProvider = new Map();
    this.byApiKey = new Map();
    this.byVirtualModel = new Map();
    this.byUser = new Map();
    this.byOrg = new Map();
    this.byProject = new Map();
    this.global = aggCounters();
    // daily bucket for trend charts: ISO day -> counters
    this.byDay = new Map();
    // monthly bucket for trend charts
    this.byMonth = new Map();
    // persistence
    this.persist = !!opts.persist;
    this.persistencePath = opts.persistencePath || process.env.USAGE_LEDGER_FILE || null;
    this.flushIntervalMs = opts.flushIntervalMs || 0;
    this._flushTimer = null;
    if (this.persist && this.persistencePath) {
      this._loadFromDisk();
      if (this.flushIntervalMs > 0) {
        this._flushTimer = setInterval(() => this._flushToDisk(), this.flushIntervalMs).unref();
      }
    }
  }

  _ensureDay(ymd) { return _ensureKey(this.byDay, ymd, aggCounters); }
  _ensureMonth(ym) { return _ensureKey(this.byMonth, yym, aggCounters).bind(null); }

  _day(now) {
    const d = new Date(now);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  _month(now) {
    const d = new Date(now);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  _ensureMonthProper(ym) {
    return _ensureKey(this.byMonth, ym, aggCounters);
  }

  /**
   * Record one completed request. Safe to call on failures too — pass
   * `status` so the analytics path can compute success rates.
   * @param {object} args
   */
  recordRequest(args = {}) {
    const total = args.totalTokens != null
      ? args.totalTokens
      : ((args.inputTokens || 0) + (args.outputTokens || 0) + (args.cachedTokens || 0) + (args.reasoningTokens || 0));
    const seq = this.seq++;
    const now = args.timestamp || Date.now();
    const entry = {
      seq,
      requestId: args.requestId || null,
      apiKeyId: args.apiKeyId || null,
      providerId: args.providerId || null,
      model: args.model || null,
      virtualModelId: args.virtualModelId || null,
      userId: args.userId || null,
      organizationId: args.organizationId || null,
      projectId: args.projectId || null,
      operation: args.operation || null,
      status: args.status || 200,
      latencyMs: typeof args.latencyMs === 'number' ? args.latencyMs : null,
      inputTokens: args.inputTokens || 0,
      outputTokens: args.outputTokens || 0,
      cachedTokens: args.cachedTokens || 0,
      reasoningTokens: args.reasoningTokens || 0,
      totalTokens: total,
      cost: args.cost || 0,
      timestamp: now,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();

    // Rollups
    this._bump(this.global, entry);
    if (entry.model) this._bump(_ensureKey(this.byModel, entry.model, aggCounters), entry);
    if (entry.providerId) this._bump(_ensureKey(this.byProvider, entry.providerId, aggCounters), entry);
    if (entry.apiKeyId) this._bump(_ensureKey(this.byApiKey, entry.apiKeyId, aggCounters), entry);
    if (entry.virtualModelId) this._bump(_ensureKey(this.byVirtualModel, entry.virtualModelId, aggCounters), entry);
    if (entry.userId) this._bump(_ensureKey(this.byUser, entry.userId, aggCounters), entry);
    if (entry.organizationId) this._bump(_ensureKey(this.byOrg, entry.organizationId, aggCounters), entry);
    if (entry.projectId) this._bump(_ensureKey(this.byProject, entry.projectId, aggCounters), entry);
    this._bump(this._ensureDay(this._day(now)), entry);
    this._bump(this._ensureMonthProper(this._month(now)), entry);

    if (this.persist && this.persistencePath && !this._flushTimer) {
      // opportunistic (lazy) flush — no timer configured, write-through
      this._scheduleFlush();
    }
    return entry;
  }

  _bump(c, entry) {
    c.requests += 1;
    c.inputTokens += entry.inputTokens;
    c.outputTokens += entry.outputTokens;
    c.cachedTokens += entry.cachedTokens;
    c.reasoningTokens += entry.reasoningTokens;
    c.totalTokens += entry.totalTokens;
    c.cost = Math.round((c.cost + entry.cost) * 1e8) / 1e8;
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => { this._flushTimer = null; this._flushToDisk(); }, 200);
    if (this._flushTimer && this._flushTimer.unref) this._flushTimer.unref();
  }

  _serialize() {
    return {
      seq: this.seq,
      global: this.global,
      byModel: Object.fromEntries(this.byModel),
      byProvider: Object.fromEntries(this.byProvider),
      byApiKey: Object.fromEntries(this.byApiKey),
      byVirtualModel: Object.fromEntries(this.byVirtualModel),
      byUser: Object.fromEntries(this.byUser),
      byOrg: Object.fromEntries(this.byOrg),
      byProject: Object.fromEntries(this.byProject),
      byDay: Object.fromEntries(this.byDay),
      byMonth: Object.fromEntries(this.byMonth),
      savedAt: Date.now(),
    };
  }

  _flushToDisk() {
    if (!this.persistencePath) return;
    try {
      const dir = path.dirname(this.persistencePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.persistencePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this._serialize()), 'utf8');
      fs.renameSync(tmp, this.persistencePath);
    } catch (err) {
      logger.warn('UsageAccountant flush failed', { error: err && err.message });
    }
  }

  _loadFromDisk() {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistencePath, 'utf8'));
      this.seq = raw.seq || 0;
      Object.assign(this.global, raw.global || {});
      for (const [k, v] of Object.entries(raw.byModel || {})) this.byModel.set(k, v);
      for (const [k, v] of Object.entries(raw.byProvider || {})) this.byProvider.set(k, v);
      for (const [k, v] of Object.entries(raw.byApiKey || {})) this.byApiKey.set(k, v);
      for (const [k, v] of Object.entries(raw.byVirtualModel || {})) this.byVirtualModel.set(k, v);
      for (const [k, v] of Object.entries(raw.byUser || {})) this.byUser.set(k, v);
      for (const [k, v] of Object.entries(raw.byOrg || {})) this.byOrg.set(k, v);
      for (const [k, v] of Object.entries(raw.byProject || {})) this.byProject.set(k, v);
      for (const [k, v] of Object.entries(raw.byDay || {})) this.byDay.set(k, v);
      for (const [k, v] of Object.entries(raw.byMonth || {})) this.byMonth.set(k, v);
    } catch (err) {
      logger.warn('UsageAccountant load failed', { error: err && err.message });
    }
  }

  /**
   * Get a snapshot of all rollups (for the analytics endpoint).
   * @returns {object}
   */
  getSnapshot() {
    return {
      seq: this.seq,
      global: { ...this.global },
      byModel: Object.fromEntries(this.byModel),
      byProvider: Object.fromEntries(this.byProvider),
      byApiKey: Object.fromEntries(this.byApiKey),
      byVirtualModel: Object.fromEntries(this.byVirtualModel),
      byUser: Object.fromEntries(this.byUser),
      byOrganization: Object.fromEntries(this.byOrg),
      byProject: Object.fromEntries(this.byProject),
      byDay: Object.fromEntries(this.byDay),
      byMonth: Object.fromEntries(this.byMonth),
      entryCount: this.entries.length,
    };
  }

  /**
   * Get the most recent N raw entries (admin "recent requests").
   * @param {number} n
   * @returns {Array<object>}
   */
  listRecent(n = 50) {
    return this.entries.slice(-Math.max(0, n)).reverse();
  }

  /**
   * Read-only single dimension lookup for the usage endpoint.
   * @param {string} dimension - 'model'|'provider'|'apiKey'|'virtualModel'|'user'|'organization'|'project'
   * @param {string} id
   * @returns {object|null}
   */
  getDimension(dimension, id) {
    const map = ({
      model: this.byModel,
      provider: this.byProvider,
      apiKey: this.byApiKey,
      virtualModel: this.byVirtualModel,
      user: this.byUser,
      organization: this.byOrg,
      project: this.byProject,
    })[dimension];
    return map ? (map.get(id) || null) : null;
  }

  /**
   * Force-flush the ledger to disk (used by admin /admin/api/usage/flush).
   */
  flush() { this._flushToDisk(); }

  /**
   * Reset everything (for testing).
   */
  reset() {
    this.entries = [];
    this.seq = 0;
    this.byModel.clear(); this.byProvider.clear(); this.byApiKey.clear();
    this.byVirtualModel.clear(); this.byUser.clear(); this.byOrg.clear(); this.byProject.clear();
    this.byDay.clear(); this.byMonth.clear();
    this.global = aggCounters();
  }
}

module.exports = UsageAccountant;
module.exports.ONE_DAY_MS = ONE_DAY_MS;
module.exports.DEFAULT_MAX_ENTRIES = DEFAULT_MAX_ENTRIES;
