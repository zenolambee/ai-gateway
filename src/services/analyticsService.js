/**
 * AnalyticsService
 *
 * Computes the dashboard analytics required by Sprint 12 by combining the
 * dimensional rollups from UsageAccountant with the live traffic counters
 * from MetricsCollector. Also computes the spike / abnormality diagnostics
 * that the AlertService surfaces (provider cost spikes, abnormal token
 * usage, provider price spike).
 *
 * Public API:
 *   getOverview()
 *   top({ dimension, metric, sort, limit })
 *   trends({ bucket='daily' })
 *   checkAnomalies()
 *
 * The analytics path is pure-read and never mutates state — anomaly
 * detection RAISES alerts via the AlertService (setAlertService). Defaults
 * are intentionally conservative (thresholds of 3x / 50% of 24h traffic);
 * tuning is via constructor opts.
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

class AnalyticsService {
  /**
   * @param {object} deps
   * @param {object} deps.usageAccountant - UsageAccountant instance
   * @param {object} deps.metricsCollector - MetricsCollector instance
   * @param {object} [deps.alertService] - AlertService (optional)
   * @param {object} [opts]
   * @param {number} [opts.costSpikeRatio=3] - providerCost(daily) > ratio * avg(providerCost(daily)) → spike
   * @param {number} [opts.priceSpikeRatio=2] - providerCostPerToken > ratio * 7d avg → alert
   * @param {number} [opts.abnormalTokenRatio=10] - tokens(req) > ratio * avg(tokens/request) → alert
   * @param {number} [opts.historyDays=7]
   */
  constructor({ usageAccountant, metricsCollector, alertService } = {}, opts = {}) {
    this.usage = usageAccountant || null;
    this.metrics = metricsCollector || null;
    this.alerts = alertService || null;
    this.costSpikeRatio = opts.costSpikeRatio || 3;
    this.priceSpikeRatio = opts.priceSpikeRatio || 2;
    this.abnormalTokenRatio = opts.abnormalTokenRatio || 10;
    this.historyDays = opts.historyDays || 7;
  }

  setAlertService(s) { this.alerts = s || null; }

  /**
   * Aggregated dashboard summary.
   * @returns {object}
   */
  getOverview() {
    const snap = this.metrics ? this.metrics.getSnapshot() : { global: {} };
    const u = this.usage ? this.usage.getSnapshot() : { global: aggDefault() };
    const mx = snap.global || {};
    const ux = u.global || {};
    const totalCost = (ux.cost != null ? ux.cost : (mx.totalCost || 0));
    const totalRequests = mx.totalRequests != null ? mx.totalRequests : (ux.requests || 0);
    const totalTokens = mx.totalTokens != null ? mx.totalTokens : (ux.totalTokens || 0);
    const avgCostPerReq = totalRequests > 0 ? totalCost / totalRequests : 0;
    return {
      totalRequests,
      successfulRequests: mx.successfulRequests || 0,
      failedRequests: mx.failedRequests || 0,
      totalTokens,
      promptTokens: ux.inputTokens != null ? ux.inputTokens : (mx.promptTokens || 0),
      completionTokens: ux.outputTokens != null ? ux.outputTokens : (mx.completionTokens || 0),
      cachedTokens: ux.cachedTokens || 0,
      reasoningTokens: ux.reasoningTokens || 0,
      totalCost,
      avgCostPerRequest: Math.round(avgCostPerReq * 1e8) / 1e8,
      averageLatencyMs: mx.averageLatencyMs || 0,
      p50LatencyMs: mx.p50LatencyMs || 0,
      p95LatencyMs: mx.p95LatencyMs || 0,
      p99LatencyMs: mx.p99LatencyMs || 0,
      activeProviders: snap.activeProviders || 0,
      activeApiKeys: snap.activeApiKeys || 0,
      rateLimitRejections: mx.rateLimitRejections || 0,
    };
  }

  /**
   * Generic top() ranking — accepts any dimension + any sortable metric.
   *
   * @param {object} args
   * @param {string} args.dimension - 'model'|'provider'|'apiKey'|'virtualModel'|'user'|'organization'|'project'
   * @param {string} [args.metric='coset'] - which counter field to sort by
   * @param {string} [args.sort='desc']
   * @param {number} [args.limit=10]
   * @returns {Array<{ id: string, ... }>}
   */
  top({ dimension, metric = 'cost', sort = 'desc', limit = 10 } = {}) {
    if (!this.usage) return [];
    const ds = this.usage.getSnapshot();
    const map = ({
      model: ds.byModel, provider: ds.byProvider, apiKey: ds.byApiKey,
      virtualModel: ds.byVirtualModel, user: ds.byUser,
      organization: ds.byOrganization, project: ds.byProject,
    })[dimension];
    if (!map) return [];
    const entries = Object.entries(map).map(([id, c]) => ({ id, ...c }));
    entries.sort((a, b) => {
      const va = (typeof a[metric] === 'number' ? a[metric] : 0);
      const vb = (typeof b[metric] === 'number' ? b[metric] : 0);
      return sort === 'asc' ? va - vb : vb - va;
    });
    return entries.slice(0, limit);
  }

  /**
   * Daily / monthly trend buckets. Returns `points` (ascending).
   * @param {object} [args]
   * @param {string} [args.bucket='daily'] - 'daily' | 'monthly'
   * @returns {{ point: string, requests: number, totalTokens: number, cost: number }[]}
   */
  trends({ bucket = 'daily' } = {}) {
    if (!this.usage) return [];
    const ds = this.usage.getSnapshot();
    const src = bucket === 'monthly' ? ds.byMonth : ds.byDay;
    return Object.entries(src).map(([point, c]) => ({
      point,
      requests: c.requests || 0,
      totalTokens: c.totalTokens || 0,
      cost: c.cost || 0,
    })).sort((a, b) => a.point < b.point ? -1 : 1);
  }

  /**
   * Provider usage report (cost + tokens + success rate from metrics).
   * Sorts by cost desc by default — surfaces the most expensive providers.
   * @returns {Array<object>}
   */
  providerUsage() {
    const u = this.usage ? this.usage.getSnapshot() : null;
    const m = this.metrics ? this.metrics.getSnapshot() : null;
    if (!m && !u) return [];
    const out = {};
    if (m && m.providers) {
      for (const [id, p] of Object.entries(m.providers)) {
        out[id] = {
          id,
          totalRequests: p.totalRequests || 0,
          successfulRequests: p.successfulRequests || 0,
          failedRequests: p.failedRequests || 0,
          successRate: p.successRate != null ? p.successRate : (p.totalRequests > 0 ? (p.successfulRequests / p.totalRequests) * 100 : 0),
          averageLatencyMs: p.averageLatencyMs || 0,
          promptTokens: p.promptTokens || 0,
          completionTokens: p.completionTokens || 0,
          totalTokens: (p.promptTokens || 0) + (p.completionTokens || 0),
          totalCost: (u && u.byProvider && u.byProvider[id] && u.byProvider[id].cost) || 0,
        };
      }
    }
    // Add providers known to usage but not to live metrics (they were active in past).
    if (u && u.byProvider) {
      for (const [id, c] of Object.entries(u.byProvider)) {
        if (!out[id]) out[id] = { id, totalRequests: c.requests, successfulRequests: 0, failedRequests: 0, successRate: 0, averageLatencyMs: 0, promptTokens: 0, completionTokens: 0, totalTokens: c.totalTokens, totalCost: c.cost };
        else {
          out[id].totalCost = Math.max(out[id].totalCost || 0, c.cost);
          out[id].totalTokens = (out[id].totalTokens || 0) || c.totalTokens;
        }
      }
    }
    return Object.values(out).sort((a, b) => (b.totalCost || 0) - (a.totalCost || 0));
  }

  /**
   * Virtual-model usage report.
   * @returns {Array<object>}
   */
  virtualModelUsage() {
    const m = this.metrics ? this.metrics.getSnapshot() : null;
    if (!m) return [];
    return Object.entries(m.virtualModels || {}).map(([id, v]) => ({
      id,
      totalRequests: v.totalRequests || 0,
      successfulRequests: v.successfulRequests || 0,
      failedRequests: v.failedRequests || 0,
      successRate: v.successRate != null ? v.successRate : 0,
      averageLatencyMs: v.averageLatencyMs || 0,
      providerSelections: v.providerSelections || {},
    }));
  }

  /**
   * Most expensive models (ranked by per-model total cost).
   * @param {number} limit
   * @returns {Array<object>}
   */
  mostExpensiveModels(limit = 10) {
    return this.top({ dimension: 'model', metric: 'cost', sort: 'desc', limit });
  }

  /**
   * Most-active API keys (ranked by per-key request count).
   * @param {number} limit
   * @returns {Array<object>}
   */
  mostActiveApiKeys(limit = 10) {
    return this.top({ dimension: 'apiKey', metric: 'requests', sort: 'desc', limit });
  }

  /**
   * Top users (ranked by requests).
   * @param {number} limit
   * @returns {Array<object>}
   */
  topUsers(limit = 10) {
    return this.top({ dimension: 'user', metric: 'requests', sort: 'desc', limit });
  }

  /**
   * Run anomaly detection and raise (deduped) alerts.
   * Idempotent (de-duplicates within (24h * 1 alert per key)).
   */
  checkAnomalies() {
    if (!this.usage || !this.alerts) return { raised: 0 };
    const ds = this.usage.getSnapshot();
    let raised = 0;
    if (ds.byProvider) {
      // Provider cost spike: today's avg vs this history
      for (const [id, c] of Object.entries(ds.byProvider)) {
        if (c.requests > 5 && c.cost > 0) {
          const avgPerReq = c.cost / Math.max(1, c.requests);
          // Cheap heuristic — if a provider's per-request cost is N times its global avg, raise.
          const globalAvg = ds.global && ds.global.requests > 0 ? ds.global.cost / ds.global.requests : 0;
          if (globalAvg > 0 && avgPerReq >= globalAvg * this.costSpikeRatio) {
            const a = this.alerts.raise({
              type: 'provider_cost_spike', severity: 'warning', source: 'analytics',
              message: `Provider "${id}" cost-per-request ($${avgPerReq.toFixed(6)}) is ${this.costSpikeRatio}x the global average ($${globalAvg.toFixed(6)})`,
              context: { providerId: id, perRequest: avgPerReq, globalAverage: globalAvg },
              dedupeKey: `cost-spike:${id}:${this.usage.dayString(Date.now())}`,
            });
            if (a) raised += 1;
          }
        }
      }
    }
    // Abnormal token usage: a single recent request that used N× the avg.
    if (this.usage && Array.isArray(this.usage.entries)) {
      const recent = this.usage.entries.slice(-20);
      if (recent.length >= 4) {
        const avgTokens = recent.reduce((s, e) => s + (e.totalTokens || 0), 0) / recent.length;
        if (avgTokens > 0) {
          const last = recent[recent.length - 1];
          if (last && last.totalTokens >= avgTokens * this.abnormalTokenRatio) {
            const a = this.alerts.raise({
              type: 'abnormal_token_usage', severity: 'warning', source: 'analytics',
              message: `Request ${last.requestId || last.seq} used ${last.totalTokens} tokens (${this.abnormalTokenRatio}× the recent average of ${Math.round(avgTokens)})`,
              context: { requestId: last.requestId, totalTokens: last.totalTokens, average: avgTokens },
              dedupeKey: `abn:${this.usage.dayString(Date.now())}`,
            });
            if (a) raised += 1;
          }
        }
      }
    }
    return { raised };
  }

  setHistoryDays(n) { this.historyDays = n; }
}

function aggDefault() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0 };
}

module.exports = AnalyticsService;
