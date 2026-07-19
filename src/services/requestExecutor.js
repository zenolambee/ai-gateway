const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const StreamParser = require('./streamParser');
const StreamingResponseAdapter = require('./streamingResponseAdapter');

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
  constructor({ modelRouter, httpClient, adapterRegistry, usageTracker, apiKeyStore, metricsCollector, healthMonitor, requestLog }, opts = {}) {
    if (!modelRouter) throw new Error('RequestExecutor requires a modelRouter');
    if (!httpClient) throw new Error('RequestExecutor requires an httpClient');
    if (!adapterRegistry) throw new Error('RequestExecutor requires an adapterRegistry');
    this.modelRouter = modelRouter;
    this.httpClient = httpClient;
    this.adapterRegistry = adapterRegistry;
    this.usageTracker = usageTracker || null;
    this.apiKeyStore = apiKeyStore || null;
    this.metricsCollector = metricsCollector || null;
    this.healthMonitor = healthMonitor || null;
    this.requestLog = requestLog || null;
    this.maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : DEFAULT_MAX_RETRIES;
    this.retryBackoffMs = opts.retryBackoffMs !== undefined ? opts.retryBackoffMs : DEFAULT_RETRY_BACKOFF_MS;
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

    // Record request start in metrics (global + first provider).
    if (this.metricsCollector) {
      this.metricsCollector.recordRequestStart({ providerId: candidates[0].id });
    }

    let lastError = null;
    let fallbackCount = 0;
    let totalRetryCount = 0;
    const startedAt = Date.now();

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
        const payload = this._buildPayload(provider, operation, input);
        const headers = this._adapterHeaders(provider);
        const attemptCtx = {
          requestId,
          model,
          providerId: provider.id,
          adapterId: this._adapter(provider).__adapterId,
          attempt,
          retryCount,
          fallbackCount,
        };

        logger.info('Provider request attempt', attemptCtx);

        try {
          const providerResponse = await this.httpClient.sendRequest(
            provider,
            endpoint,
            {
              method: 'POST',
              body: payload,
              headers,
              responseType: this._responseType(provider, operation, input),
            }
          );

          const body = this._normalizeResponse(provider, operation, providerResponse, input);

          const durationMs = Date.now() - startedAt;
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
          if (this.usageTracker && ctx.apiKey) {
            this.usageTracker.recordUsage(ctx.apiKey.id, {
              providerId: provider.id,
              model,
              totalTokens: this._extractTotalTokens(body),
            });
          }

          // Record metrics + health for the successful attempt.
          const attemptLatencyMs = Date.now() - startedAt;
          const promptTokens = this._extractPromptTokens(body);
          const completionTokens = this._extractCompletionTokens(body);
          if (this.metricsCollector) {
            this.metricsCollector.recordSuccess({
              providerId: provider.id,
              latencyMs: attemptLatencyMs,
              retryCount: totalRetryCount,
              fallbackCount,
              promptTokens,
              completionTokens,
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
            });
          }

          return {
            status: 200,
            body,
            meta: {
              providerId: provider.id,
              retryCount: totalRetryCount,
              fallbackCount,
              latencyMs: durationMs,
            },
          };
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
      });
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
        const payload = this._buildPayload(provider, operation, input);
        const headers = this._adapterHeaders(provider);
        const adapter = this._adapter(provider);
        const attemptCtx = {
          requestId,
          model,
          providerId: provider.id,
          adapterId: adapter.__adapterId,
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
            { method: 'POST', body: payload, headers }
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

          // Record metrics + health for the successful stream.
          if (this.metricsCollector) {
            this.metricsCollector.recordSuccess({
              providerId: provider.id,
              latencyMs: durationMs,
              retryCount: totalRetryCount,
              fallbackCount,
            });
          }
          if (this.healthMonitor) {
            this.healthMonitor.recordSuccess({ providerId: provider.id, latencyMs: durationMs });
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

    if (lastError) throw lastError;
    throw new AppError('Request failed for unknown reasons', 502, { requestId });
  }

  /**
   * Pipe a provider stream through the parser -> adapter -> writer. Resolves
   * when the stream ends (including [DONE]) and returns the total bytes written
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
