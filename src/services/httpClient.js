const axios = require('axios');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const { normalizeHttpError, ErrorCode } = require('./httpClientError');

/**
 * HttpClient
 *
 * A reusable, provider-agnostic HTTP client built on top of axios. It is the
 * single communication layer between the gateway and any AI provider. Every
 * provider reuses this client so that timeout handling, header construction,
 * logging, and error normalization are applied consistently.
 *
 * When an `apiKeyManager` is injected, HttpClient delegates API key selection
 * to it (round-robin with cooldowns) and reports the outcome of each request
 * back so that the manager can rotate keys on failure. Without a manager the
 * client falls back to the first configured key.
 *
 * Usage:
 *   const httpClient = new HttpClient({ apiKeyManager });
 *   const res = await httpClient.sendRequest(provider, '/chat/completions', {
 *     method: 'POST',
 *     body: { model: 'gpt-4o', messages: [...] },
 *   });
 *
 * Streaming support is prepared via `streamRequest()` (returns an axios
 * response stream) but is not implemented yet — intentionally deferred.
 */
class HttpClient {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.logEnabled=true] - toggle request/response/error logging
   * @param {object} [opts.apiKeyManager] - ApiKeyManager instance (optional)
   */
  constructor(opts = {}) {
    this.logEnabled = opts.logEnabled !== false;
    this.apiKeyManager = opts.apiKeyManager || null;
  }

  /**
   * Build the full URL for a request.
   * @param {object} provider - provider config (must contain baseURL)
   * @param {string} endpoint - path beginning with "/"
   * @returns {string}
   * @private
   */
  _buildUrl(provider, endpoint) {
    const base = (provider.baseURL || '').replace(/\/+$/, '');
    const path = (endpoint || '').replace(/^\/+/, '/');
    return `${base}${path}`;
  }

  /**
   * Build request headers for a provider.
   *
   * Merges (in order):
   *   1. Default JSON content headers
   *   2. Authorization Bearer from the resolved API key (see _resolveApiKey)
   *   3. Any custom headers defined in `provider.headers`
   *
   * @param {object} provider
   * @param {string|null} apiKey - resolved API key (already selected by manager)
   * @param {object} [extraHeaders] - per-request headers to merge last
   * @returns {object}
   * @private
   */
  _buildHeaders(provider, apiKey, extraHeaders = {}, authHeaders = null) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    if (provider.headers && typeof provider.headers === 'object') {
      Object.assign(headers, provider.headers);
    }

    Object.assign(headers, extraHeaders || {});

    // Connection-resolved auth headers (OAuth/device-code/session/browser)
    // take precedence over the static provider key so a Connect-Account
    // credential always wins at runtime.
    if (authHeaders && typeof authHeaders === 'object') {
      Object.assign(headers, authHeaders);
    }

    return headers;
  }

  /**
   * Detect whether a request body is a multipart form (the `form-data`
   * library). When true, the caller must NOT force a `Content-Type` header;
   * the form supplies its own (with the boundary).
   * @param {*} body
   * @returns {boolean}
   * @private
   */
  _isFormData(body) {
    return body && typeof body === 'object'
      && typeof body.getBuffer === 'function'
      && typeof body.getHeaders === 'function';
  }

  /**
   * Resolve the API key to use for a request.
   *
   * If an ApiKeyManager is attached, the next ACTIVE key is selected via
   * round-robin (throws when no key is available). Otherwise the first
   * configured key on the provider is used as a fallback.
   *
   * @param {object} provider
   * @returns {string|null}
   * @private
   */
  _resolveApiKey(provider) {
    if (this.apiKeyManager) {
      try {
        return this.apiKeyManager.getNextKey(provider.id);
      } catch (err) {
        // Surface as an operational AppError so the global errorHandler can
        // normalize it into the OpenAI error envelope.
        const code = (err.info && err.info.code) || 'NO_API_KEYS';
        const status = code === 'NO_API_KEYS' ? 503 : 503;
        throw new AppError(err.message, status, { code, providerId: provider.id });
      }
    }
    return this._getFirstApiKey(provider);
  }

  /**
   * Select the first non-empty API key from a provider config. Used as a
   * fallback when no ApiKeyManager is attached.
   * @param {object} provider
   * @returns {string|null}
   * @private
   */
  _getFirstApiKey(provider) {
    if (Array.isArray(provider.apiKeys)) {
      return provider.apiKeys.find((k) => k && typeof k === 'string') || null;
    }
    if (typeof provider.apiKey === 'string' && provider.apiKey) {
      return provider.apiKey;
    }
    return null;
  }

  /**
   * Check if a response content-type header indicates JSON.
   * @param {object} headers
   * @returns {boolean}
   * @private
   */
  _isJsonContentType(headers) {
    const ct = (headers && (headers['content-type'] || headers['Content-Type'])) || '';
    return ct.toLowerCase().includes('application/json') || ct.toLowerCase().includes('+json');
  }

  /**
   * Heuristic check that parsed JSON data is a valid object (not null and not
   * a raw string left over from a failed parse).
   * @param {*} data
   * @returns {boolean}
   * @private
   */
  _isValidJsonData(data) {
    if (data === null || data === undefined) return false;
    if (typeof data === 'string') return false;
    if (typeof data === 'object') return true;
    return true;
  }

  /**
   * Log an outgoing request.
   * @param {object} logCtx
   * @private
   */
  _logRequest(logCtx) {
    if (!this.logEnabled) return;
    logger.info('HTTP request', {
      providerId: logCtx.providerId,
      method: logCtx.method,
      url: logCtx.url,
      hasBody: logCtx.hasBody,
      timeout: logCtx.timeout,
    });
  }

  /**
   * Log a successful response.
   * @param {object} logCtx
   * @param {object} res - axios response
   * @private
   */
  _logResponse(logCtx, res) {
    if (!this.logEnabled) return;
    logger.info('HTTP response', {
      providerId: logCtx.providerId,
      method: logCtx.method,
      url: logCtx.url,
      status: res.status,
      durationMs: logCtx.durationMs,
    });
  }

  /**
   * Log a failed request.
   * @param {object} logCtx
   * @param {AppError} normalizedError
   * @private
   */
  _logError(logCtx, normalizedError) {
    if (!this.logEnabled) return;
    logger.error('HTTP request failed', {
      providerId: logCtx.providerId,
      method: logCtx.method,
      url: logCtx.url,
      code: normalizedError.info?.code,
      status: normalizedError.statusCode,
      durationMs: logCtx.durationMs,
      message: normalizedError.message,
    });
  }

  /**
   * Send an HTTP request to a provider.
   *
   * The API key is resolved up front (via ApiKeyManager if attached) and the
   * outcome is reported back so the manager can track statistics and rotate
   * keys on failure.
   *
   * @param {object} provider - provider config object
   * @param {string} endpoint - path beginning with "/" (e.g. "/chat/completions")
   * @param {object} [payload]
   * @param {string} [payload.method='GET'] - HTTP method ("GET" or "POST")
   * @param {object} [payload.query] - query parameters
   * @param {object} [payload.body] - JSON request body (POST)
   * @param {object} [payload.headers] - per-request extra headers
   * @param {number} [payload.timeout] - override provider timeout (ms)
   * @param {boolean} [payload.responseType] - axios responseType
   * @returns {Promise<{status:number, headers:object, data:*}>}
   */
  async sendRequest(provider, endpoint, payload = {}) {
    if (!provider || !provider.baseURL) {
      throw new AppError('A valid provider with baseURL is required', 500);
    }
    if (!endpoint || typeof endpoint !== 'string') {
      throw new AppError('A request endpoint is required', 400);
    }

    const method = (payload.method || 'GET').toUpperCase();
    const url = this._buildUrl(provider, endpoint);
    const timeout = payload.timeout || provider.timeout || 30000;

    // Connection-resolved auth (ConnectionManager) takes precedence. When an
    // `auth` override supplies a credential (apiKey or header-based auth such
    // as OAuth/session/cookies), we use it and do NOT fall back to the legacy
    // ApiKeyManager — this lets header-only providers (no static keys) work.
    // Otherwise we resolve/rotate a provider key via the ApiKeyManager (full
    // backward compatibility).
    const auth = payload.auth || null;
    const authHasHeaders = !!(auth && auth.headers && Object.keys(auth.headers).length > 0);
    let apiKey = null;
    if (auth && auth.apiKey) {
      apiKey = auth.apiKey;
    } else if (!authHasHeaders) {
      apiKey = this._resolveApiKey(provider);
    }
    const headers = this._buildHeaders(provider, apiKey, payload.headers, auth && auth.headers);
    const hasBody = payload.body !== undefined && payload.body !== null;
    const isForm = hasBody && this._isFormData(payload.body);

    // When the body is a multipart form, the form's Content-Type (with
    // boundary) must replace the default application/json — axios sets
    // this from the FormData instance when no Content-Type is provided.
    if (isForm) {
      delete headers['Content-Type'];
      Object.assign(headers, payload.body.getHeaders());
    }

    const logCtx = {
      providerId: provider.id,
      method,
      url,
      timeout,
      hasBody,
      multipart: isForm,
      durationMs: null,
    };

    const axiosConfig = {
      method,
      url,
      headers,
      timeout,
      params: payload.query || undefined,
      data: hasBody ? payload.body : undefined,
      responseType: payload.responseType || 'json',
      validateStatus: () => true,
      maxBodyLength: isForm ? Infinity : undefined,
      maxContentLength: isForm ? Infinity : undefined,
    };

    this._logRequest(logCtx);
    const startedAt = Date.now();

    try {
      const res = await axios(axiosConfig);
      logCtx.durationMs = Date.now() - startedAt;
      this._logResponse(logCtx, res);

      if (res.status >= 400) {
        // When responseType is arraybuffer (e.g. audio speech), the error body
        // is a Buffer. Decode it so the error normalizer can extract the
        // provider's JSON error message.
        let errorData = res.data;
        if (axiosConfig.responseType === 'arraybuffer' && Buffer.isBuffer(errorData)) {
          const text = errorData.toString('utf8');
          try { errorData = JSON.parse(text); } catch { errorData = text; }
        }
        if (process.env.DEBUG_STREAM && axiosConfig.responseType === 'stream') {
          logger.info('streamRequest error body', {
            status: res.status,
            raw: String(errorData || '').slice(0, 600),
          });
        }
        const error = {
          response: { ...res, data: errorData },
          config: axiosConfig,
          message: `Request failed with status code ${res.status}`,
        };
        const normalized = normalizeHttpError(error, {
          providerId: provider.id,
          method,
          endpoint,
        });
        this._logError(logCtx, normalized);
        if (this.apiKeyManager && apiKey) {
          this.apiKeyManager.reportFailure(provider.id, apiKey, normalized);
        }
        throw normalized;
      }

      // Detect invalid JSON responses. When responseType is 'json' and the
      // provider returns malformed JSON, axios silently sets data to null or
      // to a string instead of throwing. We surface this as a normalized error.
      if (
        (axiosConfig.responseType === 'json' || axiosConfig.responseType === undefined) &&
        this._isJsonContentType(res.headers) &&
        !this._isValidJsonData(res.data)
      ) {
        const error = {
          response: res,
          config: axiosConfig,
          message: 'Unexpected token < in JSON',
        };
        const normalized = normalizeHttpError(error, {
          providerId: provider.id,
          method,
          endpoint,
        });
        this._logError(logCtx, normalized);
        if (this.apiKeyManager && apiKey) {
          this.apiKeyManager.reportFailure(provider.id, apiKey, normalized);
        }
        throw normalized;
      }

      // Per-key health reporting is done by the RequestExecutor, which has
      // access to per-attempt latency and token counts. The HttpClient
      // reports failures (below) so cooldown logic triggers immediately on
      // a bad response, but success reporting is deferred to the executor
      // to avoid double-counting.

      return {
        status: res.status,
        headers: res.headers,
        data: res.data,
        _resolvedApiKey: apiKey,
      };
    } catch (err) {
      logCtx.durationMs = Date.now() - startedAt;
      if (err instanceof AppError && err.info?.code) {
        this._logError(logCtx, err);
        if (this.apiKeyManager && apiKey && err.info?.code !== 'NO_API_KEYS') {
          this.apiKeyManager.reportFailure(provider.id, apiKey, err);
        }
        throw err;
      }
      const normalized = normalizeHttpError(err, {
        providerId: provider.id,
        method,
        endpoint,
      });
      this._logError(logCtx, normalized);
      if (this.apiKeyManager && apiKey) {
        this.apiKeyManager.reportFailure(provider.id, apiKey, normalized);
      }
      throw normalized;
    }
  }

  /**
   * Low-level generic HTTP request used by auth adapters / token endpoints
   * (OAuth authorize, token, refresh, revoke, device authorization). Unlike
   * sendRequest(), this does NOT resolve or rotate a provider API key and does
   * NOT report to the ApiKeyManager — it is intentionally provider-independent
   * so OAuth clients can send basic-auth / client-credentials headers.
   *
   * @param {object} opts
   * @param {string} opts.url - full request URL
   * @param {string} [opts.method='GET']
   * @param {object} [opts.headers]
   * @param {object|string} [opts.body]
   * @param {boolean} [opts.form=false] - treat body as URL-encoded form
   * @param {number} [opts.timeout=30000]
   * @param {boolean} [opts.raw=false] - do not normalize errors (return {status,data})
   * @returns {Promise<{status:number, headers:object, data:*}>}
   */
  async request(opts = {}) {
    const {
      url,
      method = 'GET',
      headers = {},
      body,
      form = false,
      timeout = 30000,
      raw = false,
    } = opts;

    if (!url) {
      throw new AppError('request: url is required', 400);
    }

    const reqHeaders = { Accept: 'application/json', ...headers };
    let data;
    if (form) {
      reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      data = new URLSearchParams(body || {}).toString();
    } else if (body !== undefined && body !== null) {
      reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json';
      data = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const axiosConfig = {
      method: method.toUpperCase(),
      url,
      headers: reqHeaders,
      timeout,
      data,
      responseType: 'json',
      validateStatus: () => true,
    };

    const startedAt = Date.now();
    const res = await axios(axiosConfig);

    if (raw) {
      return { status: res.status, headers: res.headers, data: res.data };
    }
    if (res.status >= 400) {
      const error = {
        response: res,
        config: axiosConfig,
        message: `Request failed with status code ${res.status}`,
      };
      const normalized = normalizeHttpError(error, { method, url });
      normalized.payload = res.data;
      throw normalized;
    }
    return { status: res.status, headers: res.headers, data: res.data, durationMs: Date.now() - startedAt };
  }

  /**
   * Open a streaming request to a provider.
   *
   * This method is intentionally a placeholder. It returns the raw axios
   * response stream so that a future streaming layer can consume it. Streaming
   * itself (SSE parsing, chunked forwarding) is NOT implemented yet.
   *
   * @param {object} provider
   * @param {string} endpoint
   * @param {object} [payload]
   * @returns {Promise<object>} axios response with `data` as a Node stream
   * @experimental
   */
  async streamRequest(provider, endpoint, payload = {}) {
    if (!provider || !provider.baseURL) {
      throw new AppError('A valid provider with baseURL is required', 500);
    }

    const method = (payload.method || 'POST').toUpperCase();
    const url = this._buildUrl(provider, endpoint);
    const timeout = provider.timeout || 30000;
    const auth = payload.auth || null;
    const authHasHeaders = !!(auth && auth.headers && Object.keys(auth.headers).length > 0);
    let apiKey = null;
    if (auth && auth.apiKey) {
      apiKey = auth.apiKey;
    } else if (!authHasHeaders) {
      apiKey = this._resolveApiKey(provider);
    }
    const headers = this._buildHeaders(provider, apiKey, payload.headers, auth && auth.headers);
    headers.Accept = 'text/event-stream';

    if (process.env.DEBUG_STREAM) {
      logger.info('streamRequest debug', {
        providerId: provider.id,
        url,
        authHeader: (headers.Authorization || '').slice(0, 40),
        body: JSON.stringify(payload.body || '').slice(0, 800),
      });
    }
    if (process.env.DEBUG_RESP_BODY) {
      res.on('data', (d) => {
        if (d.length) logger.info('streamResp body', { chunk: d.toString().slice(0, 500) });
      });
    }

    const logCtx = {
      providerId: provider.id,
      method,
      url,
      timeout,
      hasBody: payload.body !== undefined,
      durationMs: null,
      stream: true,
    };

    const axiosConfig = {
      method,
      url,
      headers,
      timeout,
      params: payload.query || undefined,
      data: payload.body || undefined,
      responseType: 'stream',
      validateStatus: () => true,
    };

    this._logRequest(logCtx);
    const startedAt = Date.now();

    try {
      const res = await axios(axiosConfig);
      logCtx.durationMs = Date.now() - startedAt;
      this._logResponse(logCtx, res);

      if (res.status >= 400) {
        const error = {
          response: res,
          config: axiosConfig,
          message: `Stream request failed with status code ${res.status}`,
        };
        const normalized = normalizeHttpError(error, {
          providerId: provider.id,
          method,
          endpoint,
        });
        this._logError(logCtx, normalized);
        throw normalized;
      }

      return res;
    } catch (err) {
      logCtx.durationMs = Date.now() - startedAt;
      if (err instanceof AppError && err.info?.code) {
        this._logError(logCtx, err);
        throw err;
      }
      const normalized = normalizeHttpError(err, {
        providerId: provider.id,
        method,
        endpoint,
      });
      this._logError(logCtx, normalized);
      throw normalized;
    }
  }
}

module.exports = HttpClient;
module.exports.ErrorCode = ErrorCode;
