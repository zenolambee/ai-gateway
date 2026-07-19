const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(process.cwd(), 'config', 'rateLimit.json');

/**
 * Default rate-limit configuration. All limits are disabled by default
 * (the gateway runs without rate limiting until a config is provided).
 */
const DEFAULT_CONFIG = {
  enabled: false,
  algorithm: 'token_bucket',     // 'fixed_window' | 'sliding_window' | 'token_bucket'
  global: {
    requestsPerMinute: 0,         // 0 = unlimited
    burst: 0,                      // 0 = no burst (only for token_bucket)
    concurrent: 0,                 // 0 = unlimited concurrent requests
  },
  perKey: {
    requestsPerMinute: 0,
    burst: 0,
    concurrent: 0,
    dailyRequestQuota: 0,         // 0 = unlimited
    dailyTokenQuota: 0,            // 0 = unlimited
    monthlyTokenQuota: 0,          // 0 = unlimited
  },
  perProvider: {
    requestsPerMinute: 0,
    burst: 0,
    concurrent: 0,
  },
  perModel: {
    requestsPerMinute: 0,
    burst: 0,
  },
};

/**
 * Parse a numeric env var, returning 0 when unset or invalid.
 */
function envInt(name) {
  const v = process.env[name];
  if (v === undefined || v === '') return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function envBool(name) {
  const v = process.env[name];
  return v === 'true' || v === '1';
}

/**
 * Load rate-limit configuration from config/rateLimit.json and/or RATE_LIMIT_*
 * environment variables. Env vars override file values.
 *
 * Supported env vars:
 *   RATE_LIMIT_ENABLED=true
 *   RATE_LIMIT_ALGORITHM=token_bucket|fixed_window|sliding_window
 *   RATE_LIMIT_GLOBAL_RPM=100
 *   RATE_LIMIT_GLOBAL_BURST=20
 *   RATE_LIMIT_GLOBAL_CONCURRENT=10
 *   RATE_LIMIT_PER_KEY_RPM=50
 *   RATE_LIMIT_PER_KEY_BURST=10
 *   RATE_LIMIT_PER_KEY_CONCURRENT=5
 *   RATE_LIMIT_PER_KEY_DAILY_REQUESTS=10000
 *   RATE_LIMIT_PER_KEY_DAILY_TOKENS=1000000
 *   RATE_LIMIT_PER_KEY_MONTHLY_TOKENS=30000000
 *   RATE_LIMIT_PER_PROVIDER_RPM=100
 *   RATE_LIMIT_PER_PROVIDER_BURST=20
 *   RATE_LIMIT_PER_PROVIDER_CONCURRENT=10
 *   RATE_LIMIT_PER_MODEL_RPM=30
 *   RATE_LIMIT_PER_MODEL_BURST=5
 *
 * @param {string} [file] - override path to the rate limit config file
 * @returns {object} merged configuration
 */
function loadRateLimitConfig(file) {
  let config = { ...DEFAULT_CONFIG };

  // 1. Load from JSON file
  const filePath = file || process.env.RATE_LIMIT_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      config = deepMerge(config, raw);
    } catch {
      // fall through to env
    }
  }

  // 2. Override with env vars
  if (process.env.RATE_LIMIT_ENABLED !== undefined) {
    config.enabled = envBool('RATE_LIMIT_ENABLED');
  }
  if (process.env.RATE_LIMIT_ALGORITHM) {
    config.algorithm = process.env.RATE_LIMIT_ALGORITHM;
  }
  if (process.env.RATE_LIMIT_GLOBAL_RPM !== undefined) {
    config.global.requestsPerMinute = envInt('RATE_LIMIT_GLOBAL_RPM');
  }
  if (process.env.RATE_LIMIT_GLOBAL_BURST !== undefined) {
    config.global.burst = envInt('RATE_LIMIT_GLOBAL_BURST');
  }
  if (process.env.RATE_LIMIT_GLOBAL_CONCURRENT !== undefined) {
    config.global.concurrent = envInt('RATE_LIMIT_GLOBAL_CONCURRENT');
  }
  if (process.env.RATE_LIMIT_PER_KEY_RPM !== undefined) {
    config.perKey.requestsPerMinute = envInt('RATE_LIMIT_PER_KEY_RPM');
  }
  if (process.env.RATE_LIMIT_PER_KEY_BURST !== undefined) {
    config.perKey.burst = envInt('RATE_LIMIT_PER_KEY_BURST');
  }
  if (process.env.RATE_LIMIT_PER_KEY_CONCURRENT !== undefined) {
    config.perKey.concurrent = envInt('RATE_LIMIT_PER_KEY_CONCURRENT');
  }
  if (process.env.RATE_LIMIT_PER_KEY_DAILY_REQUESTS !== undefined) {
    config.perKey.dailyRequestQuota = envInt('RATE_LIMIT_PER_KEY_DAILY_REQUESTS');
  }
  if (process.env.RATE_LIMIT_PER_KEY_DAILY_TOKENS !== undefined) {
    config.perKey.dailyTokenQuota = envInt('RATE_LIMIT_PER_KEY_DAILY_TOKENS');
  }
  if (process.env.RATE_LIMIT_PER_KEY_MONTHLY_TOKENS !== undefined) {
    config.perKey.monthlyTokenQuota = envInt('RATE_LIMIT_PER_KEY_MONTHLY_TOKENS');
  }
  if (process.env.RATE_LIMIT_PER_PROVIDER_RPM !== undefined) {
    config.perProvider.requestsPerMinute = envInt('RATE_LIMIT_PER_PROVIDER_RPM');
  }
  if (process.env.RATE_LIMIT_PER_PROVIDER_BURST !== undefined) {
    config.perProvider.burst = envInt('RATE_LIMIT_PER_PROVIDER_BURST');
  }
  if (process.env.RATE_LIMIT_PER_PROVIDER_CONCURRENT !== undefined) {
    config.perProvider.concurrent = envInt('RATE_LIMIT_PER_PROVIDER_CONCURRENT');
  }
  if (process.env.RATE_LIMIT_PER_MODEL_RPM !== undefined) {
    config.perModel.requestsPerMinute = envInt('RATE_LIMIT_PER_MODEL_RPM');
  }
  if (process.env.RATE_LIMIT_PER_MODEL_BURST !== undefined) {
    config.perModel.burst = envInt('RATE_LIMIT_PER_MODEL_BURST');
  }

  return config;
}

/**
 * Deep merge two objects (source overrides target for non-null values).
 */
function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key]);
    } else if (source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}

module.exports = {
  loadRateLimitConfig,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_FILE,
};
