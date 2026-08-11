const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

/**
 * Map an internal error `info.code` (from the HTTP client normalizer) to an
 * OpenAI-compatible error `type` and `code`.
 */
function openAIErrorMeta(err) {
  const code = (err.info && err.info.code) || '';
  switch (code) {
    case 'INVALID_REQUEST':
      return { type: 'invalid_request_error', code: null };
    case 'MISSING_API_KEY':
      return { type: 'invalid_request_error', code: 'missing_api_key' };
    case 'INVALID_API_KEY':
      return { type: 'invalid_request_error', code: 'invalid_api_key' };
    case 'DISABLED_API_KEY':
      return { type: 'invalid_request_error', code: 'disabled_api_key' };
    case 'REVOKED_API_KEY':
      return { type: 'invalid_request_error', code: 'revoked_api_key' };
    case 'EXPIRED_API_KEY':
      return { type: 'invalid_request_error', code: 'expired_api_key' };
    case 'MODEL_FORBIDDEN':
      return { type: 'invalid_request_error', code: 'model_forbidden' };
    case 'PROVIDER_FORBIDDEN':
      return { type: 'invalid_request_error', code: 'provider_forbidden' };
    case 'EMBEDDINGS_NOT_SUPPORTED':
      return { type: 'invalid_request_error', code: 'embeddings_not_supported' };
    case 'IMAGES_NOT_SUPPORTED':
      return { type: 'invalid_request_error', code: 'images_not_supported' };
    case 'AUDIO_NOT_SUPPORTED':
      return { type: 'invalid_request_error', code: 'audio_not_supported' };
    case 'TOOLS_NOT_SUPPORTED':
      return { type: 'invalid_request_error', code: 'tools_not_supported' };
    case 'RATE_LIMIT_EXCEEDED':
      return { type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' };
    case 'ADMIN_FORBIDDEN':
      return { type: 'invalid_request_error', code: 'admin_forbidden' };
    case 'MODEL_NOT_FOUND':
      return { type: 'invalid_request_error', code: 'model_not_found' };
    case 'NO_API_KEYS':
    case 'ALL_KEYS_UNAVAILABLE':
    case 'PROVIDER_NOT_CONFIGURED':
      return { type: 'invalid_request_error', code: 'provider_not_configured' };
    case 'PROVIDER_TIMEOUT':
      return { type: 'timeout', code: 'provider_timeout' };
    case 'PROVIDER_UNAUTHORIZED':
      return { type: 'invalid_request_error', code: 'invalid_api_key' };
    case 'PROVIDER_FORBIDDEN':
      return { type: 'invalid_request_error', code: 'forbidden' };
    case 'PROVIDER_RATE_LIMITED':
      return { type: 'rate_limit_exceeded', code: 'provider_rate_limited' };
    case 'PROVIDER_SERVICE_UNAVAILABLE':
    case 'PROVIDER_UNAVAILABLE':
      return { type: 'api_error', code: 'provider_unavailable' };
    case 'PROVIDER_NOT_FOUND':
      return { type: 'invalid_request_error', code: 'model_not_found' };
    case 'PROVIDER_INVALID_JSON':
      return { type: 'api_error', code: 'invalid_provider_response' };
    case 'PROVIDER_CONNECTION_REFUSED':
    case 'PROVIDER_DNS_ERROR':
    case 'PROVIDER_NETWORK_ERROR':
      return { type: 'api_error', code: 'provider_unreachable' };
    // Sprint 12 — Quota & Budget Management.
    case 'QUOTA_EXCEEDED':
      return { type: 'rate_limit_exceeded', code: 'quota_exceeded' };
    case 'BUDGET_EXCEEDED':
      return { type: 'rate_limit_exceeded', code: 'budget_exceeded' };
    case 'BUDGET_WARNING':
      return { type: 'api_error', code: 'budget_warning' };
    // Sprint 13 — Enterprise Policy Engine.
    case 'POLICY_REJECT':
      return { type: 'invalid_request_error', code: 'policy_reject' };
    case 'POLICY_APPROVAL_REQUIRED':
      return { type: 'invalid_request_error', code: 'policy_approval_required' };
    default:
      return { type: 'api_error', code: null };
  }
}

/**
 * Global error handler.
 *
 * Normalizes every error into the OpenAI-compatible error envelope:
 *
 *   {
 *     "error": {
 *       "message": "...",
 *       "type": "invalid_request_error",
 *       "param": null,
 *       "code": "...",
 *       "request_id": "..."
 *     }
 *   }
 */
function errorHandler(err, req, res, next) {
  let status = 500;
  let message = 'Internal Server Error';
  let meta = { type: 'api_error', code: null };
  const param = null;

  if (err instanceof AppError) {
    status = err.statusCode || 500;
    message = err.message;
    meta = openAIErrorMeta(err);
  } else if (err && err.status) {
    status = err.status;
    message = err.message || 'Unknown Error';
  } else {
    logger.error('Unexpected error', {
      requestId: req.requestId,
      error: err && err.message,
      stack: err && err.stack,
    });
  }

  if (status >= 500) {
    logger.error('Request failed', {
      requestId: req.requestId,
      status,
      code: meta.code,
      providerId: err.info && err.info.providerId,
      message,
    });
  }

  const body = {
    error: {
      message,
      type: meta.type,
      param,
      code: meta.code,
    },
  };

  if (req.requestId) {
    body.error.request_id = req.requestId;
  }

  // For rate-limit (429) responses, set the Retry-After header.
  if (status === 429 && err.info && err.info.retryAfterMs) {
    res.setHeader('Retry-After', String(Math.ceil(err.info.retryAfterMs / 1000)));
  }

  res.status(status).json(body);
}

module.exports = errorHandler;
