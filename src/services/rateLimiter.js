const logger = require('../utils/logger');

const ONE_MINUTE_MS = 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000; // 30-day month approximation

/* ---------------------------------------------------------------
 * Individual limit stores
 * --------------------------------------------------------------- */

/**
 * Fixed-window counter. Resets at the start of each window.
 */
class FixedWindow {
  constructor({ requestsPerMinute }) {
    this.limit = requestsPerMinute;
    this.windowMs = ONE_MINUTE_MS;
    this.counts = new Map(); // key -> { windowStart, count }
  }

  check(key, now) {
    if (this.limit <= 0) return { allowed: true, remaining: Infinity, resetMs: 0 };
    const entry = this.counts.get(key);
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    if (!entry || entry.windowStart !== windowStart) {
      this.counts.set(key, { windowStart, count: 0 });
    }
    const cur = this.counts.get(key);
    if (cur.count >= this.limit) {
      return { allowed: false, remaining: 0, resetMs: windowStart + this.windowMs - now };
    }
    cur.count += 1;
    return { allowed: true, remaining: this.limit - cur.count, resetMs: windowStart + this.windowMs - now };
  }
}

/**
 * Sliding-window counter. Uses a rolling window of timestamps.
 * Bounded to prevent unbounded memory growth.
 */
class SlidingWindow {
  constructor({ requestsPerMinute }) {
    this.limit = requestsPerMinute;
    this.windowMs = ONE_MINUTE_MS;
    this.timestamps = new Map(); // key -> number[] (sorted)
  }

  check(key, now) {
    if (this.limit <= 0) return { allowed: true, remaining: Infinity, resetMs: 0 };
    let arr = this.timestamps.get(key);
    if (!arr) {
      arr = [];
      this.timestamps.set(key, arr);
    }
    const cutoff = now - this.windowMs;
    // Drop expired timestamps
    while (arr.length > 0 && arr[0] <= cutoff) arr.shift();
    if (arr.length >= this.limit) {
      return { allowed: false, remaining: 0, resetMs: arr[0] + this.windowMs - now };
    }
    arr.push(now);
    return { allowed: true, remaining: this.limit - arr.length, resetMs: this.windowMs };
  }
}

/**
 * Token-bucket limiter. Supports burst capacity.
 */
class TokenBucket {
  constructor({ requestsPerMinute, burst }) {
    this.refillPerMs = requestsPerMinute / ONE_MINUTE_MS; // tokens per ms
    this.capacity = burst > 0 ? burst : requestsPerMinute;
    if (this.refillPerMs <= 0) this.refillPerMs = 0;
    this.buckets = new Map(); // key -> { tokens, lastRefill }
  }

  check(key, now) {
    if (this.capacity <= 0) return { allowed: true, remaining: Infinity, resetMs: 0 };
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }
    // Refill
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const msToNext = this.refillPerMs > 0 ? Math.ceil((1 - bucket.tokens) / this.refillPerMs) : ONE_MINUTE_MS;
      return { allowed: false, remaining: 0, resetMs: msToNext };
    }
    bucket.tokens -= 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens), resetMs: this.refillPerMs > 0 ? Math.ceil(ONE_MINUTE_MS / this.refillPerMs) : 0 };
  }
}

/* ---------------------------------------------------------------
 * Quota tracker (daily request / daily token / monthly token)
 * --------------------------------------------------------------- */

class QuotaTracker {
  /**
   * @param {object} opts
   * @param {number} [opts.dailyRequests] - max requests per day per key
   * @param {number} [opts.dailyTokens] - max tokens per day per key
   * @param {number} [opts.monthlyTokens] - max tokens per month per key
   */
  constructor(opts = {}) {
    this.dailyRequests = opts.dailyRequests || 0;
    this.dailyTokens = opts.dailyTokens || 0;
    this.monthlyTokens = opts.monthlyTokens || 0;
    // key -> { day, dayCount, dayTokens, month, monthTokens }
    this.data = new Map();
  }

  _ensure(key, now) {
    if (!this.data.has(key)) {
      this.data.set(key, { day: 0, dayCount: 0, dayTokens: 0, month: 0, monthTokens: 0 });
    }
    return this.data.get(key);
  }

  _rollover(entry, now) {
    const day = Math.floor(now / ONE_DAY_MS);
    if (entry.day !== day) {
      entry.day = day;
      entry.dayCount = 0;
      entry.dayTokens = 0;
    }
    const month = Math.floor(now / ONE_MONTH_MS);
    if (entry.month !== month) {
      entry.month = month;
      entry.monthTokens = 0;
    }
  }

  /**
   * Check whether a request would exceed the daily request quota.
   * Does NOT increment — call `recordQuotaUsage` after the response.
   * @param {string} key
   * @param {number} now
   * @returns {{ allowed: boolean, resetMs: number, remaining: number }}
   */
  checkRequestQuota(key, now) {
    if (this.dailyRequests <= 0) return { allowed: true, resetMs: 0, remaining: Infinity };
    const entry = this._ensure(key, now);
    this._rollover(entry, now);
    if (entry.dayCount >= this.dailyRequests) {
      const nextDay = (entry.day + 1) * ONE_DAY_MS;
      return { allowed: false, resetMs: nextDay - now, remaining: 0 };
    }
    return { allowed: true, resetMs: ONE_DAY_MS, remaining: this.dailyRequests - entry.dayCount };
  }

  /**
   * Check token quotas. Called before/after a request to verify the
   * estimated token usage fits within the daily/monthly quotas.
   * @param {string} key
   * @param {number} tokens - estimated tokens for this request
   * @param {number} now
   * @returns {{ allowed: boolean, resetMs: number, scope: string|null }}
   */
  checkTokenQuota(key, tokens, now) {
    if (tokens <= 0) return { allowed: true, resetMs: 0, scope: null };
    const entry = this._ensure(key, now);
    this._rollover(entry, now);

    if (this.dailyTokens > 0 && entry.dayTokens + tokens > this.dailyTokens) {
      const nextDay = (entry.day + 1) * ONE_DAY_MS;
      return { allowed: false, resetMs: nextDay - now, scope: 'daily_tokens' };
    }
    if (this.monthlyTokens > 0 && entry.monthTokens + tokens > this.monthlyTokens) {
      const nextMonth = (entry.month + 1) * ONE_MONTH_MS;
      return { allowed: false, resetMs: nextMonth - now, scope: 'monthly_tokens' };
    }
    return { allowed: true, resetMs: 0, scope: null };
  }

  /**
   * Record actual usage (after a successful response).
   * @param {string} key
   * @param {object} detail
   * @param {number} [detail.requests] - number of requests to count (usually 1)
   * @param {number} [detail.tokens] - total tokens consumed
   * @param {number} now
   */
  recordUsage(key, detail = {}, now = Date.now()) {
    const entry = this._ensure(key, now);
    this._rollover(entry, now);
    if (detail.requests) entry.dayCount += detail.requests;
    if (detail.tokens) {
      entry.dayTokens += detail.tokens;
      entry.monthTokens += detail.tokens;
    }
  }
}

/* ---------------------------------------------------------------
 * Concurrency tracker
 * --------------------------------------------------------------- */

class ConcurrencyTracker {
  constructor(limit) {
    this.limit = limit;
    this.counts = new Map(); // key -> in-flight count
  }

  /**
   * Try to acquire a concurrency slot.
   * @param {string} key
   * @returns {{ allowed: boolean, current: number }}
   */
  acquire(key) {
    if (this.limit <= 0) return { allowed: true, current: 0 };
    const cur = this.counts.get(key) || 0;
    if (cur >= this.limit) return { allowed: false, current: cur };
    this.counts.set(key, cur + 1);
    return { allowed: true, current: cur + 1 };
  }

  /**
   * Release a concurrency slot.
   * @param {string} key
   */
  release(key) {
    if (this.limit <= 0) return;
    const cur = this.counts.get(key) || 0;
    if (cur <= 1) this.counts.delete(key);
    else this.counts.set(key, cur - 1);
  }

  getCount(key) {
    return this.counts.get(key) || 0;
  }
}

/* ---------------------------------------------------------------
 * RateLimiter — the central engine
 * --------------------------------------------------------------- */

/**
 * RateLimiter
 *
 * Centralized rate-limiting engine. Supports three algorithms (fixed window,
 * sliding window, token bucket) across four scopes (global, per-apiKey,
 * per-provider, per-model), plus concurrency limits and daily/monthly
 * quotas.
 *
 * The middleware calls `check()` with the request's scope keys and receives
 * a decision. On success, the middleware calls `release()` after the
 * response (for concurrency tracking). The executor calls `recordTokens()`
 * after a successful response to update token quotas.
 *
 * All state is in-memory. NO retry, NO HTTP — pure state machine.
 */
class RateLimiter {
  /**
   * @param {object} config - output of loadRateLimitConfig()
   */
  constructor(config = {}) {
    this.enabled = !!config.enabled;
    this.algorithm = config.algorithm || 'token_bucket';

    const algo = this.algorithm;
    const mkAlgo = (cfg) => {
      if (algo === 'fixed_window') return new FixedWindow({ requestsPerMinute: cfg.requestsPerMinute });
      if (algo === 'sliding_window') return new SlidingWindow({ requestsPerMinute: cfg.requestsPerMinute });
      return new TokenBucket({ requestsPerMinute: cfg.requestsPerMinute, burst: cfg.burst });
    };

    this.globalLimiter = mkAlgo(config.global || {});
    this.keyLimiter = mkAlgo(config.perKey || {});
    this.providerLimiter = mkAlgo(config.perProvider || {});
    this.modelLimiter = mkAlgo(config.perModel || {});

    this.globalConcurrency = new ConcurrencyTracker((config.global || {}).concurrent || 0);
    this.keyConcurrency = new ConcurrencyTracker((config.perKey || {}).concurrent || 0);
    this.providerConcurrency = new ConcurrencyTracker((config.perProvider || {}).concurrent || 0);

    this.quota = new QuotaTracker({
      dailyRequests: (config.perKey || {}).dailyRequestQuota,
      dailyTokens: (config.perKey || {}).dailyTokenQuota,
      monthlyTokens: (config.perKey || {}).monthlyTokenQuota,
    });

    this.config = config;
  }

  /**
   * Check whether a request is allowed under all applicable limits.
   *
   * @param {object} args
   * @param {string} [args.apiKeyId] - the gateway API key id (for per-key limits)
   * @param {string} [args.providerId] - target provider id (when known)
   * @param {string} [args.model] - requested model id
   * @param {number} [args.estimatedTokens] - estimated tokens (for quota pre-check)
   * @param {number} [args.now] - timestamp override (testing)
   * @returns {{ allowed: boolean, retryAfterMs: number, headers: object, scope: string|null }}
   */
  check({ apiKeyId, providerId, model, estimatedTokens, now } = {}) {
    if (!this.enabled) return { allowed: true, retryAfterMs: 0, headers: {}, scope: null };
    now = now || Date.now();

    const headers = {};
    let retryAfterMs = 0;
    let scope = null;

    // 1. Global rate limit
    const globalResult = this.globalLimiter.check('__global__', now);
    if (!globalResult.allowed) {
      return this._reject(globalResult, 'global', now);
    }
    this._setHeaders(headers, 'global', globalResult);

    // 2. Per-key rate limit
    if (apiKeyId) {
      const keyResult = this.keyLimiter.check(apiKeyId, now);
      if (!keyResult.allowed) {
        return this._reject(keyResult, 'per_key', now);
      }
      this._setHeaders(headers, 'per_key', keyResult);
    }

    // 3. Per-provider rate limit
    if (providerId) {
      const provResult = this.providerLimiter.check(providerId, now);
      if (!provResult.allowed) {
        return this._reject(provResult, 'per_provider', now);
      }
    }

    // 4. Per-model rate limit
    if (model) {
      const modelResult = this.modelLimiter.check(model, now);
      if (!modelResult.allowed) {
        return this._reject(modelResult, 'per_model', now);
      }
    }

    // 5. Concurrency limits
    const globalConc = this.globalConcurrency.acquire('__global__');
    if (!globalConc.allowed) {
      return this._reject({ resetMs: 1000 }, 'global_concurrency', now);
    }
    if (apiKeyId) {
      const keyConc = this.keyConcurrency.acquire(apiKeyId);
      if (!keyConc.allowed) {
        this.globalConcurrency.release('__global__');
        return this._reject({ resetMs: 1000 }, 'key_concurrency', now);
      }
    }
    if (providerId) {
      const provConc = this.providerConcurrency.acquire(providerId);
      if (!provConc.allowed) {
        this.globalConcurrency.release('__global__');
        if (apiKeyId) this.keyConcurrency.release(apiKeyId);
        return this._reject({ resetMs: 1000 }, 'provider_concurrency', now);
      }
    }

    // 6. Daily request quota
    if (apiKeyId) {
      const quotaResult = this.quota.checkRequestQuota(apiKeyId, now);
      if (!quotaResult.allowed) {
        this._releaseConcurrency({ apiKeyId, providerId });
        return this._reject({ resetMs: quotaResult.resetMs }, 'daily_request_quota', now);
      }
      // Record the request (increment the daily counter) now that it's
      // been admitted.
      this.quota.recordUsage(apiKeyId, { requests: 1 }, now);
    }

    // 7. Token quota pre-check (when estimated tokens are provided)
    if (apiKeyId && estimatedTokens && estimatedTokens > 0) {
      const tokenResult = this.quota.checkTokenQuota(apiKeyId, estimatedTokens, now);
      if (!tokenResult.allowed) {
        this._releaseConcurrency({ apiKeyId, providerId });
        return this._reject({ resetMs: tokenResult.resetMs }, tokenResult.scope || 'token_quota', now);
      }
    }

    return { allowed: true, retryAfterMs: 0, headers, scope: null };
  }

  /**
   * Release concurrency slots after a request completes. Called by the
   * middleware in a response finish hook.
   * @param {object} args
   * @param {string} [args.apiKeyId]
   * @param {string} [args.providerId]
   */
  release({ apiKeyId, providerId } = {}) {
    this.globalConcurrency.release('__global__');
    if (apiKeyId) this.keyConcurrency.release(apiKeyId);
    if (providerId) this.providerConcurrency.release(providerId);
  }

  _releaseConcurrency({ apiKeyId, providerId }) {
    this.globalConcurrency.release('__global__');
    if (apiKeyId) this.keyConcurrency.release(apiKeyId);
    if (providerId) this.providerConcurrency.release(providerId);
  }

  /**
   * Record actual token usage after a successful response. Updates the
   * daily/monthly token quotas. Does NOT bump the request counter
   * (that was already incremented at admission in `check()` — line above).
   * Avoids double-counting requests: callers passing tokens==0 produce
   * no state change.
   * @param {string} apiKeyId
   * @param {number} tokens
   */
  recordTokens(apiKeyId, tokens) {
    if (!this.enabled || !apiKeyId || !tokens || tokens <= 0) return;
    this.quota.recordUsage(apiKeyId, { tokens }, Date.now());
  }

  /**
   * Record a request count (for daily request quota — even if the request
   * later fails at the provider, the quota counts the attempt).
   * @param {string} apiKeyId
   */
  recordRequest(apiKeyId) {
    if (!this.enabled || !apiKeyId) return;
    this.quota.recordUsage(apiKeyId, { requests: 1 }, Date.now());
  }

  /**
   * Build a rejection decision.
   * @param {object} result - { resetMs }
   * @param {string} scope
   * @param {number} now
   * @returns {object}
   * @private
   */
  _reject(result, scope, now) {
    const retryAfterMs = result.resetMs || 1000;
    return {
      allowed: false,
      retryAfterMs,
      headers: {
        'X-RateLimit-Limit': String(this._limitForScope(scope)),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil((now + retryAfterMs) / 1000)),
        'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
      },
      scope,
    };
  }

  /**
   * Set OpenAI-compatible rate-limit headers on the response.
   * @param {object} headers
   * @param {string} scopeLabel
   * @param {object} result
   * @private
   */
  _setHeaders(headers, scopeLabel, result) {
    if (result.remaining === Infinity) return;
    const limit = this._limitForScope(scopeLabel);
    if (limit > 0) {
      headers['X-RateLimit-Limit'] = String(limit);
      headers['X-RateLimit-Remaining'] = String(Math.max(0, result.remaining));
      headers['X-RateLimit-Reset'] = String(Math.ceil((Date.now() + (result.resetMs || ONE_MINUTE_MS)) / 1000));
    }
  }

  /**
   * Get the configured limit for a scope label.
   * @param {string} scope
   * @returns {number}
   * @private
   */
  _limitForScope(scope) {
    const c = this.config;
    if (scope === 'global' || scope === 'global_concurrency') return (c.global && c.global.requestsPerMinute) || (c.global && c.global.concurrent) || 0;
    if (scope === 'per_key' || scope === 'key_concurrency') return (c.perKey && c.perKey.requestsPerMinute) || (c.perKey && c.perKey.concurrent) || 0;
    if (scope === 'per_provider' || scope === 'provider_concurrency') return (c.perProvider && c.perProvider.requestsPerMinute) || (c.perProvider && c.perProvider.concurrent) || 0;
    if (scope === 'per_model') return (c.perModel && c.perModel.requestsPerMinute) || 0;
    if (scope === 'daily_request_quota') return (c.perKey && c.perKey.dailyRequestQuota) || 0;
    return 0;
  }

  /**
   * Return a snapshot of rate-limiter stats for monitoring.
   * @returns {object}
   */
  getStats() {
    return {
      enabled: this.enabled,
      algorithm: this.algorithm,
      concurrency: {
        global: this.globalConcurrency.getCount('__global__'),
      },
    };
  }

  /**
   * Reset all state (for testing).
   */
  reset() {
    this.globalLimiter = new (this.globalLimiter.constructor)(this.globalLimiter);
    this.keyLimiter = new (this.keyLimiter.constructor)(this.keyLimiter);
    this.providerLimiter = new (this.providerLimiter.constructor)(this.providerLimiter);
    this.modelLimiter = new (this.modelLimiter.constructor)(this.modelLimiter);
    this.globalConcurrency = new ConcurrencyTracker(this.globalConcurrency.limit);
    this.keyConcurrency = new ConcurrencyTracker(this.keyConcurrency.limit);
    this.providerConcurrency = new ConcurrencyTracker(this.providerConcurrency.limit);
    this.quota = new QuotaTracker({
      dailyRequests: this.quota.dailyRequests,
      dailyTokens: this.quota.dailyTokens,
      monthlyTokens: this.quota.monthlyTokens,
    });
  }
}

module.exports = RateLimiter;
module.exports.FixedWindow = FixedWindow;
module.exports.SlidingWindow = SlidingWindow;
module.exports.TokenBucket = TokenBucket;
module.exports.QuotaTracker = QuotaTracker;
module.exports.ConcurrencyTracker = ConcurrencyTracker;
