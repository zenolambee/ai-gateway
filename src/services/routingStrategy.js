/**
 * RoutingStrategy
 *
 * Pluggable strategy for ordering the candidate providers that support a
 * given model. The ModelRouter calls the strategy to sort candidates before
 * the RequestExecutor iterates them with retry/fallback.
 *
 * The strategy is a pure function over the candidate list (and optional
 * per-provider health + usage stats) that returns a NEW sorted array. It
 * does not mutate the input.
 *
 * Built-in strategies:
 *   - priority          : lowest `priority` value first (the historical
 *                        default; preserves backward compatibility).
 *   - fastest-response  : lowest average response latency first.
 *   - lowest-latency    : alias of fastest-response (lowest p50 latency).
 *   - round-robin       : rotate the start of the candidate list per model.
 *   - least-used        : lowest recent request count first.
 *   - weighted          : weighted random ordering (higher weight = more
 *                        likely to appear first).
 *   - random           : uniform random shuffle.
 *
 * Health-aware strategies (fastest-response, lowest-latency, least-used)
 * read from the `health` map (providerId -> { averageLatencyMs, totalSuccess,
 * totalFailure, totalRequests, ... }) provided by the ProviderHealthMonitor.
 * When no health data is available, they fall back to `priority` order.
 *
 * The default is `priority` to preserve the existing gateway behaviour.
 */

const logger = require('../utils/logger');

/**
 * Strategy registry: id -> (candidates, ctx) -> newSortedArray.
 */
const STRATEGIES = new Map();

/**
 * Register a custom routing strategy.
 * @param {string} id
 * @param {Function} fn - (candidates, ctx) => sortedCandidates
 */
function register(id, fn) {
  if (typeof id !== 'string' || !id) throw new Error('Strategy id is required');
  if (typeof fn !== 'function') throw new Error('Strategy must be a function');
  STRATEGIES.set(id, fn);
}

/**
 * Resolve a strategy id to its function. Throws for unknown strategies.
 * @param {string} id
 * @returns {Function}
 */
function getStrategy(id) {
  const fn = STRATEGIES.get(id || 'priority');
  if (!fn) throw new Error(`Unknown routing strategy: "${id}"`);
  return fn;
}

/**
 * Return the list of registered strategy ids.
 * @returns {string[]}
 */
function listStrategies() {
  return [...STRATEGIES.keys()];
}

/**
 * Apply a routing strategy to a candidate list.
 *
 * @param {string} strategyId
 * @param {Array<object>} candidates - provider configs supporting the model
 * @param {object} [ctx]
 * @param {object} [ctx.health] - providerId -> health snapshot
 * @param {object} [ctx.usage] - providerId -> usage stats
 * @param {object} [ctx.cursors] - model -> { lastIdx } for round-robin
 * @param {string} [ctx.model] - the requested model id
 * @returns {Array<object>} new sorted array (input unchanged)
 */
function applyStrategy(strategyId, candidates, ctx = {}) {
  if (!Array.isArray(candidates) || candidates.length <= 1) {
    return candidates ? [...candidates] : [];
  }
  let fn;
  try {
    fn = getStrategy(strategyId);
  } catch (err) {
    logger.warn('Routing strategy unknown, falling back to priority order', {
      strategy: strategyId, error: err && err.message,
    });
    return priorityStrategy([...candidates], ctx);
  }
  try {
    const out = fn([...candidates], ctx);
    return Array.isArray(out) ? out : [...candidates];
  } catch (err) {
    logger.warn('Routing strategy failed, falling back to priority order', {
      strategy: strategyId, error: err && err.message,
    });
    return priorityStrategy([...candidates], ctx);
  }
}

/* ---------------------------------------------------------------
 * Built-in strategies
 * --------------------------------------------------------------- */

/**
 * Priority strategy: lowest `priority` value first. Stable on ties.
 * This is the default and preserves the historical behaviour.
 */
function priorityStrategy(candidates) {
  return candidates.sort((a, b) => {
    const pa = typeof a.priority === 'number' ? a.priority : 100;
    const pb = typeof b.priority === 'number' ? b.priority : 100;
    if (pa !== pb) return pa - pb;
    // stable tie-break by id (deterministic)
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Fastest response: lowest average latency first. Falls back to priority
 * when no health data is available for any candidate.
 */
function fastestResponseStrategy(candidates, ctx = {}) {
  const health = ctx.health || {};
  const withLatency = candidates.filter((p) => {
    const h = health[p.id];
    return h && typeof h.averageLatencyMs === 'number' && h.averageLatencyMs > 0;
  });
  if (withLatency.length === 0) return priorityStrategy(candidates);
  return candidates.sort((a, b) => {
    const la = (health[a.id] && health[a.id].averageLatencyMs) || 0;
    const lb = (health[b.id] && health[b.id].averageLatencyMs) || 0;
    if (la !== lb) return la - lb;
    // tie-break by priority
    const pa = typeof a.priority === 'number' ? a.priority : 100;
    const pb = typeof b.priority === 'number' ? b.priority : 100;
    return pa - pb;
  });
}

/**
 * Lowest latency: alias of fastest-response using p50 when available,
 * otherwise averageLatencyMs. Falls back to priority.
 */
function lowestLatencyStrategy(candidates, ctx = {}) {
  const health = ctx.health || {};
  const hasP50 = candidates.some((p) => {
    const h = health[p.id];
    return h && typeof h.p50LatencyMs === 'number';
  });
  if (!hasP50) return fastestResponseStrategy(candidates, ctx);
  return candidates.sort((a, b) => {
    const la = (health[a.id] && health[a.id].p50LatencyMs) || Infinity;
    const lb = (health[b.id] && health[b.id].p50LatencyMs) || Infinity;
    if (la !== lb) return la - lb;
    const pa = typeof a.priority === 'number' ? a.priority : 100;
    const pb = typeof b.priority === 'number' ? b.priority : 100;
    return pa - pb;
  });
}

/**
 * Round-robin: rotate the start of the candidate list per model. Uses
 * `ctx.cursors[model].lastIdx` to remember the rotation offset.
 */
function roundRobinStrategy(candidates, ctx = {}) {
  if (candidates.length <= 1) return [...candidates];
  const model = ctx.model || '__default__';
  const cursors = ctx.cursors || {};
  const c = cursors[model] || { lastIdx: 0 };
  const start = ((c.lastIdx % candidates.length) + candidates.length) % candidates.length;
  // advance cursor for next call
  c.lastIdx = (start + 1) % candidates.length;
  cursors[model] = c;
  // Rotate the list: stable priority order first, then rotate by `start`.
  const sorted = priorityStrategy([...candidates]);
  return sorted.slice(start).concat(sorted.slice(0, start));
}

/**
 * Least-used: lowest total request count first. Falls back to priority
 * when no usage data is available.
 */
function leastUsedStrategy(candidates, ctx = {}) {
  const health = ctx.health || {};
  const hasUsage = candidates.some((p) => {
    const h = health[p.id];
    return h && typeof h.totalRequests === 'number';
  });
  if (!hasUsage) return priorityStrategy(candidates);
  return candidates.sort((a, b) => {
    const ua = (health[a.id] && health[a.id].totalRequests) || 0;
    const ub = (health[b.id] && health[b.id].totalRequests) || 0;
    if (ua !== ub) return ua - ub;
    const pa = typeof a.priority === 'number' ? a.priority : 100;
    const pb = typeof b.priority === 'number' ? b.priority : 100;
    return pa - pb;
  });
}

/**
 * Weighted: weighted random ordering. Higher `weight` = more likely to
 * appear near the front. This produces a full permutation so the
 * RequestExecutor's fallback chain still has a deterministic order per
 * request.
 */
function weightedStrategy(candidates, ctx = {}) {
  if (candidates.length <= 1) return [...candidates];
  const rng = (ctx.opts && ctx.opts.rng) || Math.random;
  const remaining = [...candidates];
  const out = [];
  while (remaining.length > 0) {
    const weights = remaining.map((p) => (typeof p.weight === 'number' && p.weight > 0 ? p.weight : 1));
    const total = weights.reduce((s, w) => s + w, 0);
    let r = rng() * total;
    let picked = 0;
    for (let i = 0; i < weights.length; i += 1) {
      r -= weights[i];
      if (r < 0) { picked = i; break; }
    }
    out.push(remaining.splice(picked, 1)[0]);
  }
  return out;
}

/**
 * Random: uniform shuffle. Uses Fisher-Yates with the provided RNG.
 */
function randomStrategy(candidates, ctx = {}) {
  if (candidates.length <= 1) return [...candidates];
  const rng = (ctx.opts && ctx.opts.rng) || Math.random;
  const out = [...candidates];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Register built-ins
register('priority', priorityStrategy);
register('fastest-response', fastestResponseStrategy);
register('lowest-latency', lowestLatencyStrategy);
register('round-robin', roundRobinStrategy);
register('least-used', leastUsedStrategy);
register('weighted', weightedStrategy);
register('random', randomStrategy);

module.exports = {
  register,
  getStrategy,
  listStrategies,
  applyStrategy,
  priorityStrategy,
  fastestResponseStrategy,
  lowestLatencyStrategy,
  roundRobinStrategy,
  leastUsedStrategy,
  weightedStrategy,
  randomStrategy,
};
