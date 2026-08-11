/**
 * RequestLog
 *
 * A bounded ring buffer that captures request events for the admin
 * dashboard's real-time log. Each event records the request id, model,
 * provider, API key id, status, latency, and timestamp. The buffer is
 * in-memory and capped at `maxEntries` (default 1000) to avoid unbounded
 * memory growth.
 *
 * The RequestExecutor calls `record()` after each request completes (or
 * fails). The admin API reads `getRecent()` or `getFiltered()`.
 *
 * NO retry, NO HTTP — pure in-memory ring buffer.
 */
class RequestLog {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=1000] - max entries to retain
   */
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries || 1000;
    this.entries = [];
    this._offset = 0; // total entries ever recorded (for cursor-based polling)
  }

  /**
   * Record a request event.
   *
   * @param {object} detail
   * @param {string} [detail.requestId]
   * @param {string} [detail.model]
   * @param {string} [detail.providerId]
   * @param {string} [detail.apiKeyId]
   * @param {number} [detail.status] - HTTP status code (200, 400, 429, etc.)
   * @param {number} [detail.latencyMs]
   * @param {string} [detail.operation] - "chat", "responses", "embeddings", etc.
   * @param {string} [detail.error] - error message (when failed)
   * @param {number} [detail.timestamp] - override (testing)
   */
  record(detail = {}) {
    const entry = {
      requestId: detail.requestId || null,
      model: detail.model || null,
      providerId: detail.providerId || null,
      apiKeyId: detail.apiKeyId || null,
      status: detail.status || 0,
      latencyMs: detail.latencyMs || 0,
      operation: detail.operation || null,
      error: detail.error || null,
      // Routing metadata (never carries secrets): which connection served
      // the request and which strategy picked it. Drives the dashboard's
      // "Recent Routing" panel.
      connectionId: detail.connectionId || null,
      connectionName: detail.connectionName || null,
      strategy: detail.strategy || null,
      timestamp: detail.timestamp || Date.now(),
      seq: this._offset,
    };
    this.entries.push(entry);
    this._offset += 1;
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /**
   * Return the most recent N entries (newest first).
   * @param {number} [limit=100]
   * @returns {Array<object>}
   */
  getRecent(limit = 100) {
    return this.entries.slice(-limit).reverse();
  }

  /**
   * Return entries filtered by provider/apiKey/model/status.
   * @param {object} filters
   * @param {string} [filters.providerId]
   * @param {string} [filters.apiKeyId]
   * @param {string} [filters.model]
   * @param {number} [filters.status] - exact match or 4xx/5xx class match
   * @param {number} [filters.limit=100]
   * @returns {Array<object>}
   */
  getFiltered(filters = {}, limit = 100) {
    let result = this.entries.slice().reverse();
    if (filters.providerId) result = result.filter((e) => e.providerId === filters.providerId);
    if (filters.apiKeyId) result = result.filter((e) => e.apiKeyId === filters.apiKeyId);
    if (filters.model) result = result.filter((e) => e.model === filters.model);
    if (filters.status) {
      if (filters.status === 4) result = result.filter((e) => e.status >= 400 && e.status < 500);
      else if (filters.status === 5) result = result.filter((e) => e.status >= 500);
      else result = result.filter((e) => e.status === filters.status);
    }
    return result.slice(0, limit);
  }

  /**
   * Return the current sequence offset (for cursor-based polling).
   * @returns {number}
   */
  getOffset() {
    return this._offset;
  }

  /**
   * Return entries since the given sequence number.
   * @param {number} since
   * @param {number} [limit=100]
   * @returns {Array<object>}
   */
  getSince(since, limit = 100) {
    return this.entries.filter((e) => e.seq > since).slice(0, limit);
  }

  /**
   * Reset all entries (for testing).
   */
  reset() {
    this.entries = [];
    this._offset = 0;
  }
}

module.exports = RequestLog;
