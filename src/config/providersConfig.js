const fs = require('fs');
const path = require('path');

const DEFAULT_PROVIDERS_DIR = path.join(process.cwd(), 'config', 'providers');

const REQUIRED_FIELDS = ['id', 'name', 'baseURL', 'supportedModels'];

/**
 * Expand `${VAR}` placeholders inside a string using process.env.
 * @param {string} value
 * @returns {string}
 */
function expandEnvVars(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    return process.env[varName] !== undefined ? process.env[varName] : match;
  });
}

/**
 * Recursively expand env-var placeholders in any config value.
 * @param {*} value
 * @returns {*}
 */
function deepExpand(value) {
  if (typeof value === 'string') return expandEnvVars(value);
  if (Array.isArray(value)) return value.map(deepExpand);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, deepExpand(v)])
    );
  }
  return value;
}

/**
 * Read and parse a single provider JSON file.
 * @param {string} filePath
 * @returns {object} raw provider config
 */
function loadProviderFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Load all provider configurations from the providers config directory.
 *
 * Each `.json` file in the directory represents one provider. Env-var
 * placeholders of the form `${VAR_NAME}` inside string values are expanded
 * using the current process environment.
 *
 * @param {string} [dir] - Override directory (defaults to PROVIDERS_CONFIG_DIR env or config/providers)
 * @returns {Array<object>} array of raw provider config objects
 */
function loadProviders(dir) {
  const providersDir = dir || process.env.PROVIDERS_CONFIG_DIR || DEFAULT_PROVIDERS_DIR;

  if (!fs.existsSync(providersDir)) {
    return [];
  }

  const files = fs
    .readdirSync(providersDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const providers = [];
  for (const file of files) {
    const filePath = path.join(providersDir, file);
    try {
      const raw = loadProviderFile(filePath);
      providers.push(deepExpand(raw));
    } catch (err) {
      // surfaced by ProviderManager validation/logging; keep loading others
      providers.push({
        __invalid: true,
        __source: file,
        __error: err.message,
      });
    }
  }

  return providers;
}

module.exports = {
  loadProviders,
  REQUIRED_FIELDS,
  DEFAULT_PROVIDERS_DIR,
  validateProviderConfigs,
  validateProvider,
};

/**
 * Validate a full set of provider configs, including cross-provider checks.
 *
 * Checks:
 *   - Per-provider field validation (via validateProvider)
 *   - Duplicated provider ids
 *   - Duplicated priorities (warn-level — not an error)
 *   - Invalid baseURL (must be a valid http/https URL)
 *   - Missing API keys for enabled providers
 *   - Duplicated model ids within the same provider
 *
 * @param {Array<object>} providers - raw provider configs (post-env-expand)
 * @returns {{ valid: boolean, errors: string[], warnings: string[], providers: Array<object> }}
 *   The `providers` array contains only the valid providers (invalid ones
 *   are dropped). `errors` are fatal; `warnings` are informational.
 */
function validateProviderConfigs(providers) {
  const errors = [];
  const warnings = [];
  const valid = [];
  const seenIds = new Set();
  const seenPriorities = new Map(); // priority -> [providerId]

  if (!Array.isArray(providers)) {
    return { valid: false, errors: ['Provider configs must be an array'], warnings, providers: [] };
  }

  for (const raw of providers) {
    if (raw && raw.__invalid) {
      errors.push(`Provider config "${raw.__source || 'unknown'}" failed to parse: ${raw.__error}`);
      continue;
    }

    // Per-provider validation
    const { valid: isValid, errors: providerErrors } = validateProvider(raw);
    if (!isValid) {
      errors.push(`Provider "${raw && raw.id || 'unknown'}": ${providerErrors.join('; ')}`);
      continue;
    }

    // Duplicated ids
    if (seenIds.has(raw.id)) {
      errors.push(`Duplicate provider id "${raw.id}"`);
      continue;
    }
    seenIds.add(raw.id);

    // Duplicated priorities (warning, not fatal)
    if (raw.priority !== undefined && typeof raw.priority === 'number') {
      if (seenPriorities.has(raw.priority)) {
        warnings.push(`Providers "${seenPriorities.get(raw.priority)}" and "${raw.id}" share priority ${raw.priority} — order between them is undefined`);
      } else {
        seenPriorities.set(raw.priority, raw.id);
      }
    }

    // URL validation
    if (raw.baseURL) {
      try {
        const url = new URL(raw.baseURL);
        if (!['http:', 'https:'].includes(url.protocol)) {
          errors.push(`Provider "${raw.id}": baseURL must use http or https protocol`);
          continue;
        }
      } catch {
        errors.push(`Provider "${raw.id}": invalid baseURL "${raw.baseURL}"`);
        continue;
      }
    }

    // Missing API keys for enabled providers (warning — the provider will
    // fail at runtime with NO_API_KEYS, but it's useful to surface early)
    if (raw.enabled !== false) {
      if (!Array.isArray(raw.apiKeys) || raw.apiKeys.length === 0 || raw.apiKeys.every((k) => !k)) {
        warnings.push(`Provider "${raw.id}" is enabled but has no API keys configured`);
      }
    }

    // Duplicated model ids within the same provider
    if (Array.isArray(raw.supportedModels)) {
      const modelSeen = new Set();
      for (const model of raw.supportedModels) {
        if (modelSeen.has(model)) {
          errors.push(`Provider "${raw.id}": duplicate model "${model}" in supportedModels`);
          continue;
        }
        modelSeen.add(model);
      }
    }

    valid.push(raw);
  }

  return { valid: errors.length === 0, errors, warnings, providers: valid };
}

/**
 * Validate a single provider config object.
 *
 * @param {object} provider - raw provider config
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateProvider(provider) {
  const errors = [];

  if (!provider || typeof provider !== 'object') {
    return { valid: false, errors: ['provider config must be an object'] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (provider[field] === undefined || provider[field] === null || provider[field] === '') {
      errors.push(`missing or empty required field "${field}"`);
    }
  }

  if (provider.id !== undefined && typeof provider.id !== 'string') {
    errors.push('"id" must be a string');
  }

  if (provider.name !== undefined && typeof provider.name !== 'string') {
    errors.push('"name" must be a string');
  }

  if (provider.enabled !== undefined && typeof provider.enabled !== 'boolean') {
    errors.push('"enabled" must be a boolean');
  }

  if (provider.baseURL !== undefined && typeof provider.baseURL !== 'string') {
    errors.push('"baseURL" must be a string');
  }

  if (provider.apiKeys !== undefined) {
    if (!Array.isArray(provider.apiKeys)) {
      errors.push('"apiKeys" must be an array');
    } else {
      for (const k of provider.apiKeys) {
        if (typeof k === 'string') continue; // bare string form
        if (k && typeof k === 'object' && typeof k.value === 'string' && k.value) {
          if (k.priority !== undefined && (typeof k.priority !== 'number' || !Number.isFinite(k.priority))) {
            errors.push('"apiKeys[].priority" must be a finite number');
          }
          if (k.weight !== undefined && (typeof k.weight !== 'number' || k.weight < 0 || !Number.isFinite(k.weight))) {
            errors.push('"apiKeys[].weight" must be a non-negative finite number');
          }
          continue;
        }
        errors.push('"apiKeys" entries must be strings or { value: string, priority?: number, weight?: number }');
        break;
      }
    }
  }

  if (provider.supportedModels !== undefined) {
    if (!Array.isArray(provider.supportedModels)) {
      errors.push('"supportedModels" must be an array');
    } else if (!provider.supportedModels.every((m) => typeof m === 'string')) {
      errors.push('"supportedModels" must be an array of strings');
    }
  }

  if (provider.priority !== undefined && typeof provider.priority !== 'number') {
    errors.push('"priority" must be a number');
  }

  if (provider.timeout !== undefined) {
    if (typeof provider.timeout !== 'number' || provider.timeout <= 0) {
      errors.push('"timeout" must be a positive number');
    }
  }

  // Weight validation (if present)
  if (provider.weight !== undefined) {
    if (typeof provider.weight !== 'number' || provider.weight < 0) {
      errors.push('"weight" must be a non-negative number');
    }
  }

  // Key selection strategy validation (if present). The strategy is
  // resolved at runtime by the ApiKeyManager; here we only check it is a
  // non-empty string. Unknown values are accepted (the manager falls back
  // to round-robin with a warning) so custom strategies can be registered.
  if (provider.keySelectionStrategy !== undefined && provider.keySelectionStrategy !== null) {
    if (typeof provider.keySelectionStrategy !== 'string' || provider.keySelectionStrategy.trim() === '') {
      errors.push('"keySelectionStrategy" must be a non-empty string');
    }
  }

  // Cooldown policy validation (if present). Cooldown durations are in ms
  // per error category; 0 means "permanent disable" for that category.
  if (provider.cooldownPolicy !== undefined && provider.cooldownPolicy !== null) {
    if (typeof provider.cooldownPolicy !== 'object' || Array.isArray(provider.cooldownPolicy)) {
      errors.push('"cooldownPolicy" must be an object');
    } else {
      const validCategories = ['RATE_LIMITED', 'SERVER_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'QUOTA_EXCEEDED', 'UNAUTHORIZED', 'UNKNOWN'];
      for (const [cat, ms] of Object.entries(provider.cooldownPolicy)) {
        if (!validCategories.includes(cat)) {
          errors.push(`"cooldownPolicy.${cat}" is not a known category (expected one of ${validCategories.join(', ')})`);
          continue;
        }
        if (typeof ms !== 'number' || ms < 0 || !Number.isFinite(ms)) {
          errors.push(`"cooldownPolicy.${cat}" must be a non-negative finite number (ms)`);
        }
      }
    }
  }

  // Cooldown failure threshold (if present)
  if (provider.cooldownFailureThreshold !== undefined && provider.cooldownFailureThreshold !== null) {
    if (typeof provider.cooldownFailureThreshold !== 'number' || provider.cooldownFailureThreshold < 0 || !Number.isFinite(provider.cooldownFailureThreshold)) {
      errors.push('"cooldownFailureThreshold" must be a non-negative finite number');
    }
  }

  // Retry policy validation (if present)
  if (provider.retryPolicy !== undefined) {
    if (typeof provider.retryPolicy !== 'object' || Array.isArray(provider.retryPolicy)) {
      errors.push('"retryPolicy" must be an object');
    } else {
      if (provider.retryPolicy.maxRetries !== undefined && (typeof provider.retryPolicy.maxRetries !== 'number' || provider.retryPolicy.maxRetries < 0)) {
        errors.push('"retryPolicy.maxRetries" must be a non-negative number');
      }
      if (provider.retryPolicy.backoffMs !== undefined && (typeof provider.retryPolicy.backoffMs !== 'number' || provider.retryPolicy.backoffMs < 0)) {
        errors.push('"retryPolicy.backoffMs" must be a non-negative number');
      }
    }
  }

  // Fallback policy validation (if present)
  if (provider.fallbackPolicy !== undefined) {
    if (typeof provider.fallbackPolicy !== 'boolean' && typeof provider.fallbackPolicy !== 'object') {
      errors.push('"fallbackPolicy" must be a boolean or object');
    }
  }

  return { valid: errors.length === 0, errors };
}
