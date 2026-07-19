const AppError = require('../utils/AppError');

/**
 * Internal error type codes used by the gateway to classify provider
 * failures in a provider-agnostic way.
 */
const ErrorCode = Object.freeze({
  TIMEOUT: 'PROVIDER_TIMEOUT',
  UNAUTHORIZED: 'PROVIDER_UNAUTHORIZED',
  FORBIDDEN: 'PROVIDER_FORBIDDEN',
  NOT_FOUND: 'PROVIDER_NOT_FOUND',
  RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  SERVER_ERROR: 'PROVIDER_SERVER_ERROR',
  BAD_GATEWAY: 'PROVIDER_BAD_GATEWAY',
  SERVICE_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  CONNECTION_REFUSED: 'PROVIDER_CONNECTION_REFUSED',
  DNS_ERROR: 'PROVIDER_DNS_ERROR',
  INVALID_JSON: 'PROVIDER_INVALID_JSON',
  NETWORK_ERROR: 'PROVIDER_NETWORK_ERROR',
  UNKNOWN: 'PROVIDER_UNKNOWN_ERROR',
});

/**
 * Map a provider HTTP status code to an internal error code.
 * @param {number} status
 * @returns {string} ErrorCode
 */
function codeFromStatus(status) {
  switch (status) {
    case 401: return ErrorCode.UNAUTHORIZED;
    case 403: return ErrorCode.FORBIDDEN;
    case 404: return ErrorCode.NOT_FOUND;
    case 429: return ErrorCode.RATE_LIMITED;
    case 500: return ErrorCode.SERVER_ERROR;
    case 502: return ErrorCode.BAD_GATEWAY;
    case 503: return ErrorCode.SERVICE_UNAVAILABLE;
    default:
      return status >= 500 ? ErrorCode.SERVER_ERROR : ErrorCode.UNKNOWN;
  }
}

/**
 * Extract a human-readable message from an axios error response body.
 * Handles common provider error shapes (OpenAI-style, generic).
 * @param {*} data
 * @returns {string|null}
 */
function extractMessage(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;
  if (data.error && typeof data.error.message === 'string') return data.error.message;
  if (typeof data.message === 'string') return data.message;
  if (data.error && typeof data.error === 'string') return data.error;
  try {
    return JSON.stringify(data);
  } catch {
    return null;
  }
}

/**
 * Normalize any axios error into a consistent internal AppError.
 *
 * The returned AppError carries extra metadata via `error.info`:
 *   { code, providerId, status, endpoint, method }
 *
 * @param {Error} err - raw axios error
 * @param {object} context - request context
 * @param {string} context.providerId
 * @param {string} context.method
 * @param {string} context.endpoint
 * @returns {AppError}
 */
function normalizeHttpError(err, context = {}) {
  const { providerId, method, endpoint } = context;

  const info = {
    code: ErrorCode.UNKNOWN,
    providerId,
    status: null,
    method,
    endpoint,
  };

  if (!err) {
    return new AppError('Unknown provider error', 502, { ...info });
  }

  // Already an AppError from upstream business logic — re-wrap with metadata.
  if (err instanceof AppError && err.info && err.info.code) {
    return err;
  }

  const code = err.code || '';
  const message = err.message || 'Unknown provider error';

  // --- Axios timeout (ETIMEDOUT / ECONNABORTED) ---
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || err.timeout) {
    info.code = ErrorCode.TIMEOUT;
    return new AppError(
      `Provider "${providerId}" request timed out after ${err.timeout || ''}ms`,
      504,
      { ...info, originalMessage: message }
    );
  }

  // --- Connection refused ---
  if (code === 'ECONNREFUSED') {
    info.code = ErrorCode.CONNECTION_REFUSED;
    return new AppError(
      `Provider "${providerId}" connection refused`,
      502,
      { ...info, originalMessage: message }
    );
  }

  // --- DNS resolution failure ---
  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    (err.syscall === 'getaddrinfo')
  ) {
    info.code = ErrorCode.DNS_ERROR;
    return new AppError(
      `Provider "${providerId}" DNS resolution failed for ${endpoint || ''}`,
      502,
      { ...info, originalMessage: message }
    );
  }

  // --- Invalid JSON response (axios parses automatically, but catch decode errors) ---
  if (
    code === 'ERR_BAD_RESPONSE' ||
    message.toLowerCase().includes('unexpected token') ||
    message.toLowerCase().includes('invalid json') ||
    message.toLowerCase().includes('json')
  ) {
    const status = err.response?.status || 502;
    info.status = status;
    info.code = ErrorCode.INVALID_JSON;
    return new AppError(
      `Provider "${providerId}" returned an invalid JSON response`,
      status,
      { ...info, originalMessage: message }
    );
  }

  // --- Axios HTTP error with a response status ---
  if (err.response) {
    const status = err.response.status || 502;
    info.status = status;
    info.code = codeFromStatus(status);
    const providerMessage = extractMessage(err.response.data) || message;

    return new AppError(
      `Provider "${providerId}" responded with ${status}: ${providerMessage}`,
      status,
      { ...info, originalMessage: providerMessage }
    );
  }

  // --- Generic network / request error (no response received) ---
  if (err.request) {
    info.code = ErrorCode.NETWORK_ERROR;
    return new AppError(
      `Provider "${providerId}" network error: ${message}`,
      502,
      { ...info, originalMessage: message }
    );
  }

  // --- Fallback ---
  return new AppError(
    `Provider "${providerId}" error: ${message}`,
    502,
    { ...info, originalMessage: message }
  );
}

module.exports = {
  ErrorCode,
  codeFromStatus,
  extractMessage,
  normalizeHttpError,
};
