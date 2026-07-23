/**
 * KeySelectionStrategy
 *
 * Pluggable strategy for selecting the next API key for a provider from a
 * pool of key records. Each strategy is a pure function over the candidate
 * list + a mutable cursor object — the ApiKeyManager owns the cursor and
 * passes it in so that round-robin / least-used state survives across calls.
 *
 * Strategies are intentionally simple, deterministic, and side-effect-free
 * (they do not mutate the records themselves; the ApiKeyManager does that).
 * The strategy only returns the index of the selected record, or -1 when
 * no candidate is selectable.
 *
 * Built-in strategies:
 *   - priority     : use the key's `priority` (lower = higher priority); ties
 *                    broken by insertion order (stable).
 *   - round-robin  : cycle through candidates in order using a cursor.
 *   - random       : uniform random pick.
 *   - least-used   : pick the candidate with the lowest `stats.totalRequests`.
 *   - weighted     : pick a candidate with probability proportional to `weight`.
 *
 * The strategy is configurable per provider via the provider config field
 * `keySelectionStrategy` (string), defaulting to `round-robin` to preserve
 * the existing behaviour of the gateway.
 */

/**
 * Strategy registry: id -> (candidates, cursor, opts) -> index.
 */
const STRATEGIES = new Map();

/**
 * Register a custom selection strategy.
 * @param {string} id
 * @param {Function} fn - (candidates, cursor, opts) -> index | -1
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
  const fn = STRATEGIES.get(id || 'round-robin');
  if (!fn) throw new Error(`Unknown key selection strategy: "${id}"`);
  return fn;
}

/**
 * Return the list of registered strategy ids (for admin UI / docs).
 * @returns {string[]}
 */
function listStrategies() {
  return [...STRATEGIES.keys()];
}

/* ---------------------------------------------------------------
 * Built-in strategies
 * --------------------------------------------------------------- */

/**
 * Priority strategy: select the candidate with the lowest `priority` value.
 * Ties are broken by insertion order (stable sort).
 *
 * @param {Array<object>} candidates - ACTIVE key records
 * @param {object} cursor - mutable cursor (unused)
 * @returns {number} index, or -1 when no candidates
 */
function priorityStrategy(candidates, cursor) {
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return 0;
  let bestIdx = 0;
  let bestPrio = typeof candidates[0].priority === 'number' ? candidates[0].priority : Infinity;
  for (let i = 1; i < candidates.length; i += 1) {
    const p = typeof candidates[i].priority === 'number' ? candidates[i].priority : Infinity;
    if (p < bestPrio) {
      bestPrio = p;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Round-robin strategy: advance a cursor through the candidate list.
 *
 * The cursor stores the last absolute index used. We map it to the
 * candidate list by finding the next ACTIVE candidate after the cursor.
 * This is the default strategy (preserves the gateway's historical
 * behaviour).
 *
 * @param {Array<object>} candidates
 * @param {object} cursor - { lastIdx: number }
 * @returns {number}
 */
function roundRobinStrategy(candidates, cursor) {
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return 0;
  const last = typeof cursor.lastIdx === 'number' ? cursor.lastIdx : -1;
  // Find the position of the candidate after `last`. Since candidates is
  // already filtered to ACTIVE keys, we just advance by 1 with wrap.
  // We search by the key's `value` so the cursor stays valid even if the
  // underlying array order changes between calls (e.g. after a reload).
  const lastValue = cursor.lastValue;
  let startIdx = 0;
  if (lastValue) {
    const found = candidates.findIndex((c) => c.value === lastValue);
    if (found !== -1) startIdx = (found + 1) % candidates.length;
  }
  // First time or last value gone: start from 0.
  return startIdx;
}

/**
 * Random strategy: uniform random pick.
 *
 * @param {Array<object>} candidates
 * @param {object} cursor
 * @param {object} [opts] - { rng: Function } for testing
 * @returns {number}
 */
function randomStrategy(candidates, cursor, opts = {}) {
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return 0;
  const rng = opts.rng || Math.random;
  return Math.floor(rng() * candidates.length);
}

/**
 * Least-used strategy: pick the candidate with the lowest `stats.totalRequests`.
 * Ties broken by insertion order. Useful for spreading load evenly across keys
 * regardless of their declared priority.
 *
 * @param {Array<object>} candidates
 * @returns {number}
 */
function leastUsedStrategy(candidates) {
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return 0;
  let bestIdx = 0;
  let best = candidates[0].stats.totalRequests || 0;
  for (let i = 1; i < candidates.length; i += 1) {
    const u = candidates[i].stats.totalRequests || 0;
    if (u < best) {
      best = u;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Weighted strategy: pick a candidate with probability proportional to its
 * `weight` (default 1). Higher weight = more likely to be selected. This is
 * a weighted random draw, not a strict rotation.
 *
 * @param {Array<object>} candidates
 * @param {object} cursor
 * @param {object} [opts] - { rng: Function }
 * @returns {number}
 */
function weightedStrategy(candidates, cursor, opts = {}) {
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return 0;
  const weights = candidates.map((c) => (typeof c.weight === 'number' && c.weight > 0 ? c.weight : 1));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return 0;
  const rng = opts.rng || Math.random;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i += 1) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

// Register built-ins
register('priority', priorityStrategy);
register('round-robin', roundRobinStrategy);
register('random', randomStrategy);
register('least-used', leastUsedStrategy);
register('weighted', weightedStrategy);

module.exports = {
  register,
  getStrategy,
  listStrategies,
  priorityStrategy,
  roundRobinStrategy,
  randomStrategy,
  leastUsedStrategy,
  weightedStrategy,
};
