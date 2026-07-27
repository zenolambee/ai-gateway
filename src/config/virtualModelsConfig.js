const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(process.cwd(), 'config', 'virtualModels.json');

/**
 * Default virtual models configuration.
 *
 * A virtual model is a higher-level alias that maps a single client-facing
 * model id (e.g. "coding-fast") to one or more { provider, model } candidate
 * tuples. The gateway selects one candidate, falling over to the next if the
 * selected provider cannot serve the request.
 *
 * File shape (config/virtualModels.json):
 *   {
 *     "virtualModels": {
 *       "coding-fast": {
 *         "enabled": true,
 *         "strategy": "priority",
 *         "candidates": [
 *           { "provider": "providerA", "model": "glm-5.2", "priority": 1, "weight": 1 },
 *           { "provider": "providerB", "model": "deepseek-v3", "priority": 2, "weight": 1 },
 *           { "provider": "providerC", "model": "qwen-coder", "priority": 3, "weight": 1 }
 *         ]
 *       },
 *       "reasoning": {
 *         "enabled": true,
 *         "strategy": "highest-success-rate",
 *         "candidates": [ ... ]
 *       }
 *     }
 *   }
 *
 * Candidate fields:
 *   - provider     : string (required) — provider id in config/providers/*.json
 *   - model        : string (required) — the real model id the provider serves
 *   - priority     : number (optional, default 100) — lower = higher priority
 *   - weight       : number (optional, default 1) — for weighted strategy
 *   - enabled      : boolean (optional, default true) — toggle a single candidate
 *
 * Virtual model fields:
 *   - enabled      : boolean (optional, default true)
 *   - strategy     : string (optional) — one of the supported SELECTION_STRATEGIES
 *   - candidates   : array (required, non-empty)
 *
 * The default strategy is "priority" (preserves a deterministic order via the
 * candidate `priority` field). When the file is absent or empty, the gateway
 * runs with no virtual models — clients using real model ids are unaffected.
 */
const DEFAULT_CONFIG = { virtualModels: {} };

/**
 * Selection strategies supported for virtual models. Mirrors the routing
 * strategies in routingStrategy.js plus two virtual-model-only strategies:
 *   - lowest-cost: not yet backed by real cost data; behaves like priority
 *   - highest-success-rate: orders by provider successRate (desc)
 */
const SELECTION_STRATEGIES = [
  'priority',
  'round-robin',
  'lowest-latency',
  'least-used',
  'lowest-cost',
  'highest-success-rate',
  'weighted',
  'random',
];

/**
 * Validate a virtual models config object. Returns
 *   { valid: boolean, errors: string[], warnings: string[], config: object }
 *
 * The returned `config` is the normalized config (defaults applied, invalid
 * entries dropped). When `valid === false`, `errors` lists fatal problems
 * (the caller should reject the reload). Warnings are informational.
 *
 * @param {object} raw - raw parsed JSON
 * @returns {{ valid: boolean, errors: string[], warnings: string[], config: object }}
 */
function validateVirtualModelsConfig(raw) {
  const errors = [];
  const warnings = [];
  const config = { virtualModels: {} };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('Config root must be an object with a "virtualModels" property');
    return { valid: false, errors, warnings, config };
  }

  const vms = raw.virtualModels;
  if (vms === undefined || vms === null) {
    // No virtualModels key — treat as empty (valid).
    return { valid: true, errors, warnings, config };
  }
  if (typeof vms !== 'object' || Array.isArray(vms)) {
    errors.push('"virtualModels" must be an object keyed by virtual model id');
    return { valid: false, errors, warnings, config };
  }

  const seenIds = new Set();
  for (const [id, def] of Object.entries(vms)) {
    if (!id || typeof id !== 'string') {
      errors.push('Virtual model id must be a non-empty string');
      continue;
    }
    if (seenIds.has(id)) {
      errors.push(`Duplicate virtual model id "${id}"`);
      continue;
    }
    seenIds.add(id);

    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      errors.push(`Virtual model "${id}" must be an object`);
      continue;
    }

    // enabled
    let enabled = true;
    if (def.enabled !== undefined) {
      if (typeof def.enabled !== 'boolean') {
        errors.push(`Virtual model "${id}".enabled must be a boolean`);
        continue;
      }
      enabled = def.enabled;
    }

    // strategy
    let strategy = 'priority';
    if (def.strategy !== undefined && def.strategy !== null) {
      if (typeof def.strategy !== 'string') {
        errors.push(`Virtual model "${id}".strategy must be a string`);
        continue;
      }
      if (!SELECTION_STRATEGIES.includes(def.strategy)) {
        errors.push(`Virtual model "${id}".strategy "${def.strategy}" is not supported (allowed: ${SELECTION_STRATEGIES.join(', ')})`);
        continue;
      }
      strategy = def.strategy;
    }

    // candidates (required, non-empty array)
    if (!Array.isArray(def.candidates)) {
      errors.push(`Virtual model "${id}".candidates must be an array`);
      continue;
    }
    if (def.candidates.length === 0) {
      errors.push(`Virtual model "${id}".candidates must contain at least one candidate`);
      continue;
    }

    const seenCandidateKeys = new Set();
    const candidates = [];
    for (let i = 0; i < def.candidates.length; i += 1) {
      const c = def.candidates[i];
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        errors.push(`Virtual model "${id}".candidates[${i}] must be an object`);
        continue;
      }
      if (!c.provider || typeof c.provider !== 'string') {
        errors.push(`Virtual model "${id}".candidates[${i}].provider is required and must be a string`);
        continue;
      }
      if (!c.model || typeof c.model !== 'string') {
        errors.push(`Virtual model "${id}".candidates[${i}].model is required and must be a string`);
        continue;
      }
      const key = `${c.provider}:${c.model}`;
      if (seenCandidateKeys.has(key)) {
        warnings.push(`Virtual model "${id}" has a duplicate candidate {provider:"${c.provider}", model:"${c.model}"} — keeping the first`);
        continue;
      }
      seenCandidateKeys.add(key);

      const priority = typeof c.priority === 'number' ? c.priority : 100;
      const weight = typeof c.weight === 'number' && c.weight > 0 ? c.weight : 1;
      const cEnabled = c.enabled !== undefined ? !!c.enabled : true;

      candidates.push({
        provider: c.provider,
        model: c.model,
        priority,
        weight,
        enabled: cEnabled,
      });
    }

    if (candidates.length === 0) {
      errors.push(`Virtual model "${id}" has no valid candidates`);
      continue;
    }

    config.virtualModels[id] = {
      enabled,
      strategy,
      candidates,
    };
  }

  return { valid: errors.length === 0, errors, warnings, config };
}

/**
 * Load virtual model definitions from config/virtualModels.json (or override).
 *
 * @param {string} [file] - override path to the virtual models config file
 * @returns {object} validated config: { virtualModels: { [id]: { enabled, strategy, candidates } } }
 *   When the file is missing or unparseable, returns the empty default and
 *   logs nothing (this is a normal "no virtual models configured" state).
 */
function loadVirtualModelsConfig(file) {
  const filePath = file || process.env.VIRTUAL_MODELS_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  if (!fs.existsSync(filePath)) {
    return { virtualModels: {} };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return { virtualModels: {} };
  }
  // Validate but do not throw on a missing file — the gateway still runs.
  const { config } = validateVirtualModelsConfig(raw);
  return config;
}

/**
 * Persist a virtual models config object to disk.
 *
 * Validates FIRST (before any file is touched) and refuses to write when
 * validation fails — this keeps the on-disk config consistent with the
 * loaded config so a hot reload never sees a broken file. The write is
 * atomic: the file is written to a temp path then renamed, so a crash mid
 * write cannot leave a half-written config.
 *
 * @param {object} raw - { virtualModels: { [id]: {...} } }
 * @param {string} [file] - override path to the virtual models config file
 * @returns {{ success: boolean, errors: string[], warnings: string[], config: object }}
 */
function saveVirtualModelsConfig(raw, file) {
  const filePath = file || process.env.VIRTUAL_MODELS_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  const { valid, errors, warnings, config } = validateVirtualModelsConfig(raw);
  if (!valid) {
    return { success: false, errors, warnings, config };
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({ virtualModels: config.virtualModels }, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return { success: true, errors: [], warnings, config };
}

module.exports = {
  loadVirtualModelsConfig,
  saveVirtualModelsConfig,
  validateVirtualModelsConfig,
  SELECTION_STRATEGIES,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_FILE,
};
