const AppError = require('../utils/AppError');

const VALID_ENCODING_FORMATS = new Set(['float', 'base64']);

/**
 * Validate an OpenAI Embeddings API request body.
 *
 * Required:
 *   - model: non-empty string
 *   - input: string OR non-empty array of strings
 *
 * Optional:
 *   - encoding_format: "float" | "base64"
 *   - dimensions: positive integer (when the provider supports it)
 *
 * @param {object} body
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateEmbeddingsRequest(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }

  if (!body.model || typeof body.model !== 'string' || body.model.trim() === '') {
    errors.push("'model' is required and must be a non-empty string");
  }

  if (body.input === undefined || body.input === null) {
    errors.push("'input' is required");
  } else if (typeof body.input !== 'string' && !Array.isArray(body.input)) {
    errors.push("'input' must be a string or an array of strings");
  } else if (Array.isArray(body.input)) {
    if (body.input.length === 0) {
      errors.push("'input' must contain at least one item");
    } else {
      for (let i = 0; i < body.input.length; i += 1) {
        if (typeof body.input[i] !== 'string') {
          errors.push(`input[${i}] must be a string`);
        }
      }
    }
  }

  if (body.encoding_format !== undefined && body.encoding_format !== null) {
    if (typeof body.encoding_format !== 'string' || !VALID_ENCODING_FORMATS.has(body.encoding_format)) {
      errors.push("'encoding_format' must be one of: float, base64");
    }
  }

  if (body.dimensions !== undefined && body.dimensions !== null) {
    if (typeof body.dimensions !== 'number' || !Number.isInteger(body.dimensions) || body.dimensions <= 0) {
      errors.push("'dimensions' must be a positive integer");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * EmbeddingsService
 *
 * A thin service that validates the OpenAI Embeddings API request and
 * delegates the rest to the shared RequestExecutor. The executor resolves
 * the provider's ProviderAdapter, which performs the embeddings request
 * mapping and response normalization. The executor also enforces the
 * provider's `supportsEmbeddings` capability before issuing the request, so
 * a request against an embeddings-unsupported provider (e.g. Anthropic) is
 * rejected with an OpenAI-compatible error.
 *
 * Embeddings are strictly non-streaming — this service exposes only a
 * `create()` method. Retry and fallback are inherited from the executor.
 *
 * This service owns only the gateway-facing Embeddings API contract. No
 * provider knowledge lives here.
 */
class EmbeddingsService {
  /**
   * @param {object} deps
   * @param {object} deps.requestExecutor - RequestExecutor instance
   */
  constructor({ requestExecutor }) {
    if (!requestExecutor) throw new Error('EmbeddingsService requires a requestExecutor');
    this.requestExecutor = requestExecutor;
  }

  /**
   * Handle an Embeddings request.
   *
   * @param {object} body - request body
   * @param {object} [ctx] - request context
   * @param {string} [ctx.requestId]
   * @returns {Promise<{status:number, body:object}>}
   */
  async create(body, ctx = {}) {
    const requestId = ctx.requestId || 'unknown';

    const { valid, errors } = validateEmbeddingsRequest(body);
    if (!valid) {
      throw new AppError(
        `Invalid request: ${errors.join('; ')}`,
        400,
        { requestId, code: 'INVALID_REQUEST' }
      );
    }

    if (body && body.stream === true) {
      throw new AppError(
        'Embeddings do not support streaming',
        400,
        { requestId, code: 'INVALID_REQUEST' }
      );
    }

    const result = await this.requestExecutor.execute({
      model: body.model,
      input: body,
      operation: 'embeddings',
      ctx,
    });

    return { status: result.status, body: result.body };
  }
}

module.exports = {
  EmbeddingsService,
  validateEmbeddingsRequest,
  VALID_ENCODING_FORMATS,
};
