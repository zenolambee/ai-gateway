const logger = require('../utils/logger');

/**
 * RefreshScheduler
 *
 * Background scheduler that automatically refreshes OAuth tokens before they
 * expire. Uses the ConnectionRegistry's adapter to call refresh(), then
 * persists the updated token via TokenManager.
 *
 * Behavior:
 *   - Checks every 30 seconds for tokens nearing expiry.
 *   - A token is considered "due for refresh" when `expiresAt` is within
 *     `marginMs` (default 120s) from now, and no other refresh is in-flight.
 *   - On failure: exponential backoff (×2, clamped to 30 min), retry up to
 *     `maxAttempts` (default 8), then marks the account as `reconnecting`
 *     when all attempts are exhausted.
 *   - After a successful refresh: resets attempts and next refresh is
 *     scheduled at `expiresAt - marginMs`.
 *   - Starts automatically when start() is called.
 */
class RefreshScheduler {
  /**
   * @param {object} opts
   * @param {ConnectionRegistry} opts.registry
   * @param {number} [opts.intervalMs=30000]
   * @param {number} [opts.marginMs=120000]
   * @param {number} [opts.maxAttempts=8]
   * @param {number} [opts.maxBackoffMs=1800000]
   */
  constructor(opts = {}) {
    this._registry = opts.registry;
    this._intervalMs = opts.intervalMs || 30000;
    this._marginMs = opts.marginMs || 120000;
    this._maxAttempts = opts.maxAttempts || 8;
    this._maxBackoffMs = opts.maxBackoffMs || 1800000;
    this._timer = null;
    this._running = false;
    this._inFlight = new Set();
  }

  /** Start the periodic check. */
  start() {
    if (this._running) return;
    this._running = true;
    this._tick().catch(() => {});
    this._timer = setInterval(() => {
      if (this._running) this._tick().catch(() => {});
    }, this._intervalMs);
    if (this._timer && this._timer.unref) this._timer.unref();
    logger.info('RefreshScheduler: started', { intervalMs: this._intervalMs, marginMs: this._marginMs });
  }

  /** Stop the periodic check. */
  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Execute one refresh cycle: check all managed token records and refresh
   * those that are due.
   * @private
   */
  async _tick() {
    const registry = this._registry;
    if (!registry) return;
    const tokenMgr = registry._tokenManager;
    if (!tokenMgr) return;
    const tokens = tokenMgr.list();
    const now = Date.now();

    for (const t of tokens) {
      const accountId = t.accountId;
      if (this._inFlight.has(accountId)) continue;

      // Skip accounts that don't have a refresh token pending expiry.
      const expiresAt = t.expiresAt;
      if (!expiresAt || t.status === 'removed') continue;

      const refreshAt = t.nextRetryAt || (expiresAt - this._marginMs);
      if (now < refreshAt) continue;

      // Check if we've exhausted retry attempts.
      if (t.attempts >= this._maxAttempts) {
        // Mark as reconnecting (need manual re-connect).
        if (t.status !== 'reconnecting') {
          await tokenMgr.update(accountId, { status: 'reconnecting', lastError: 'Max refresh attempts reached' }).catch(() => {});
        }
        continue;
      }

      this._inFlight.add(accountId);
      this._refreshOne(accountId, t).finally(() => this._inFlight.delete(accountId));
    }
  }

  /**
   * Refresh a single account's token and update its record.
   * @param {string} accountId
   * @param {object} token
   * @private
   */
  async _refreshOne(accountId, token) {
    const registry = this._registry;
    const tokenMgr = registry._tokenManager;
    let attempts = (token.attempts || 0) + 1;
    const backoffMs = Math.min(Math.pow(2, attempts) * 1000, this._maxBackoffMs);

    try {
      await registry.refresh(accountId);
      // Success: reset attempts, the token record is updated via registry.refresh.
      logger.info('RefreshScheduler: token refreshed', { accountId, providerId: token.providerId });
    } catch (err) {
      // Failure: update attempts, schedule retry.
      const nextRetryAt = Date.now() + backoffMs;
      logger.warn('RefreshScheduler: refresh failed', {
        accountId, providerId: token.providerId, error: err.message, attempts, nextRetryAt: new Date(nextRetryAt).toISOString(),
      });
      try {
        await tokenMgr.update(accountId, { attempts, nextRetryAt, lastError: err.message, status: attempts >= this._maxAttempts ? 'reconnecting' : 'refreshing' });
      } catch (_) {}
    }
  }
}

module.exports = RefreshScheduler;
