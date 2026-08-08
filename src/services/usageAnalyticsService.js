/**
 * UsageAnalyticsService
 *
 * The official read-only reporting layer for gateway usage & quota analytics
 * (Prompt 24). It does NOT own any counters — it reads exclusively from the
 * existing sources of truth:
 *
 *   - UsageAccountant : dimensional rollups (per apiKey / provider / model /
 *                       day / month / global) + the raw entry ring buffer,
 *                       now enriched with status / stream / latency /
 *                       errorCategory dimensions.
 *   - ApiKeyStore     : per-key quota { limit, used, remaining } (single
 *                       source of truth from Prompt 23) + reset period.
 *   - ProviderManager : provider identity (Provider Registry).
 *   - ModelRegistry   : model identity (Model Registry) — used only to label,
 *                       never to invent a second registry.
 *
 * No second usage/quota system is created. Aggregation is served from the
 * pre-computed rollups (O(1)/O(dimensions)) — never a full re-scan of the raw
 * request log on the hot path. Filtered detail queries operate on the bounded
 * in-memory entry buffer with parameterized (object-property) matching — no
 * string SQL is built, so there is no injection surface.
 *
 * Security: every returned shape carries request METADATA only — never a raw
 * key, keyHash, Authorization header, token, cookie, prompt, or completion.
 */
class UsageAnalyticsService {
  /**
   * @param {object} deps
   * @param {object} deps.usageAccountant - UsageAccountant (source of rollups)
   * @param {object} [deps.apiKeyStore]   - ApiKeyStore (quota source of truth)
   * @param {object} [deps.providerManager]
   * @param {object} [deps.modelRegistry]
   * @param {object} [deps.pricingService] - optional; cost already baked into
   *   rollups, exposed here for future per-report recomputation.
   */
  constructor({ usageAccountant, apiKeyStore, providerManager, modelRegistry, pricingService } = {}) {
    this.usage = usageAccountant || null;
    this.apiKeyStore = apiKeyStore || null;
    this.providerManager = providerManager || null;
    this.modelRegistry = modelRegistry || null;
    this.pricingService = pricingService || null;
  }

  /**
   * Normalize a raw rollup counter into the public analytics shape. Adds the
   * derived success/error rate + latency stats. Never faked: token fields
   * stay as-is (0 means "none reported").
   * @param {object} c - rollup counter
   * @returns {object}
   * @private
   */
  _shape(c) {
    if (!c) {
      return {
        requests: 0, successfulRequests: 0, failedRequests: 0,
        successRate: 0, errorRate: 0,
        inputTokens: 0, outputTokens: 0, totalTokens: 0,
        cachedTokens: 0, reasoningTokens: 0,
        streamRequests: 0, nonStreamRequests: 0,
        averageLatencyMs: 0, minLatencyMs: null, maxLatencyMs: null,
        estimatedCost: 0, errorsByCategory: {},
      };
    }
    const requests = c.requests || 0;
    const successes = c.successes != null ? c.successes : requests; // legacy snapshots: assume success
    const failures = c.failures != null ? c.failures : 0;
    const latCount = c.latencyCount || 0;
    return {
      requests,
      successfulRequests: successes,
      failedRequests: failures,
      successRate: requests > 0 ? Math.round((successes / requests) * 10000) / 100 : 0,
      errorRate: requests > 0 ? Math.round((failures / requests) * 10000) / 100 : 0,
      inputTokens: c.inputTokens || 0,
      outputTokens: c.outputTokens || 0,
      totalTokens: c.totalTokens || 0,
      cachedTokens: c.cachedTokens || 0,
      reasoningTokens: c.reasoningTokens || 0,
      streamRequests: c.streamRequests || 0,
      nonStreamRequests: c.nonStreamRequests || 0,
      averageLatencyMs: latCount > 0 ? Math.round((c.latencySum || 0) / latCount) : 0,
      minLatencyMs: c.latencyMin != null ? c.latencyMin : null,
      maxLatencyMs: c.latencyMax != null ? c.latencyMax : null,
      // Cost is null when pricing never produced a value (all-zero) — callers
      // distinguish "no pricing" from "$0". We surface the accumulated number
      // (0 when pricing disabled) and a nullable estimatedCost.
      estimatedCost: typeof c.cost === 'number' ? c.cost : null,
      errorsByCategory: c.errorsByCategory ? { ...c.errorsByCategory } : {},
    };
  }

  /**
   * Per-API-key usage summary (historical/lifetime) plus current quota.
   * @param {string} apiKeyId
   * @returns {object|null}
   */
  getApiKeyUsage(apiKeyId) {
    if (!apiKeyId || !this.usage) return null;
    const c = this.usage.getDimension('apiKey', apiKeyId);
    const shaped = this._shape(c);
    return {
      apiKeyId,
      usage: shaped,
      quota: this.getApiKeyQuota(apiKeyId),
    };
  }

  /**
   * Per-API-key quota analytics from the single source of truth (ApiKeyStore).
   * Adds derived percentages + reset period + resetAt when configured.
   * @param {string} apiKeyId
   * @returns {object|null}
   */
  getApiKeyQuota(apiKeyId) {
    if (!this.apiKeyStore || typeof this.apiKeyStore.getQuota !== 'function') return null;
    const q = this.apiKeyStore.getQuota(apiKeyId);
    if (!q) return null;
    const record = (this.apiKeyStore.keys || []).find((k) => k.id === apiKeyId);
    const period = (record && record.quota && record.quota.reset) || (record && record.quota && record.quota.period) || 'never';
    const limit = typeof q.limit === 'number' ? q.limit : null;
    const used = q.used || 0;
    const remaining = q.remaining != null ? q.remaining : (limit != null ? Math.max(0, limit - used) : null);
    return {
      limit,
      used,
      remaining,
      percentageUsed: limit != null && limit > 0 ? Math.round((used / limit) * 10000) / 100 : null,
      percentageRemaining: limit != null && limit > 0 ? Math.round((remaining / limit) * 10000) / 100 : null,
      resetPeriod: period,
      resetAt: this._nextResetAt(period),
    };
  }

  /**
   * Compute the next reset boundary (UTC) for a reset period. Returns null for
   * 'never' or unknown periods. This is purely derived — it never mutates or
   * resets accumulated usage (historical usage is preserved by design).
   * @param {string} period - daily|weekly|monthly|never
   * @param {number} [now]
   * @returns {string|null} ISO timestamp
   * @private
   */
  _nextResetAt(period, now = Date.now()) {
    const d = new Date(now);
    if (period === 'daily') {
      const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0));
      return n.toISOString();
    }
    if (period === 'weekly') {
      const dow = d.getUTCDay();
      const daysToMon = ((8 - (dow === 0 ? 7 : dow)) % 7) || 7;
      const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToMon, 0, 0, 0));
      return n.toISOString();
    }
    if (period === 'monthly') {
      const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0));
      return n.toISOString();
    }
    return null;
  }

  /**
   * Provider usage aggregation. Providers come from the Provider Registry when
   * available (so known-but-idle providers appear with zeroed counters).
   * @returns {Array<object>}
   */
  getProviderUsage() {
    if (!this.usage) return [];
    const snap = this.usage.getSnapshot();
    const byProvider = snap.byProvider || {};
    const ids = new Set(Object.keys(byProvider));
    if (this.providerManager && typeof this.providerManager.listProviders === 'function') {
      for (const p of this.providerManager.listProviders()) ids.add(p.id);
    }
    return [...ids].map((id) => ({ providerId: id, ...this._shape(byProvider[id]) }))
      .sort((a, b) => b.requests - a.requests);
  }

  /**
   * Model usage aggregation. Optionally filtered to a single provider by
   * intersecting the raw entries (model↔provider) — falls back to global model
   * rollups when no provider filter is given.
   * @param {object} [opts]
   * @param {string} [opts.providerId] - restrict to models served via a provider
   * @returns {Array<object>}
   */
  getModelUsage(opts = {}) {
    if (!this.usage) return [];
    if (opts.providerId) {
      // Aggregate from the raw entry buffer for the provider↔model pair.
      const acc = new Map();
      for (const e of (this.usage.entries || [])) {
        if (e.providerId !== opts.providerId || !e.model) continue;
        if (!acc.has(e.model)) acc.set(e.model, this._emptyCounter());
        this._accumulate(acc.get(e.model), e);
      }
      return [...acc.entries()].map(([model, c]) => ({ model, providerId: opts.providerId, ...this._shape(c) }))
        .sort((a, b) => b.requests - a.requests);
    }
    const snap = this.usage.getSnapshot();
    return Object.entries(snap.byModel || {}).map(([model, c]) => ({ model, ...this._shape(c) }))
      .sort((a, b) => b.requests - a.requests);
  }

  _emptyCounter() {
    return { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0, successes: 0, failures: 0, streamRequests: 0, nonStreamRequests: 0, latencySum: 0, latencyCount: 0, latencyMin: null, latencyMax: null, errorsByCategory: {} };
  }

  _accumulate(c, e) {
    c.requests += 1;
    c.inputTokens += e.inputTokens || 0;
    c.outputTokens += e.outputTokens || 0;
    c.cachedTokens += e.cachedTokens || 0;
    c.reasoningTokens += e.reasoningTokens || 0;
    c.totalTokens += e.totalTokens || 0;
    c.cost = Math.round((c.cost + (e.cost || 0)) * 1e8) / 1e8;
    const ok = typeof e.status === 'number' ? e.status < 400 : true;
    if (ok) c.successes += 1; else c.failures += 1;
    if (e.stream) c.streamRequests += 1; else c.nonStreamRequests += 1;
    if (typeof e.latencyMs === 'number') {
      c.latencySum += e.latencyMs; c.latencyCount += 1;
      c.latencyMin = c.latencyMin == null ? e.latencyMs : Math.min(c.latencyMin, e.latencyMs);
      c.latencyMax = c.latencyMax == null ? e.latencyMs : Math.max(c.latencyMax, e.latencyMs);
    }
    if (e.errorCategory) c.errorsByCategory[e.errorCategory] = (c.errorsByCategory[e.errorCategory] || 0) + 1;
  }

  /**
   * Daily usage buckets (ascending). Optionally sliced to the last N days.
   * @param {object} [opts]
   * @param {number} [opts.days] - limit to the most recent N days
   * @returns {Array<object>}
   */
  getDailyUsage(opts = {}) {
    if (!this.usage) return [];
    const snap = this.usage.getSnapshot();
    let rows = Object.entries(snap.byDay || {}).map(([date, c]) => ({ date, ...this._shape(c) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (opts.days && opts.days > 0) rows = rows.slice(-opts.days);
    return rows;
  }

  /**
   * Monthly usage buckets (ascending).
   * @param {object} [opts]
   * @param {number} [opts.months]
   * @returns {Array<object>}
   */
  getMonthlyUsage(opts = {}) {
    if (!this.usage) return [];
    const snap = this.usage.getSnapshot();
    let rows = Object.entries(snap.byMonth || {}).map(([month, c]) => ({ month, ...this._shape(c) }))
      .sort((a, b) => (a.month < b.month ? -1 : 1));
    if (opts.months && opts.months > 0) rows = rows.slice(-opts.months);
    return rows;
  }

  /**
   * Global usage summary (admin). Includes status breakdown + stream split +
   * latency stats aggregated across every request.
   * @returns {object}
   */
  getUsageSummary() {
    if (!this.usage) return this._shape(null);
    const snap = this.usage.getSnapshot();
    return {
      ...this._shape(snap.global),
      providers: Object.keys(snap.byProvider || {}).length,
      models: Object.keys(snap.byModel || {}).length,
      apiKeys: Object.keys(snap.byApiKey || {}).length,
      entryCount: snap.entryCount || 0,
    };
  }

  /**
   * Paginated + filtered raw usage detail (request history). Operates on the
   * bounded in-memory entry buffer with object-property matching (no SQL
   * string is constructed). Secrets are never present in an entry.
   *
   * @param {object} [filters]
   * @param {string} [filters.apiKeyId]
   * @param {string} [filters.providerId]
   * @param {string} [filters.model]
   * @param {string} [filters.status] - 'success' | 'error'
   * @param {boolean} [filters.stream]
   * @param {number} [filters.startDate] - epoch ms (inclusive)
   * @param {number} [filters.endDate]   - epoch ms (inclusive)
   * @param {number} [filters.page=1]
   * @param {number} [filters.limit=50]
   * @returns {{ page:number, limit:number, total:number, items:Array<object> }}
   */
  getUsageDetail(filters = {}) {
    const page = Math.max(1, parseInt(filters.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(filters.limit, 10) || 50));
    const entries = (this.usage && this.usage.entries) ? this.usage.entries : [];
    const matched = [];
    for (const e of entries) {
      if (filters.apiKeyId && e.apiKeyId !== filters.apiKeyId) continue;
      if (filters.providerId && e.providerId !== filters.providerId) continue;
      if (filters.model && e.model !== filters.model) continue;
      if (filters.stream !== undefined && !!e.stream !== !!filters.stream) continue;
      if (filters.status) {
        const ok = typeof e.status === 'number' ? e.status < 400 : true;
        if (filters.status === 'success' && !ok) continue;
        if (filters.status === 'error' && ok) continue;
      }
      if (filters.startDate && e.timestamp < filters.startDate) continue;
      if (filters.endDate && e.timestamp > filters.endDate) continue;
      matched.push(this._publicEntry(e));
    }
    // Most recent first.
    matched.reverse();
    const total = matched.length;
    const start = (page - 1) * limit;
    return { page, limit, total, items: matched.slice(start, start + limit) };
  }

  /**
   * Project a raw ledger entry to a safe public shape (metadata only).
   * @param {object} e
   * @returns {object}
   * @private
   */
  _publicEntry(e) {
    return {
      id: e.requestId || e.seq,
      apiKeyId: e.apiKeyId || null,
      providerId: e.providerId || null,
      model: e.model || null,
      connectionId: e.connectionId || null,
      operation: e.operation || null,
      status: e.status,
      errorCategory: e.errorCategory || null,
      stream: !!e.stream,
      inputTokens: e.inputTokens || 0,
      outputTokens: e.outputTokens || 0,
      totalTokens: e.totalTokens || 0,
      estimatedCost: typeof e.cost === 'number' ? e.cost : null,
      latencyMs: typeof e.latencyMs === 'number' ? e.latencyMs : null,
      createdAt: e.timestamp || null,
    };
  }
}

module.exports = UsageAnalyticsService;
