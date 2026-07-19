const AppError = require('../utils/AppError');

/**
 * ModelRouter
 *
 * Responsible for selecting which provider should serve a given model.
 * It delegates provider lookup to the ProviderManager and applies routing
 * policies (priority ordering, enabled-only). Keeping this logic in a
 * dedicated service means the Chat Completions layer does not depend directly
 * on ProviderManager internals, and routing policy can evolve independently.
 */
class ModelRouter {
  /**
   * @param {object} providerManager - ProviderManager instance
   */
  constructor(providerManager) {
    if (!providerManager) {
      throw new Error('ModelRouter requires a ProviderManager instance');
    }
    this.providerManager = providerManager;
  }

  /**
   * Find the best enabled provider for a given model identifier.
   *
   * Routing policy:
   *   1. Only providers that are `enabled` are considered.
   *   2. Among enabled providers that support the model, the one with the
   *      lowest `priority` value wins (higher priority).
   *   3. If no provider supports the model, throws 404.
   *   4. If providers exist for the model but all are disabled, throws 503.
   *
   * @param {string} model - model identifier (e.g. "gpt-4o")
   * @returns {object} selected provider config
   */
  routeToProvider(model) {
    if (!model || typeof model !== 'string') {
      throw new AppError(
        "you must provide a model parameter",
        400,
        { code: 'INVALID_REQUEST' }
      );
    }

    return this.providerManager.getProviderByModel(model);
  }

  /**
   * Return all enabled providers that can serve the given model, ordered by
   * priority. Useful for future fallback / retry features.
   *
   * @param {string} model
   * @returns {Array<object>}
   */
  getCandidateProviders(model) {
    if (!model || typeof model !== 'string') {
      return [];
    }

    const enabled = this.providerManager.getEnabledProviders();
    return enabled
      .filter((p) => Array.isArray(p.supportedModels) && p.supportedModels.includes(model))
      .sort((a, b) => a.priority - b.priority);
  }
}

module.exports = ModelRouter;
