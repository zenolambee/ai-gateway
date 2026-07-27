/**
 * PricingService
 *
 * Maintains pricing tables for every model and computes the dollar cost of
 * a request from the response's token usage. It is the authoritative source
 * of cost data for the wider Cost Management / Budget / Analytics stack
 * (Sprint 12), but the service itself keeps no state and performs no HTTP
 * — it is a pure lookup + arithmetic engine that the executor calls after a
 * successful response.
 *
 * Prices look like:
 *
 *   {
 *     enabled: true,
 *     currency: 'USD',
 *     defaults: { inputToken: 0, outputToken: 0, cachedToken: 0,
 *                 reasoningToken: 0, image: 0, audio: 0, embedding: 0 },
 *     models: {
 *       'gpt-4o': { inputToken: 0.000005, outputToken: 0.000015, cachedToken: 0.0000012 },
 *       'image-1': { image: 0.04 },
 *       ...
 *     }
 *   }
 *
 * Per-operation overrides are supported (chat/embeddings/etc.) when present
 * in `models[id].operations.<op>`. Lookups cascade from most-specific
 * (model + operation) down to defaults.
 *
 * Cost calculation follows OpenAI's pricing model:
 *   - input (prompt) tokens × inputToken price
 *   - output (completion) tokens × outputToken price
 *   - cached tokens at the cachedToken rate (a discount)
 *   - reasoning tokens at reasoningToken rate (OpenAI o1/o3 style)
 *   - image generation: per-image flat + (optional) per-square-inch
 *   - audio: per-second rate (transcription/synthesis)
 *   - embeddings: per-token rate
 *
 * All returned costs are numbers (USD). When pricing is disabled the service
 * returns 0 for every request — preserving backward compatibility with
 * existing callers that expect a `cost` field.
 */
class PricingService {
  /**
   * @param {object} config - output of loadPricingConfig()
   */
  constructor(config = {}) {
    this.enabled = !!config.enabled;
    this.currency = config.currency || 'USD';
    this.defaults = config.defaults || {};
    this.models = config.models || {};
    this.config = config;
  }

  /**
   * Replace the pricing config (runtime / hot reload). No validation runs
   * here — the config loader typed it; trust-but-verify in tests/admin.
   * @param {object} config
   */
  load(config = {}) {
    this.enabled = !!config.enabled;
    this.currency = config.currency || 'USD';
    this.defaults = config.defaults || {};
    this.models = config.models || {};
    this.config = config;
  }

  /**
   * Look up the price of one token kind for a given (model, operation).
   * Cascade: models[id].operations[op].kind -> models[id].kind -> defaults.kind -> 0.
   * @param {string} modelId
   * @param {string} [operation]
   * @param {string} kind - one of inputToken|outputToken|cachedToken|reasoningToken|image|audio|embedding
   * @returns {number} price per unit (USD)
   */
  priceFor(modelId, operation, kind) {
    if (!this.enabled) return 0;
    const m = this.models[modelId];
    if (m) {
      if (operation && m.operations && m.operations[operation]) {
        const opPrice = m.operations[operation][kind];
        if (typeof opPrice === 'number') return opPrice;
      }
      if (typeof m[kind] === 'number') return m[kind];
    }
    if (this.defaults && typeof this.defaults[kind] === 'number') return this.defaults[kind];
    return 0;
  }

  /**
   * Compute the dollar cost of a successful request.
   *
   * @param {object} args
   * @param {string} args.model - model id from the response (resolved real model)
   * @param {string} [args.operation='chat'] - 'chat'|'responses'|'embeddings'|'images'|'audio'
   * @param {number} [args.promptTokens=0] - input tokens
   * @param {number} [args.completionTokens=0] - output tokens
   * @param {number} [args.cachedTokens=0] - prompt tokens served from cache
   * @param {number} [args.reasoningTokens=0] - reasoning tokens (OpenAI o-series)
   * @param {number} [args.images=0] - number of images generated
   * @param {number} [args.audioSeconds=0] - seconds of audio transcribed/synthesized
   * @param {number} [args.embeddingTokens=0] - tokens embedded
   * @returns {number} cost in USD (0 when pricing disabled)
   */
  calculateCost(args = {}) {
    if (!this.enabled) return 0;
    const model = args.model;
    const op = args.operation || 'chat';
    let cost = 0;
    const pt = args.promptTokens || 0;
    const ct = args.completionTokens || 0;
    const ctd = args.cachedTokens || 0;
    const rt = args.reasoningTokens || 0;
    // Input tokens are billed at the input rate, EXCEPT the cached subset
    // which is billed at the (cheaper) cached rate. Subtract cached from
    // prompt before applying the input rate to avoid double-charging.
    const billableInput = Math.max(0, pt - ctd);
    if (billableInput > 0) cost += billableInput * this.priceFor(model, op, 'inputToken');
    if (ct > 0) cost += ct * this.priceFor(model, op, 'outputToken');
    if (ctd > 0) cost += ctd * this.priceFor(model, op, 'cachedToken');
    if (rt > 0) cost += rt * this.priceFor(model, op, 'reasoningToken');
    if (args.images > 0) {
      cost += args.images * this.priceFor(model, op, 'image');
      if (args.imageSquareInches > 0) {
        cost += args.imageSquareInches * this.priceFor(model, op, 'imagePerSquareInch');
      }
    }
    if (args.audioSeconds > 0) {
      cost += args.audioSeconds * this.priceFor(model, op, 'audioPerSecond');
      if (this.priceFor(model, op, 'audioPerSecond') === 0) {
        cost += args.audioSeconds * this.priceFor(model, op, 'audio');
      }
    }
    if (args.embeddingTokens > 0) {
      cost += args.embeddingTokens * this.priceFor(model, op, 'embeddingPerToken');
      if (this.priceFor(model, op, 'embeddingPerToken') === 0) {
        cost += args.embeddingTokens * this.priceFor(model, op, 'embedding');
      }
    }
    // Round to 6 decimal places to avoid floating-point stacking in sums.
    return Math.round(cost * 1e6) / 1e6;
  }

  /**
   * Return the price card for a model in a friendly dashboard shape.
   * @param {string} modelId
   * @returns {object|null}
   */
  getModelPricing(modelId) {
    if (!this.models[modelId]) {
      return this.defaults && Object.keys(this.defaults).length > 0
        ? { model: modelId, ...this.defaults, default: true }
        : null;
    }
    const m = this.models[modelId];
    return Object.assign({ model: modelId }, m);
  }

  /**
   * List every per-model pricing card (admin / pricing page).
   * @returns {Array<object>}
   */
  listModelPricing() {
    return Object.entries(this.models).map(([id, m]) => ({ model: id, ...m }));
  }

  /**
   * Get a snapshot of the pricing configuration for monitoring.
   * @returns {object}
   */
  getSnapshot() {
    return {
      enabled: this.enabled,
      currency: this.currency,
      modelCount: Object.keys(this.models).length,
      hasDefaults: !!this.defaults && Object.keys(this.defaults).length > 0,
    };
  }
}

module.exports = PricingService;
