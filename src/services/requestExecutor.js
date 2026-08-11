const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const StreamParser = require('./streamParser');
const StreamingResponseAdapter = require('./streamingResponseAdapter');
const { errorCodeToCategory } = require('./apiKeyManager');

/**
 * Map a gateway/provider error to a stable analytics status category. Reuses
 * the existing apiKeyManager taxonomy (no second taxonomy) and adds the
 * gateway-level codes that never reach the provider (quota, auth, validation).
 * @param {Error} err
 * @returns {string} one of: authentication_error | rate_limited |
 *   quota_exceeded | timeout | upstream_error | error
 */
function analyticsErrorCategory(err) {
  const code = (err && err.info && err.info.code) || null;
  if (!code) return 'error';
  switch (code) {
    case 'QUOTA_EXCEEDED':
    case 'BUDGET_EXCEEDED':
      return 'quota_exceeded';
    case 'RATE_LIMIT_EXCEEDED':
    case 'PROVIDER_RATE_LIMITED':
      return 'rate_limited';
    case 'MISSING_API_KEY':
    case 'INVALID_API_KEY':
    case 'DISABLED_API_KEY':
    case 'REVOKED_API_KEY':
    case 'EXPIRED_API_KEY':
    case 'PROVIDER_UNAUTHORIZED':
    case 'PROVIDER_FORBIDDEN':
    case 'PROVIDER_FORBIDDEN_KEY':
      return 'authentication_error';
    default:
      break;
  }
  // Fall back to the shared provider taxonomy.
  const cat = errorCodeToCategory(code);
  if (cat === 'TIMEOUT') return 'timeout';
  if (cat === 'RATE_LIMITED') return 'rate_limited';
  if (cat === 'UNAUTHORIZED') return 'authentication_error';
  if (cat === 'SERVER_ERROR' || cat === 'NETWORK_ERROR') return 'upstream_error';
  return 'error';
}

/**
 * Default retry policy.
 *
 * A request is retried when the (normalized) error is "retryable": transient
 * failures such as timeouts, 5xx, rate-limits, and network issues. Auth and
 * validation errors are never retried — they require human action.
 */
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 200;

/**
 * Error codes that are eligible for retry.
 */
const RETRYABLE_CODES = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_SERVER_ERROR',
  'PROVIDER_BAD_GATEWAY',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_CONNECTION_REFUSED',
  'PROVIDER_DNS_ERROR',
  'PROVIDER_NETWORK_ERROR',
  'PROVIDER_INVALID_JSON',
  'PROVIDER_UNKNOWN_ERROR',
]);

/**
 * Error codes that should trigger a fallback to the next provider (in addition
 * to retryable codes). This also covers "no active API keys" since another
 * provider might have keys available.
 */
const FALLBACK_ELIGIBLE_CODES = new Set([
  ...RETRYABLE_CODES,
  'NO_API_KEYS',
  'ALL_KEYS_UNAVAILABLE',
]);

function isRetryable(err) {
  const code = err && err.info && err.info.code;
  return !!code && RETRYABLE_CODES.has(code);
}

function isFallbackEligible(err) {
  const code = err && err.info && err.info.code;
  return !!code && FALLBACK_ELIGIBLE_CODES.has(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * RequestExecutor
 *
 * A reusable execution layer that sits between a "service" (Chat Completions,
 * Responses, ...) and the HttpClient. It owns the retry + fallback policy so
 * that every endpoint gets the same resilience behaviour without duplicating
 * the orchestration code.
 *
 * The executor is endpoint-agnostic: callers pass an `operation` ("chat" or
 * "responses") and the executor delegates payload building, response
 * normalization, and stream translation to the provider's ProviderAdapter
 * (resolved via the adapter registry). This means adding a new provider only
 * requires an adapter — no executor or service changes.
 */
class RequestExecutor {
  /**
   * @param {object} deps
   * @param {object} deps.modelRouter - ModelRouter instance
   * @param {object} deps.httpClient - HttpClient instance
   * @param {object} deps.adapterRegistry - ProviderAdapterRegistry instance
   * @param {object} [deps.usageTracker] - optional UsageTracker for per-key usage
   * @param {object} [deps.apiKeyStore] - optional ApiKeyStore for provider restrictions
   * @param {object} [deps.metricsCollector] - optional MetricsCollector
   * @param {object} [deps.healthMonitor] - optional ProviderHealthMonitor
   * @param {object} [deps.requestLog] - optional RequestLog for admin dashboard
   * @param {object} [opts]
   * @param {number} [opts.maxRetries=2] - retry attempts per provider
   * @param {number} [opts.retryBackoffMs=200] - base backoff between retries
   */
  constructor({ modelRouter, httpClient, adapterRegistry, usageTracker, apiKeyStore, apiKeyManager, metricsCollector, healthMonitor, requestLog }, opts = {}) {
    if (!modelRouter) throw new Error('RequestExecutor requires a modelRouter');
    if (!httpClient) throw new Error('RequestExecutor requires an httpClient');
    if (!adapterRegistry) throw new Error('RequestExecutor requires an adapterRegistry');
    this.modelRouter = modelRouter;
    this.httpClient = httpClient;
    this.adapterRegistry = adapterRegistry;
    this.usageTracker = usageTracker || null;
    this.apiKeyStore = apiKeyStore || null;
    this.apiKeyManager = apiKeyManager || null;
    this.metricsCollector = metricsCollector || null;
    this.healthMonitor = healthMonitor || null;
    this.requestLog = requestLog || null;
    this.maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : DEFAULT_MAX_RETRIES;
    this.retryBackoffMs = opts.retryBackoffMs !== undefined ? opts.retryBackoffMs : DEFAULT_RETRY_BACKOFF_MS;
    // Sprint 12 — cost / quota / budget / token-accounting hooks. All
    // optional & late-bound (added in services/index.js AFTER the executor
    // is constructed, identical to the existing usageTracker / rateLimiter
    // late-binding pattern). null safely disables the hook(s).
    this.rateLimiter = null;           // existing — already late-bound
    this.pricingService = null;       // cost calculation
    this.usageAccountant = null;       // token / cost ledger
    this.quotaService = null;         // quota policy consume
    this.budgetService = null;        // budget consume (multiple scopes)
    this.analyticsService = null;     // anomaly checks (raises alerts)
    // Sprint: SDK Routing — late-bound SDKRoutingBridge. When set, providers
    // with a registered SDK adapter are routed through adapter.sendRequest()
    // (SDK-first); otherwise the legacy httpClient path runs unchanged.
    // Null => full backward compatibility (always legacy).
    this.sdkRouter = null;
  }

  /**
   * Resolve the adapter for a provider config.
   * @param {object} provider
   * @returns {object} ProviderAdapter instance
   * @private
   */
  _adapter(provider) {
    return this.adapterRegistry.getAdapter(provider);
  }

  /**
   * Resolve the client-sent model (which may be an alias or a virtual
   * model) to the canonical model id that the selected provider supports.
   *
   * When the input is not an alias, the input is returned unchanged.
   * When it is an alias, the input is shallow-copied with the `model`
   * field replaced by the first canonical id the provider serves.
   *
   * When the selected provider was resolved via the VirtualModelRegistry,
   * it carries `__virtualModelTarget.model` — the exact real model id the
   * virtual-model candidate declared for this provider. This takes
   * priority over the alias resolver's union list because a virtual model
   * explicitly binds a provider to a single backing model.
   *
   * This ensures the provider receives a real model id it recognizes, not
   * the gateway-internal alias or virtual name.
   *
   * @param {string} model - the client-sent model, alias, or virtual id
   * @param {object} input - the original request body
   * @param {object} provider - the selected provider config
   * @returns {object} the input with `model` resolved for this provider
   * @private
   */
  _resolveModelForProvider(model, input, provider) {
    if (!input || typeof input !== 'object') return input;
    // Virtual-model candidate target takes priority.
    if (provider && provider.__virtualModelTarget && provider.__virtualModelTarget.model) {
      const target = provider.__virtualModelTarget.model;
      if (target === input.model) return input;
      return { ...input, model: target };
    }
    if (!this.modelRouter || typeof this.modelRouter.resolveModel !== 'function') return input;
    const canonicalIds = this.modelRouter.resolveModel(model);
    if (canonicalIds.length === 1 && canonicalIds[0] === model) return input;
    // Find the first canonical id the provider supports.
    const supported = Array.isArray(provider.supportedModels) ? provider.supportedModels : [];
    const resolved = canonicalIds.find((id) => supported.includes(id)) || canonicalIds[0];
    if (resolved === input.model) return input;
    return { ...input, model: resolved };
  }

  /**
   * Build the provider request body for an operation using the provider's
   * adapter.
   * @param {object} provider
   * @param {string} operation - "chat" | "responses"
   * @param {object} input
   * @returns {object}
   * @private
   */
  _buildPayload(provider, operation, input) {
    const adapter = this._adapter(provider);
    if (operation === 'responses') return adapter.buildResponsesPayload(provider, input);
    if (operation === 'embeddings') return adapter.buildEmbeddingsPayload(provider, input);
    if (operation === 'images.generations'
      || operation === 'images.edits'
      || operation === 'images.variations') {
      return adapter.buildImagesPayload(provider, input, operation);
    }
    if (operation === 'audio.speech'
      || operation === 'audio.transcriptions'
      || operation === 'audio.translations') {
      return adapter.buildAudioPayload(provider, input, operation);
    }
    return adapter.buildChatPayload(provider, input);
  }

  /**
   * Normalize a provider response for an operation using the provider's
   * adapter.
   * @param {object} provider
   * @param {string} operation
   * @param {object} providerResponse
   * @param {object} input
   * @returns {object}
   * @private
   */
  _normalizeResponse(provider, operation, providerResponse, input) {
    const adapter = this._adapter(provider);
    if (operation === 'responses') return adapter.normalizeResponsesResponse(providerResponse, input);
    if (operation === 'embeddings') return adapter.normalizeEmbeddingsResponse(providerResponse, input);
    if (operation === 'images.generations'
      || operation === 'images.edits'
      || operation === 'images.variations') {
      return adapter.normalizeImagesResponse(providerResponse, input);
    }
    if (operation === 'audio.speech'
      || operation === 'audio.transcriptions'
      || operation === 'audio.translations') {
      return adapter.normalizeAudioResponse(providerResponse, input, operation);
    }
    return adapter.normalizeChatResponse(providerResponse, input);
  }

  /**
   * Resolve the provider endpoint path for an operation using the provider's
   * adapter.
   * @param {object} provider
   * @param {string} operation
   * @returns {string}
   * @private
   */
  _endpoint(provider, operation) {
    const adapter = this._adapter(provider);
    if (operation === 'responses') return adapter.responsesEndpoint(provider);
    if (operation === 'embeddings') return adapter.embeddingsEndpoint(provider);
    if (operation === 'images.generations'
      || operation === 'images.edits'
      || operation === 'images.variations') {
      return adapter.imagesEndpoint(provider, operation);
    }
    if (operation === 'audio.speech'
      || operation === 'audio.transcriptions'
      || operation === 'audio.translations') {
      return adapter.audioEndpoint(provider, operation);
    }
    return adapter.chatEndpoint(provider);
  }

  /**
   * Build extra per-request headers from the provider's adapter.
   * @param {object} provider
   * @returns {object}
   * @private
   */
  _adapterHeaders(provider) {
    const adapter = this._adapter(provider);
    return adapter.buildHeaders(provider) || {};
  }

  /**
   * Resolve runtime authentication for a provider through the official
   * ConnectionManager. Returns an auth override
   * ({ connectionId, authType, apiKey, headers }) when a connected account is
   * available, else null so the HttpClient falls back to the legacy
   * ApiKeyManager path (full backward compatibility).
   *
   * Never logs or exposes secrets — the override is passed straight to the
   * transport layer.
   *
   * @param {object} provider
   * @param {object} ctx
   * @returns {Promise<object|null>}
   * @private
   */
  async _resolveConnectionAuth(provider, ctx = {}) {
    if (!this.connectionManager || typeof this.connectionManager.resolveRuntimeAuth !== 'function') {
      return null;
    }
    try {
      // Model-based routing rules can restrict the eligible connection set
      // (allow-list). The ModelRouter owns the rule state (late-bound).
      let connectionIds;
      if (ctx.model && this.modelRouter && typeof this.modelRouter.connectionAllowList === 'function') {
        const allow = this.modelRouter.connectionAllowList(ctx.model);
        if (allow) connectionIds = allow;
      }
      return await this.connectionManager.resolveRuntimeAuth(provider.id, {
        strategy: ctx.connectionStrategy,
        model: ctx.model,
        connectionIds,
      });
    } catch (_) {
      return null;
    }
  }

  /**
   * Determine the axios `responseType` to use for a provider request. Most
   * operations return JSON; audio speech returns raw audio bytes, so the
   * provider request must use `arraybuffer` to preserve the binary data.
   * @param {object} provider
   * @param {string} operation
   * @param {object} input
   * @returns {string|undefined} "arraybuffer" for binary audio speech,
   *   otherwise undefined (defaults to "json" in the HttpClient)
   * @private
   */
  _responseType(provider, operation, input) {
    const adapter = this._adapter(provider);
    if (typeof adapter.isAudioBinaryResponse === 'function'
      && adapter.isAudioBinaryResponse(input, operation)) {
      return 'arraybuffer';
    }
    return undefined;
  }

  /**
   * Resolve the request timeout for a provider (used by the SDK routing path).
   * @private
   */
  _timeout(provider) {
    return (provider && provider.timeout) || 30000;
  }

  /**
   * Extract the total token count from a normalized provider response body.
   * Used by the usage tracker. Returns 0 when no usage is present.
   * @param {object} body - normalized response body
   * @returns {number}
   * @private
   */
  _extractTotalTokens(body) {
    if (!body || typeof body !== 'object') return 0;
    const usage = body.usage;
    if (!usage || typeof usage !== 'object') return 0;
    if (typeof usage.total_tokens === 'number') return usage.total_tokens;
    return this._extractPromptTokens(body) + this._extractCompletionTokens(body);
  }

  /**
   * Extract the prompt (input) token count from a normalized response body.
   * @param {object} body
   * @returns {number}
   * @private
   */
  _extractPromptTokens(body) {
    if (!body || typeof body !== 'object') return 0;
    const usage = body.usage;
    if (!usage || typeof usage !== 'object') return 0;
    if (typeof usage.prompt_tokens === 'number') return usage.prompt_tokens;
    if (typeof usage.input_tokens === 'number') return usage.input_tokens;
    return 0;
  }

  /**
   * Extract the completion (output) token count from a normalized response.
   * @param {object} body
   * @returns {number}
   * @private
   */
  _extractCompletionTokens(body) {
    if (!body || typeof body !== 'object') return 0;
    const usage = body.usage;
    if (!usage || typeof usage !== 'object') return 0;
    if (typeof usage.completion_tokens === 'number') return usage.completion_tokens;
    if (typeof usage.output_tokens === 'number') return usage.output_tokens;
    return 0;
  }

  /**
   * Extract cached-prompt tokens (OpenAI prompt-tokens-cache / Anthropic
   * cache_read_input_tokens). Sprint 12 — used by PricingService to bill at
   * the cheaper cached rate. Returns 0 when not reported.
   * @param {object} body
   * @returns {number}
   * @private
   */
  _extractCachedTokens(body) {
    if (!body || typeof body !== 'object') return 0;
    const usage = body.usage;
    if (!usage || typeof usage !== 'object') return 0;
    if (typeof usage.cached_tokens === 'number') return usage.cached_tokens;
    if (typeof usage.prompt_tokens_details === 'object' && usage.prompt_tokens_details) {
      if (typeof usage.prompt_tokens_details.cached_tokens === 'number') return usage.prompt_tokens_details.cached_tokens;
    }
    if (typeof usage.cache_read_input_tokens === 'number') return usage.cache_read_input_tokens;
    return 0;
  }

  /**
   * Extract reasoning tokens (OpenAI o1/o3 family). Sprint 12.
   * @param {object} body
   * @returns {number}
   * @private
   */
  _extractReasoningTokens(body) {
    if (!body || typeof body !== 'object') return 0;
    const usage = body.usage;
    if (!usage || typeof usage !== 'object') return 0;
    if (typeof usage.reasoning_tokens === 'number') return usage.reasoning_tokens;
    if (typeof usage.completion_tokens_details === 'object' && usage.completion_tokens_details) {
      if (typeof usage.completion_tokens_details.reasoning_tokens === 'number') return usage.completion_tokens_details.reasoning_tokens;
    }
    return 0;
  }

  /**
   * Map an operation id to the capability flag it requires on the provider's
   * adapter. Returns null when the operation has no capability gate.
   *
   * Note: the "responses" operation is intentionally NOT gated by
   * `supportsResponses` — that capability indicates *native* Responses API
   * support, but the gateway serves responses for every chat-capable
   * provider by translating to Chat Completions. The "embeddings" and
   * "images.*" operations are gated because they are distinct endpoints
   * that not all providers offer.
   *
   * @param {string} operation - "chat" | "responses" | "embeddings" |
   *   "images.generations" | "images.edits" | "images.variations"
   * @returns {string|null}
   * @private
   */
  _capabilityForOperation(operation) {
    if (operation === 'embeddings') return 'supportsEmbeddings';
    if (operation === 'images.generations'
      || operation === 'images.edits'
      || operation === 'images.variations') {
      return 'supportsImages';
    }
    if (operation === 'audio.speech'
      || operation === 'audio.transcriptions'
      || operation === 'audio.translations') {
      return 'supportsAudio';
    }
    return null;
  }

  /**
   * Map an operation id (or capability name) to the OpenAI-compatible error
   * code used when no candidate provider supports the required capability.
   * @param {string} operationOrCapability
   * @returns {string}
   * @private
   */
  _unsupportedErrorCode(operationOrCapability) {
    if (operationOrCapability === 'embeddings') return 'EMBEDDINGS_NOT_SUPPORTED';
    if (operationOrCapability === 'supportsEmbeddings') return 'EMBEDDINGS_NOT_SUPPORTED';
    if (operationOrCapability === 'images.generations'
      || operationOrCapability === 'images.edits'
      || operationOrCapability === 'images.variations') {
      return 'IMAGES_NOT_SUPPORTED';
    }
    if (operationOrCapability === 'supportsImages') return 'IMAGES_NOT_SUPPORTED';
    if (operationOrCapability === 'audio.speech'
      || operationOrCapability === 'audio.transcriptions'
      || operationOrCapability === 'audio.translations') {
      return 'AUDIO_NOT_SUPPORTED';
    }
    if (operationOrCapability === 'supportsAudio') return 'AUDIO_NOT_SUPPORTED';
    if (operationOrCapability === 'supportsTools') return 'TOOLS_NOT_SUPPORTED';
    return 'CAPABILITY_NOT_SUPPORTED';
  }

  /**
   * Filter candidate providers to those whose adapter declares support for the
   * requested operation. For operations without a capability gate (chat), the
   * list is returned unchanged.
   *
   * Throws an OpenAI-compatible 400 error when the model is served by one or
   * more providers but none of them support the requested capability (e.g. an
   * embeddings request against a provider whose adapter declares
   * `supportsEmbeddings:false`).
   *
   * @param {Array<object>} candidates - ordered candidate providers
   * @param {string} operation
   * @param {string} model
   * @param {string} requestId
   * @param {string} [requiredCapability] - optional extra capability gate
   *   from the request input (e.g. "supportsTools" when the request carries
   *   tools). Applied in addition to the operation's own capability gate.
   * @returns {Array<object>} filtered candidates
   * @private
   */
  _filterByCapability(candidates, operation, model, requestId, requiredCapability) {
    if (candidates.length === 0) return candidates;

    const cap = this._capabilityForOperation(operation);
    let filtered = cap
      ? candidates.filter((p) => this._adapter(p).supports(cap))
      : candidates;

    // Apply the optional input-driven capability gate (e.g. supportsTools
    // when the chat request carries tools).
    if (requiredCapability) {
      filtered = filtered.filter((p) => this._adapter(p).supports(requiredCapability));
    }

    if (filtered.length === 0) {
      // Determine the most specific error code. If the operation has its own
      // gate and it filtered everything, use that code; otherwise the
      // input-driven gate is the reason.
      let code;
      let capLabel;
      if (cap && requiredCapability) {
        // Both gates applied; report the input-driven one (tools) since the
        // operation gate (chat) has none for the "chat" operation.
        code = this._unsupportedErrorCode(requiredCapability);
        capLabel = requiredCapability;
      } else if (cap) {
        code = this._unsupportedErrorCode(operation);
        capLabel = cap;
      } else {
        code = this._unsupportedErrorCode(requiredCapability || operation);
        capLabel = requiredCapability || cap;
      }
      throw new AppError(
        `Operation "${operation}" is not supported for model "${model}"`,
        400,
        { code, requestId, capability: capLabel, operation }
      );
    }
    return filtered;
  }

  /**
   * Execute a request against the best provider for `model`, with retry and
   * fallback to other candidate providers.
   *
   * @param {object} args
   * @param {string} args.model - model id
   * @param {object} args.input - the endpoint-specific request body (validated)
   * @param {string} args.operation - "chat" | "responses" | "embeddings"
   * @param {string} [args.requiredCapability] - optional input-driven
   *   capability gate (e.g. "supportsTools" when the chat request carries tools)
   * @param {object} [args.ctx] - request context (requestId, etc.)
   * @returns {Promise<{status:number, body:object, meta:object}>}
   */
  async execute({ model, input, operation, requiredCapability, ctx = {} }) {
    const requestId = ctx.requestId || 'unknown';
    let candidates = this._filterByCapability(
      this.modelRouter.getCandidateProviders(model),
      operation,
      model,
      requestId,
      requiredCapability
    );

    // Enforce per-key MODEL restriction at the executor chokepoint too. The
    // auth middleware only sees `req.body.model` (JSON requests); multipart
    // endpoints (audio/images) carry the model in a form field parsed AFTER
    // auth, so the middleware cannot enforce it there. Enforcing here closes
    // that gap for every operation. Uses the same store predicate (no second
    // permission system).
    if (ctx.apiKey && this.apiKeyStore
      && typeof this.apiKeyStore.canAccessModel === 'function'
      && !this.apiKeyStore.canAccessModel(ctx.apiKey, model)) {
      throw new AppError(
        `This API key is not allowed to access model "${model}".`,
        403,
        { code: 'MODEL_FORBIDDEN', requestId, model }
      );
    }

    // Enforce per-key provider restrictions: when the request carries an
    // API key with an allowedProviders list, filter out providers the key
    // is not permitted to use.
    if (ctx.apiKey && this.apiKeyStore) {
      const restricted = candidates.filter(
        (p) => this.apiKeyStore.canAccessProvider(ctx.apiKey, p.id)
      );
      if (restricted.length === 0 && candidates.length > 0) {
        throw new AppError(
          `This API key is not allowed to access any provider serving model "${model}".`,
          403,
          { code: 'PROVIDER_FORBIDDEN', requestId, model }
        );
      }
      candidates = restricted;
    }

    // Filter out providers whose circuit breaker is open (health monitor).
    if (this.healthMonitor) {
      candidates = candidates.filter((p) => this.healthMonitor.isAvailable(p.id));
    }

    if (candidates.length === 0) {
      throw new AppError(`No provider supports model "${model}"`, 404, {
        code: 'MODEL_NOT_FOUND',
        requestId,
      });
    }

    // Sprint 13 — apply Enterprise Policy Engine routing hints. When
    // `ctx.policyRouting` is present (the policy middleware sets it from
    // req.policyRouting) we honour force/select decisions BEFORE the
    // fallback loop starts. This is purely additive — when no policy
    // engine is attached or no decision was reached, the candidates
    // list is returned unchanged (full backward compat with existing
    // ModelRouter + RoutingStrategy + RoutingRuleEngine ordering).
    if (ctx.policyRouting) {
      const pr = ctx.policyRouting;
      // force_provider: keep ONLY the matching candidate (when it exists).
      if (pr.forceProvider) {
        const forced = candidates.find((c) => c.id === pr.forceProvider);
        if (forced) candidates = [forced];
      }
      // select_provider: move the matching candidate to the front (soft pref).
      else if (pr.selectProvider) {
        const idx = candidates.findIndex((c) => c.id === pr.selectProvider);
        if (idx > 0) {
          const [c] = candidates.splice(idx, 1);
          candidates.unshift(c);
        }
      }
      // select_virtual_model: when the requested model wasn't a VM but the
      // policy mandates one, reroute through the VM's candidates.
      if (pr.selectVirtualModel && this.modelRouter && this.modelRouter.virtualModelRegistry) {
        const vmr = this.modelRouter.virtualModelRegistry;
        if (vmr.isVirtualModel(pr.selectVirtualModel)) {
          const vmCands = vmr.resolveCandidates(pr.selectVirtualModel);
          if (vmCands.length > 0) candidates = vmCands;
        }
      }
      // force_model: handled by the _resolveModelForProvider() step below
      // — we stash the forced model on ctx so the executor sends it to the
      // provider instead of the originally requested model.
      if (pr.forceModel) ctx._forcedModel = pr.forceModel;
    }

    // Record request start in metrics (global + first provider).
    if (this.metricsCollector) {
      this.metricsCollector.recordRequestStart({
        providerId: candidates[0].id,
        virtualModelId: candidates[0].__virtualModelId,
      });
    }

    let lastError = null;
    let fallbackCount = 0;
    let totalRetryCount = 0;
    const startedAt = Date.now();
    // Track the virtual model id for this request (if any) so we can attribute
    // downstream events (success/failure/fallback) back to the virtual model
    // even when the first candidate is skipped via fallback.
    const virtualModelId = candidates[0] && candidates[0].__virtualModelId;

    for (let pIdx = 0; pIdx < candidates.length; pIdx += 1) {
      const provider = candidates[pIdx];
      const isFallback = pIdx > 0;
      if (isFallback) fallbackCount += 1;

      let retryCount = 0;
      let providerError = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        if (attempt > 0) {
          retryCount += 1;
          totalRetryCount += 1;
        }

        const attemptStartedAt = Date.now();
        const endpoint = this._endpoint(provider, operation);
        // Resolve the alias to the canonical model id the provider expects.
        const providerInput = this._resolveModelForProvider(model, input, provider);
        const payload = this._buildPayload(provider, operation, providerInput);
        const headers = this._adapterHeaders(provider);
        // Resolve runtime auth (endpoint + credential) via the official
        // ConnectionManager. Null => legacy ApiKeyManager path is used.
        const connectionAuth = await this._resolveConnectionAuth(provider, { ...ctx, model });
        const attemptCtx = {
          requestId,
          model,
          providerId: provider.id,
          adapterId: this._adapter(provider).__adapterId,
          connectionId: connectionAuth ? connectionAuth.connectionId : null,
          attempt,
          retryCount,
          fallbackCount,
        };

        logger.info('Provider request attempt', attemptCtx);

        try {
          let providerResponse;
          // SDK-first routing: when the provider has a registered SDK adapter
          // and the bridge is attached, route through adapter.sendRequest().
          // Otherwise fall back to the legacy httpClient path (unchanged).
          if (this.sdkRouter && this.sdkRouter.hasSDK(provider)) {
            providerResponse = await this.sdkRouter.sendRequest(provider, endpoint, {
              method: 'POST',
              body: payload,
              headers,
              auth: connectionAuth,
              responseType: this._responseType(provider, operation, input),
              timeout: this._timeout(provider),
            });
          } else {
            providerResponse = await this.httpClient.sendRequest(
              provider,
              endpoint,
              {
                method: 'POST',
                body: payload,
                headers,
                auth: connectionAuth,
                responseType: this._responseType(provider, operation, input),
              }
            );
          }

          const body = this._normalizeResponse(provider, operation, providerResponse, input);

          const durationMs = Date.now() - startedAt;
          const attemptLatencyMs = Date.now() - attemptStartedAt;
          logger.info('Request completed', {
            requestId,
            model,
            providerId: provider.id,
            latencyMs: durationMs,
            retryCount: totalRetryCount,
            fallbackCount,
            statusCode: providerResponse.status,
          });

          // Record per-key usage (tokens, provider, model) when a usage
          // tracker and API key are attached to the request context.
          const promptTokens = this._extractPromptTokens(body);
          const completionTokens = this._extractCompletionTokens(body);
          const totalTokens = this._extractTotalTokens(body);
          const cachedTokens = this._extractCachedTokens(body);
          const reasoningTokens = this._extractReasoningTokens(body);
          if (this.usageTracker && ctx.apiKey) {
            this.usageTracker.recordUsage(ctx.apiKey.id, {
              providerId: provider.id,
              model,
              totalTokens,
            });
          }

          // Atomic per-key quota consume (Prompt 23). When the API key carries
          // a token quota, advance `used` atomically through the store so
          // concurrent requests cannot overspend. Best-effort — never blocks a
          // response that already succeeded. Prefer total tokens; fall back to
          // counting the request itself when the provider reported no usage.
          if (this.apiKeyStore && ctx.apiKey && typeof this.apiKeyStore.consumeQuota === 'function'
            && ctx.apiKey.quota && typeof ctx.apiKey.quota.limit === 'number') {
            const consumed = totalTokens > 0 ? totalTokens : 1;
            this.apiKeyStore.consumeQuota(ctx.apiKey.id, consumed).catch(() => {});
          }

          // Sprint 12 — compute cost from pricing (0 when pricing disabled,
          // staying fully backward compatible with the existing $0 reporting).
          const resolvedModelForPricing = (provider.__virtualModelTarget && provider.__virtualModelTarget.model) || model;
          const cost = this.pricingService
            ? this.pricingService.calculateCost({
                model: resolvedModelForPricing,
                operation,
                promptTokens,
                completionTokens,
                cachedTokens,
                reasoningTokens,
              })
            : 0;

          // Record per-key health (latency + tokens) on the ApiKeyManager so
          // health-aware key selection strategies (least-used, weighted) and
          // the admin dashboard have fresh data.
          if (this.apiKeyManager && providerResponse._resolvedApiKey) {
            this.apiKeyManager.reportSuccess(provider.id, providerResponse._resolvedApiKey, {
              latencyMs: attemptLatencyMs,
              tokens: totalTokens,
            });
          }

          // Report per-connection health when this attempt used a
          // ConnectionManager-resolved credential (for health-aware selection).
          if (this.connectionManager && connectionAuth && connectionAuth.connectionId) {
            this.connectionManager.reportResult(connectionAuth.connectionId, {
              ok: true,
              latencyMs: attemptLatencyMs,
            });
          }

          // Record metrics + health for the successful attempt. (Sprint 12:
          // now passes `cost` so the existing `totalCost` field finally
          // populates — backwards compatible because callers already destructure
          // it.)
          if (this.metricsCollector) {
            this.metricsCollector.recordSuccess({
              providerId: provider.id,
              latencyMs: attemptLatencyMs,
              retryCount: totalRetryCount,
              fallbackCount,
              promptTokens,
              completionTokens,
              cost,
              virtualModelId: provider.__virtualModelId,
            });
          }
          if (this.healthMonitor) {
            this.healthMonitor.recordSuccess({ providerId: provider.id, latencyMs: attemptLatencyMs });
          }

          if (this.requestLog) {
            this.requestLog.record({
              requestId,
              model,
              providerId: provider.id,
              apiKeyId: ctx.apiKey ? ctx.apiKey.id : null,
              status: 200,
              latencyMs: durationMs,
              operation,
              connectionId: connectionAuth ? connectionAuth.connectionId : null,
              connectionName: connectionAuth ? connectionAuth.connectionName : null,
              strategy: (connectionAuth && connectionAuth.strategy)
                || (this.modelRouter && typeof this.modelRouter.getStrategy === 'function'
                  ? this.modelRouter.getStrategy() : null),
            });
          }

          // Sprint 12 — token-quota consume (existing rateLimiter hook was
          // wired but never called; this finally plumbs actual token counts
          // into the per-key daily/monthly token quotas).
          if (this.rateLimiter && this.rateLimiter.enabled && ctx.apiKey && totalTokens > 0) {
            try { this.rateLimiter.recordTokens(ctx.apiKey.id, totalTokens); } catch (_) { /* never block */ }
          }

          // Sprint 12 — UsageAccountant ledger (dimensional rollups + cost + entry).
          if (this.usageAccountant) {
            try {
              this.usageAccountant.recordRequest({
                requestId,
                apiKeyId: ctx.apiKey ? ctx.apiKey.id : null,
                providerId: provider.id,
                model: resolvedModelForPricing,
                virtualModelId: provider.__virtualModelId || null,
                userId: ctx.userId || (ctx.apiKey && ctx.apiKey.userId) || null,
                organizationId: ctx.organizationId || (ctx.apiKey && ctx.apiKey.organizationId) || null,
                projectId: ctx.projectId || (ctx.apiKey && ctx.apiKey.projectId) || null,
                operation,
                status: 200,
                latencyMs: durationMs,
                stream: false,
                connectionId: connectionAuth ? connectionAuth.connectionId : null,
                inputTokens: promptTokens,
                outputTokens: completionTokens,
                cachedTokens,
                reasoningTokens,
                totalTokens,
                cost,
              });
            } catch (_) { /* ledger is best-effort; never block a response */ }
          }

          // Sprint 12 — QuotaService.consume across every applicable scope.
          if (this.quotaService && this.quotaService.enabled) {
            try {
              this.quotaService.consume({
                apiKeyId: ctx.apiKey ? ctx.apiKey.id : null,
                providerId: provider.id,
                virtualModelId: provider.__virtualModelId || null,
                userId: ctx.userId || (ctx.apiKey && ctx.apiKey.userId) || null,
                organizationId: ctx.organizationId || (ctx.apiKey && ctx.apiKey.organizationId) || null,
                projectId: ctx.projectId || (ctx.apiKey && ctx.apiKey.projectId) || null,
                inputTokens: promptTokens,
                outputTokens: completionTokens,
                totalTokens,
                cost,
              });
            } catch (_) { /* never block */ }
          }

          // Sprint 12 — BudgetService.consume across every matching scope.
          if (this.budgetService && this.budgetService.enabled && cost > 0) {
            try {
              const scopeUser = ctx.userId || (ctx.apiKey && ctx.apiKey.userId) || null;
              const scopeOrg = ctx.organizationId || (ctx.apiKey && ctx.apiKey.organizationId) || null;
              const scopeProj = ctx.projectId || (ctx.apiKey && ctx.apiKey.projectId) || null;
              // Global is always charged
              this.budgetService.consume({ scope: 'global', scopeId: null, cost });
              if (scopeProj) this.budgetService.consume({ scope: 'project', scopeId: scopeProj, cost });
              if (scopeOrg) this.budgetService.consume({ scope: 'organization', scopeId: scopeOrg, cost });
              if (scopeUser) this.budgetService.consume({ scope: 'user', scopeId: scopeUser, cost });
            } catch (_) { /* never block */ }
          }

          // Sprint 12 — pass cost to the public meta so callers / clients can
          // observe the charge transparently.
          return {
            status: 200,
            body,
            meta: {
              providerId: provider.id,
              retryCount: totalRetryCount,
              fallbackCount,
              latencyMs: durationMs,
              virtualModelId: provider.__virtualModelId || null,
              cost,
              promptTokens,
              completionTokens,
              totalTokens,
            },
          };
        } catch (err) {
          providerError = err;
          const failLatencyMs = Date.now() - attemptStartedAt;
          if (this.connectionManager && connectionAuth && connectionAuth.connectionId) {
            this.connectionManager.reportResult(connectionAuth.connectionId, {
              ok: false,
              latencyMs: failLatencyMs,
              error: (err && err.info && err.info.code) || (err && err.message) || 'error',
            });
          }
          if (this.metricsCollector) {
            this.metricsCollector.recordFailure({
              providerId: provider.id,
              errorCode: err.info && err.info.code,
              latencyMs: failLatencyMs,
              virtualModelId: provider.__virtualModelId,
            });
          }
          if (this.healthMonitor) {
            this.healthMonitor.recordFailure({
              providerId: provider.id,
              errorCode: err.info && err.info.code,
            });
          }
          logger.warn('Provider attempt failed', {
            requestId,
            model,
            providerId: provider.id,
            attempt,
            retryCount,
            fallbackCount,
            code: err.info && err.info.code,
            statusCode: err.statusCode,
            message: err.message,
          });

          if (!isRetryable(err)) break;
          if (attempt < this.maxRetries) {
            await sleep(this.retryBackoffMs * Math.pow(2, attempt));
          }
        }
      }

      lastError = providerError;

      if (pIdx < candidates.length - 1) {
        if (isFallbackEligible(providerError)) {
          if (this.metricsCollector) {
            this.metricsCollector.recordFallback({
              fromProviderId: provider.id,
              toProviderId: candidates[pIdx + 1].id,
              virtualModelId,
            });
          }
          logger.warn('Falling back to next provider', {
            requestId,
            model,
            fromProviderId: provider.id,
            toProviderId: candidates[pIdx + 1].id,
            fallbackCount: fallbackCount + 1,
            code: providerError && providerError.info && providerError.info.code,
          });
          continue;
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    logger.error('Request exhausted all providers', {
      requestId,
      model,
      latencyMs: durationMs,
      retryCount: totalRetryCount,
      fallbackCount,
      code: lastError && lastError.info && lastError.info.code,
    });

    if (this.metricsCollector) {
      this.metricsCollector.recordRequestFailure({
        providerId: candidates[candidates.length - 1].id,
      });
    }

    if (this.requestLog) {
      this.requestLog.record({
        requestId,
        model,
        providerId: candidates[candidates.length - 1].id,
        apiKeyId: ctx.apiKey ? ctx.apiKey.id : null,
        status: (lastError && lastError.statusCode) || 502,
        latencyMs: durationMs,
        operation,
        error: lastError ? lastError.message : 'Request failed',
        strategy: this.modelRouter && typeof this.modelRouter.getStrategy === 'function'
          ? this.modelRouter.getStrategy() : null,
      });
    }

    // Prompt 24 — record the FAILED request in the usage ledger so analytics
    // can report error rate / error categories per key/provider/model. Uses
    // the shared error taxonomy; token counts stay 0 (unknown) — never faked.
    if (this.usageAccountant) {
      try {
        this.usageAccountant.recordRequest({
          requestId,
          apiKeyId: ctx.apiKey ? ctx.apiKey.id : null,
          providerId: candidates[candidates.length - 1].id,
          model,
          userId: ctx.userId || (ctx.apiKey && ctx.apiKey.userId) || null,
          organizationId: ctx.organizationId || (ctx.apiKey && ctx.apiKey.organizationId) || null,
          projectId: ctx.projectId || (ctx.apiKey && ctx.apiKey.projectId) || null,
          operation,
          status: (lastError && lastError.statusCode) || 502,
          latencyMs: durationMs,
          stream: false,
          errorCategory: analyticsErrorCategory(lastError),
        });
      } catch (_) { /* best-effort */ }
    }

    if (lastError) throw lastError;
    throw new AppError('Request failed for unknown reasons', 502, { requestId });
  }

  /**
   * Execute a streaming request against the best provider for `model`, with
   * retry and fallback for the pre-stream phase (header establishment). Once
   * the stream is successfully established and the first byte is flowing to the
   * client, retry/fallback is no longer possible — a mid-stream error is
   * surfaced to the client as an SSE error event.
   *
   * The caller provides an SSEWriter (transport) and the endpoint name; the
   * executor uses the provider's ProviderAdapter for payload building,
   * endpoint resolution, and SSE chunk translation.
   *
   * @param {object} args
   * @param {string} args.model - model id
   * @param {object} args.input - the endpoint-specific request body (validated)
   * @param {string} args.operation - "chat" | "responses"
   * @param {string} [args.requiredCapability] - optional input-driven capability gate
   * @param {object} args.sseWriter - SSEWriter instance
   * @param {object} args.streamAdapter - StreamingResponseAdapter instance
   * @param {object} [args.ctx] - request context (requestId, etc.)
   * @returns {Promise<void>} resolves when the stream is fully consumed
   */
  async executeStream({ model, input, operation, requiredCapability, sseWriter, streamAdapter, ctx = {} }) {
    const requestId = ctx.requestId || 'unknown';
    let candidates = this._filterByCapability(
      this.modelRouter.getCandidateProviders(model),
      operation,
      model,
      requestId,
      requiredCapability
    );

    // Enforce per-key MODEL restriction (mirrors execute()); multipart and
    // JSON streaming both flow through here.
    if (ctx.apiKey && this.apiKeyStore
      && typeof this.apiKeyStore.canAccessModel === 'function'
      && !this.apiKeyStore.canAccessModel(ctx.apiKey, model)) {
      throw new AppError(
        `This API key is not allowed to access model "${model}".`,
        403,
        { code: 'MODEL_FORBIDDEN', requestId, model }
      );
    }

    // Enforce per-key provider restrictions BEFORE any upstream call. This
    // mirrors the non-streaming execute() path so streaming can never bypass
    // provider permission (including on failover, since the whole candidate
    // pool is pre-filtered here). Fixes the streaming permission-bypass gap.
    if (ctx.apiKey && this.apiKeyStore) {
      const restricted = candidates.filter(
        (p) => this.apiKeyStore.canAccessProvider(ctx.apiKey, p.id)
      );
      if (restricted.length === 0 && candidates.length > 0) {
        throw new AppError(
          `This API key is not allowed to access any provider serving model "${model}".`,
          403,
          { code: 'PROVIDER_FORBIDDEN', requestId, model }
        );
      }
      candidates = restricted;
    }

    // Filter out providers whose circuit breaker is open (health monitor).
    if (this.healthMonitor) {
      candidates = candidates.filter((p) => this.healthMonitor.isAvailable(p.id));
    }

    if (candidates.length === 0) {
      throw new AppError(`No provider supports model "${model}"`, 404, {
        code: 'MODEL_NOT_FOUND',
        requestId,
      });
    }

    let lastError = null;
    let fallbackCount = 0;
    let totalRetryCount = 0;
    const startedAt = Date.now();
    let bytesSent = 0;

    // Record request start in metrics.
    if (this.metricsCollector) {
      this.metricsCollector.recordRequestStart({ providerId: candidates[0].id });
    }

    for (let pIdx = 0; pIdx < candidates.length; pIdx += 1) {
      const provider = candidates[pIdx];
      const isFallback = pIdx > 0;
      if (isFallback) fallbackCount += 1;

      let retryCount = 0;
      let providerError = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        if (attempt > 0) {
          retryCount += 1;
          totalRetryCount += 1;
        }

        const endpoint = this._endpoint(provider, operation);
        // Resolve the alias to the canonical model id the provider expects
        // (mirrors the non-streaming execute() path).
        const providerInput = this._resolveModelForProvider(model, input, provider);
        const payload = this._buildPayload(provider, operation, providerInput);
        const headers = this._adapterHeaders(provider);
        const adapter = this._adapter(provider);
        const connectionAuth = await this._resolveConnectionAuth(provider, { ...ctx, model });
        const attemptCtx = {
          requestId,
          model,
          providerId: provider.id,
          adapterId: adapter.__adapterId,
          connectionId: connectionAuth ? connectionAuth.connectionId : null,
          attempt,
          retryCount,
          fallbackCount,
          stream: true,
        };

        logger.info('Provider stream attempt', attemptCtx);

        try {
          // Establish the stream (headers + connection). If this throws, we
          // can retry/fallback because nothing has been sent to the client.
          const providerResponse = await this.httpClient.streamRequest(
            provider,
            endpoint,
            { method: 'POST', body: payload, headers, auth: connectionAuth }
          );

          // Stream established — from here on, any error must be surfaced to
          // the client as an SSE error event (no more retry/fallback).
          logger.info('Stream started', {
            requestId,
            model,
            providerId: provider.id,
            statusCode: providerResponse.status,
            fallbackCount,
            retryCount: totalRetryCount,
          });

          // Wire the provider adapter into the StreamingResponseAdapter so
          // non-OpenAI streaming formats are translated.
          streamAdapter.setProviderAdapter(adapter);

          bytesSent = await this._pipeStream(providerResponse, sseWriter, streamAdapter, {
            requestId,
            model,
            providerId: provider.id,
          });

          const durationMs = Date.now() - startedAt;
          logger.info('Stream ended', {
            requestId,
            model,
            providerId: provider.id,
            latencyMs: durationMs,
            bytesSent,
            retryCount: totalRetryCount,
            fallbackCount,
          });

          // Sprint 12 — for streams, token usage may or may not be reported.
          // The formatter/adapter exposes any final usage it captured via
          // `streamAdapter.getLastUsage()` (best-effort; returns null when
          // the format has no usage). Stream cost accounting is *additive*
          // — when no usage is available we bill $0 and just record the
          // request (so the analytics path can still count streams).
          let streamUsage = null;
          try {
            if (streamAdapter && typeof streamAdapter.getLastUsage === 'function') {
              streamUsage = streamAdapter.getLastUsage();
            }
          } catch (_) { streamUsage = null; }
          const streamPrompt = (streamUsage && typeof streamUsage.prompt_tokens === 'number') ? streamUsage.prompt_tokens
            : (streamUsage && typeof streamUsage.input_tokens === 'number') ? streamUsage.input_tokens : 0;
          const streamCompletion = (streamUsage && typeof streamUsage.completion_tokens === 'number') ? streamUsage.completion_tokens
            : (streamUsage && typeof streamUsage.output_tokens === 'number') ? streamUsage.output_tokens : 0;
          const streamTotal = (streamUsage && typeof streamUsage.total_tokens === 'number') ? streamUsage.total_tokens : (streamPrompt + streamCompletion);
          const resolvedStreamModel = (provider.__virtualModelTarget && provider.__virtualModelTarget.model) || model;
          const streamCost = this.pricingService
            ? this.pricingService.calculateCost({ model: resolvedStreamModel, operation, promptTokens: streamPrompt, completionTokens: streamCompletion })
            : 0;

          // Record metrics + health for the successful stream. Includes cost.
          if (this.metricsCollector) {
            this.metricsCollector.recordSuccess({
              providerId: provider.id,
              latencyMs: durationMs,
              retryCount: totalRetryCount,
              fallbackCount,
              promptTokens: streamPrompt,
              completionTokens: streamCompletion,
              cost: streamCost,
              virtualModelId: provider.__virtualModelId,
            });
          }
          if (this.healthMonitor) {
            this.healthMonitor.recordSuccess({ providerId: provider.id, latencyMs: durationMs });
          }

          if (this.rateLimiter && this.rateLimiter.enabled && ctx.apiKey && streamTotal > 0) {
            try { this.rateLimiter.recordTokens(ctx.apiKey.id, streamTotal); } catch (_) {}
          }
          if (this.usageAccountant) {
            try {
              this.usageAccountant.recordRequest({
                requestId,
                apiKeyId: ctx.apiKey ? ctx.apiKey.id : null,
                providerId: provider.id,
                model: resolvedStreamModel,
                virtualModelId: provider.__virtualModelId || null,
                userId: ctx.userId || (ctx.apiKey && ctx.apiKey.userId) || null,
                organizationId: ctx.organizationId || (ctx.apiKey && ctx.apiKey.organizationId) || null,
                projectId: ctx.projectId || (ctx.apiKey && ctx.apiKey.projectId) || null,
                operation,
                status: 200,
                latencyMs: durationMs,
                stream: true,
                connectionId: connectionAuth ? connectionAuth.connectionId : null,
                inputTokens: streamPrompt,
                outputTokens: streamCompletion,
                totalTokens: streamTotal,
                cost: streamCost,
              });
            } catch (_) {}
          }
          if (this.quotaService && this.quotaService.enabled) {
            try {
              this.quotaService.consume({
                apiKeyId: ctx.apiKey ? ctx.apiKey.id : null,
                providerId: provider.id,
                virtualModelId: provider.__virtualModelId || null,
                userId: ctx.userId || (ctx.apiKey && ctx.apiKey.userId) || null,
                organizationId: ctx.organizationId || (ctx.apiKey && ctx.apiKey.organizationId) || null,
                projectId: ctx.projectId || (ctx.apiKey && ctx.apiKey.projectId) || null,
                inputTokens: streamPrompt, outputTokens: streamCompletion, totalTokens: streamTotal, cost: streamCost,
              });
            } catch (_) {}
          }
          if (this.budgetService && this.budgetService.enabled && streamCost > 0) {
            try {
              const sUser = ctx.userId || (ctx.apiKey && ctx.apiKey.userId) || null;
              const sOrg = ctx.organizationId || (ctx.apiKey && ctx.apiKey.organizationId) || null;
              const sProj = ctx.projectId || (ctx.apiKey && ctx.apiKey.projectId) || null;
              this.budgetService.consume({ scope: 'global', scopeId: null, cost: streamCost });
              if (sProj) this.budgetService.consume({ scope: 'project', scopeId: sProj, cost: streamCost });
              if (sOrg) this.budgetService.consume({ scope: 'organization', scopeId: sOrg, cost: streamCost });
              if (sUser) this.budgetService.consume({ scope: 'user', scopeId: sUser, cost: streamCost });
            } catch (_) {}
          }

          return;
        } catch (err) {
          providerError = err;
          const failLatencyMs = Date.now() - startedAt;
          if (this.metricsCollector) {
            this.metricsCollector.recordFailure({
              providerId: provider.id,
              errorCode: err.info && err.info.code,
              latencyMs: failLatencyMs,
            });
          }
          if (this.healthMonitor) {
            this.healthMonitor.recordFailure({
              providerId: provider.id,
              errorCode: err.info && err.info.code,
            });
          }
          logger.warn('Provider stream attempt failed', {
            requestId,
            model,
            providerId: provider.id,
            attempt,
            retryCount,
            fallbackCount,
            code: err.info && err.info.code,
            statusCode: err.statusCode,
            message: err.message,
          });

          if (!isRetryable(err)) break;
          if (attempt < this.maxRetries) {
            await sleep(this.retryBackoffMs * Math.pow(2, attempt));
          }
        }
      }

      lastError = providerError;

      if (pIdx < candidates.length - 1) {
        if (isFallbackEligible(providerError)) {
          if (this.metricsCollector) {
            this.metricsCollector.recordFallback({
              fromProviderId: provider.id,
              toProviderId: candidates[pIdx + 1].id,
            });
          }
          logger.warn('Falling back to next provider (stream)', {
            requestId,
            model,
            fromProviderId: provider.id,
            toProviderId: candidates[pIdx + 1].id,
            fallbackCount: fallbackCount + 1,
            code: providerError && providerError.info && providerError.info.code,
          });
          continue;
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    logger.error('Stream exhausted all providers', {
      requestId,
      model,
      latencyMs: durationMs,
      retryCount: totalRetryCount,
      fallbackCount,
      code: lastError && lastError.info && lastError.info.code,
    });

    if (this.metricsCollector) {
      this.metricsCollector.recordRequestFailure({
        providerId: candidates[candidates.length - 1].id,
      });
    }

    // Prompt 24 — record the failed stream (pre-stream phase) in the usage
    // ledger for error-rate analytics.
    if (this.usageAccountant) {
      try {
        this.usageAccountant.recordRequest({
          requestId,
          apiKeyId: ctx.apiKey ? ctx.apiKey.id : null,
          providerId: candidates[candidates.length - 1].id,
          model,
          userId: ctx.userId || (ctx.apiKey && ctx.apiKey.userId) || null,
          organizationId: ctx.organizationId || (ctx.apiKey && ctx.apiKey.organizationId) || null,
          projectId: ctx.projectId || (ctx.apiKey && ctx.apiKey.projectId) || null,
          operation,
          status: (lastError && lastError.statusCode) || 502,
          latencyMs: durationMs,
          stream: true,
          errorCategory: analyticsErrorCategory(lastError),
        });
      } catch (_) { /* best-effort */ }
    }

    if (lastError) throw lastError;
    throw new AppError('Request failed for unknown reasons', 502, { requestId });
  }

  /**
   * Pipe a provider stream through the parser -> adapter -> writer. Resolves
   * when the stream ends (including [DONE]) and forwards normalized chunks
   * to the client.
   *
   * @param {object} providerResponse - axios stream response
   * @param {object} sseWriter - SSEWriter
   * @param {object} adapter - StreamingResponseAdapter
   * @param {object} logCtx
   * @returns {Promise<number>} bytesSent
   * @private
   */
  _pipeStream(providerResponse, sseWriter, adapter, logCtx) {
    return new Promise((resolve, reject) => {
      const stream = providerResponse.data;
      const parser = new StreamParser();
      let bytesSent = 0;
      let clientEnded = false;

      const finish = () => {
        if (!clientEnded) {
          clientEnded = true;
          sseWriter.end();
        }
        resolve(bytesSent);
      };

      const failWith = (err) => {
        if (!clientEnded) {
          clientEnded = true;
          // Mid-stream error: send an SSE error event to the client if the
          // headers are already sent, otherwise let the caller handle it.
          if (sseWriter.headersSent) {
            sseWriter.writeError({
              message: (err && err.message) || 'Stream error',
              type: 'api_error',
              code: (err && err.info && err.info.code) || null,
            });
            sseWriter.writeDone();
            sseWriter.end();
          }
        }
        reject(err);
      };

      stream.on('error', (err) => {
        logger.error('Provider stream error', { ...logCtx, error: err.message });
        failWith(err);
      });

      stream.on('end', () => {
        // If [DONE] was already forwarded, the adapter would have ended. If the
        // provider ended without [DONE], ensure the client stream closes.
        if (!clientEnded) finish();
      });

      stream.on('data', (chunk) => {
        parser.write(chunk);
      });

      parser.on('data', (parsedEvent) => {
        try {
          const clientEvents = adapter.adapt(parsedEvent);
          for (const ev of clientEvents) {
            sseWriter.writeEvent(ev);
            bytesSent = sseWriter.bytesWritten;
          }
          if (StreamParser.isDone(parsedEvent)) {
            finish();
          }
        } catch (err) {
          logger.error('Adapter error', { ...logCtx, error: err.message });
          failWith(err);
        }
      });

      parser.on('error', (err) => {
        logger.error('Parser error', { ...logCtx, error: err.message });
        failWith(err);
      });
    });
  }
}

module.exports = RequestExecutor;
module.exports.RETRYABLE_CODES = RETRYABLE_CODES;
module.exports.FALLBACK_ELIGIBLE_CODES = FALLBACK_ELIGIBLE_CODES;
module.exports.isRetryable = isRetryable;
module.exports.isFallbackEligible = isFallbackEligible;
module.exports.DEFAULT_MAX_RETRIES = DEFAULT_MAX_RETRIES;
module.exports.DEFAULT_RETRY_BACKOFF_MS = DEFAULT_RETRY_BACKOFF_MS;
