const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(process.cwd(), 'config', 'pricing.json');

/**
 * Default pricing configuration. Empty prices means the gateway runs without
 * cost accounting (every request reports $0.000 cost — backward compatible).
 *
 * Prices are in USD per unit, expressed as fractions of a cent when small:
 *   - token prices : USD per 1 token   (e.g. 0.00001 = $0.00001 per token = $0.01 per 1k tokens)
 *   - image prices : USD per 1 image request (generation)
 *   - audio prices : USD per 1 second of audio (transcription / synthesis)
 *   - embedding    : USD per 1 token
 *
 * Per-model overrides live under `models`. Each model entry can also be
 * scoped by operation (default rates apply otherwise). Lookups cascade:
 *   1. models[modelName].operation
 *   2. models[modelName]
 *   3. defaults (per token type)
 */
const DEFAULT_CONFIG = {
  enabled: false,
  currency: 'USD',
  defaults: {
    inputToken: 0,
    outputToken: 0,
    cachedToken: 0,
    reasoningToken: 0,
    image: 0,
    imagePerSquareInch: 0,
    audio: 0,
    audioPerSecond: 0,
    embedding: 0,
    embeddingPerToken: 0,
  },
  models: {},
};

/**
 * Validate a pricing config object. Returns { valid, errors }.
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePricingConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['pricing config must be an object'] };
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    errors.push('pricing.enabled must be boolean');
  }
  if (config.currency !== undefined && typeof config.currency !== 'string') {
    errors.push('pricing.currency must be a string');
  }
  if (config.defaults !== undefined && (typeof config.defaults !== 'object' || config.defaults === null)) {
    errors.push('pricing.defaults must be an object');
  }
  if (config.models !== undefined) {
    if (typeof config.models !== 'object' || config.models === null || Array.isArray(config.models)) {
      errors.push('pricing.models must be an object keyed by model id');
    } else {
      for (const [modelId, m] of Object.entries(config.models)) {
        if (!modelId || typeof modelId !== 'string') {
          errors.push(`pricing.models: invalid model id "${modelId}"`);
          continue;
        }
        if (typeof m !== 'object' || m === null) {
          errors.push(`pricing.models.${modelId}: must be an object`);
          continue;
        }
        const numericFields = ['inputToken', 'outputToken', 'cachedToken', 'reasoningToken', 'image', 'audio', 'embedding'];
        for (const f of numericFields) {
          if (m[f] !== undefined && (typeof m[f] !== 'number' || m[f] < 0 || !Number.isFinite(m[f]))) {
            errors.push(`pricing.models.${modelId}.${f}: must be a non-negative finite number`);
          }
        }
        if (m.operations !== undefined) {
          if (typeof m.operations !== 'object' || m.operations === null || Array.isArray(m.operations)) {
            errors.push(`pricing.models.${modelId}.operations: must be an object keyed by operation name`);
          } else {
            for (const [opName, op] of Object.entries(m.operations)) {
              if (typeof op !== 'object' || op === null) {
                errors.push(`pricing.models.${modelId}.operations.${opName}: must be an object`);
                continue;
              }
              for (const f of numericFields) {
                if (op[f] !== undefined && (typeof op[f] !== 'number' || op[f] < 0 || !Number.isFinite(op[f]))) {
                  errors.push(`pricing.models.${modelId}.operations.${opName}.${f}: must be a non-negative finite number`);
                }
              }
            }
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Deep-merge two plain objects (target into source). Arrays shallow.
 */
function deepMerge(target, source) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Load pricing config from config/pricing.json (override via `file`).
 * Returns DEFAULT_CONFIG merged with the file contents when present.
 *
 * @param {string} [file]
 * @returns {object}
 */
function loadPricingConfig(file) {
  const fileArg = file || process.env.PRICING_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  let config = deepMerge(DEFAULT_CONFIG, {});
  if (fs.existsSync(fileArg)) {
    try {
      const raw = fs.readFileSync(fileArg, 'utf8');
      const parsed = JSON.parse(raw);
      config = deepMerge(config, parsed);
    } catch (err) {
      // Silent on missing/invalid — keeps the gateway running with defaults.
    }
  }
  // Env overrides
  if (process.env.PRICING_ENABLED === 'true') config.enabled = true;
  else if (process.env.PRICING_ENABLED === 'false') config.enabled = false;
  if (process.env.PRICING_CURRENCY) config.currency = process.env.PRICING_CURRENCY;
  return config;
}

/**
 * Atomically save the pricing config (validate-then-write).
 * @param {object} config
 * @param {string} [file]
 * @returns {{ ok: boolean, errors?: string[] }}
 */
function savePricingConfig(config, file) {
  const fileArg = file || process.env.PRICING_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  const { valid, errors } = validatePricingConfig(config);
  if (!valid) return { ok: false, errors };
  const dir = path.dirname(fileArg);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fileArg}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, fileArg);
  return { ok: true };
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_FILE,
  loadPricingConfig,
  savePricingConfig,
  validatePricingConfig,
};
