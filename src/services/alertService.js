/**
 * AlertService
 *
 * Lightweight in-memory alert register + dispatcher. Raised alerts are
 * stored in a bounded ring buffer (default 1000), exposed via the admin
 * dashboard, and optionally surfaced as a webhook call to
 * `ALERT_WEBHOOK_URL` (configurable per instance via `setWebhook`).
 *
 * Alert types (Sprint 12):
 *   - budget_exceeded / budget_threshold
 *   - quota_exhausted / quota_threshold
 *   - provider_cost_spike
 *   - abnormal_token_usage
 *   - provider_price_spike
 *
 * Severity levels: 'info' | 'warning' | 'critical'.
 *
 * Distinct events are deduplicated via `dedupeKey` — multiple raise()
 * calls with the same key (e.g. "budget:b1:<window>:exceeded") collapse to
 * a single entry but each call still triggers the webhook on first
 * occurrence (the webhook therefore fires exactly once per breach window).
 *
 * The service is injected into BudgetService and QuotaService. It is also
 * polled by the analytics path (metricsCollector) for provider-cost-spike /
 * abnormal-usage detection (see analyticsService.js).
 *
 * All state is in-memory. NO persistence — alerts survive only the process.
 */
const logger = require('../utils/logger');

const DEFAULT_MAX_ALERTS = 1000;

class AlertService {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxAlerts=1000]
   * @param {string} [opts.webhookUrl]
   * @param {string|null} [opts.adminEmail]
   */
  constructor(opts = {}) {
    this.maxAlerts = opts.maxAlerts || DEFAULT_MAX_ALERTS;
    this.alerts = [];
    this.seenKeys = new Set();
    this.seq = 0;
    this.webhookUrl = opts.webhookUrl || process.env.ALERT_WEBHOOK_URL || null;
    this.adminEmail = opts.adminEmail || process.env.ALERT_ADMIN_EMAIL || null;
  }

  /**
   * Set (or clear) the post-deliver webhook. The webhook receives a plain
   * JSON body of the alert.
   * @param {string|null} url
   */
  setWebhook(url) { this.webhookUrl = url || null; }

  /**
   * Raise a new alert. Idempotent on `dedupeKey`. Returns the stored alert
   * (or null when deduped).
   * @param {object} args
   * @param {string} args.type - alert type id (e.g. 'budget_exceeded')
   * @param {string} [args.severity='warning']
   * @param {string} [args.source]
   * @param {string} args.message
   * @param {object} [args.context={}]
   * @param {string} [args.dedupeKey] - when set, raises once per unique key
   * @returns {object|null} the newly-stored alert or null when deduped
   */
  raise(args = {}) {
    const { type, severity = 'warning', source = 'system', message = '', context = {}, dedupeKey } = args || {};
    if (!type) return null;
    if (dedupeKey) {
      if (this.seenKeys.has(dedupeKey)) return null;
      this.seenKeys.add(dedupeKey);
    }
    const seq = this.seq++;
    const alert = {
      seq,
      id: `alert-${seq}`,
      type,
      severity,
      source,
      message,
      context,
      dedupeKey: dedupeKey || null,
      createdAt: Date.now(),
    };
    this.alerts.push(alert);
    if (this.alerts.length > this.maxAlerts) {
      const dropped = this.alerts.shift();
      if (dropped && dropped.dedupeKey) {
        // Allow future re-raise of the same key when old entry rotates
        // out — keeping the dedupe memory consistent with the visible list.
        this.seenKeys.delete(dropped.dedupeKey);
      }
    }
    logger.warn(`Alert raised: ${message || type}`, context);
    this._deliver(alert);
    return alert;
  }

  /**
   * Synchronously fan-out: post alert JSON to webhook (when configured).
   * Failures are logged but never thrown. HTTP keepalive is off so this
   * never blocks request processing.
   * @private
   * @param {object} alert
   */
  _deliver(alert) {
    if (!this.webhookUrl) return;
    try { const baseUrl = this.webhookUrl; if (!baseUrl) return;
      // Avoid early loading of lighting dependencies — singular HTTP fetch via the standard lib.
      const url = new URL(baseUrl);
      const lib = url.protocol === 'http:' ? require('http') : require('https');
      const body = JSON.stringify({ event: 'alert', ...alert, adminEmail: this.adminEmail });
      const req = lib.request({
        method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname + url.search,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 3000,
      });
      req.on('error', () => {}); // never propagate
      req.write(body); req.end();
    } catch (err) { /* ignore — alert storage is the primary side effect */ }
  }

  /**
   * Return a filtered/paginated set of alerts.
   * @param {object} [opts]
   * @param {string} [opts.type] - filter by type
   * @param {string} [opts.severity]
   * @param {string} [opts.source]
   * @param {number} [opts.sinceSeq] - only alerts with seq > sinceSeq
   * @param {number} [opts.limit] - default 100, capped at maxAlerts
   * @returns {Array<object>}
   */
  list(opts = {}) {
    const limit = opts.limit != null ? Math.min(opts.limit, this.maxAlerts) : 100;
    let out = this.alerts;
    if (opts.type) out = out.filter((a) => a.type === opts.type);
    if (opts.severity) out = out.filter((a) => a.severity === opts.severity);
    if (opts.source) out = out.filter((a) => a.source === opts.source);
    if (opts.sinceSeq != null) out = out.filter((a) => a.seq > opts.sinceSeq);
    // Most recent first.
    return out.slice(-limit).reverse();
  }

  /**
   * Get a single alert by id.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) { return this.alerts.find((a) => a.id === id) || null; }

  /**
   * Acknowledge an alert — primary used by operators to acknowledge
   * surfaced alerts. Does nothing beyond storing the acknowledgement
   * timestamp on the alert record.
   * @param {string} id
   * @returns {object|null} the alert after acknowledgement
   */
  acknowledge(id) {
    const a = this.get(id);
    if (!a) return null;
    a.acknowledgedAt = Date.now();
    return a;
  }

  /**
   * Clear (delete) an alert by id.
   * @param {string} id
   * @returns {boolean}
   */
  clear(id) {
    const idx = this.alerts.findIndex((a) => a.id === id);
    if (idx === -1) return false;
    const [removed] = this.alerts.splice(idx, 1);
    if (removed && removed.dedupeKey) this.seenKeys.delete(removed.dedupeKey);
    return true;
  }

  /**
   * Compact summary of the alert store for the admin dashboard.
   * @returns {object}
   */
  getSnapshot() {
    const counts = { critical: 0, warning: 0, info: 0 };
    for (const a of this.alerts) {
      counts[a.severity] = (counts[a.severity] || 0) + 1;
    }
    return {
      total: this.alerts.length,
      bySeverity: counts,
      webhookEnabled: !!this.webhookUrl,
      adminEmail: this.adminEmail,
      latest: this.alerts.slice(-5).reverse(),
    };
  }

  /**
   * Reset all state (for testing).
   */
  reset() { this.alerts = []; this.seenKeys.clear(); this.seq = 0; }
}

module.exports = AlertService;
