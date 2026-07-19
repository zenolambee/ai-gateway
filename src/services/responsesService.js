const AppError = require('../utils/AppError');

/**
 * Validate an OpenAI Responses API request body.
 *
 * Required:
 *   - model: non-empty string
 *   - input: string OR non-empty array of input items
 *
 * Optional:
 *   - instructions: string
 *   - metadata: object
 *   - temperature: number
 *   - max_output_tokens: number
 *
 * @param {object} body
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateResponsesRequest(body) {
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
    errors.push("'input' must be a string or an array");
  } else if (Array.isArray(body.input) && body.input.length === 0) {
    errors.push("'input' must contain at least one item");
  }

  if (body.instructions !== undefined && body.instructions !== null) {
    if (typeof body.instructions !== 'string') {
      errors.push("'instructions' must be a string");
    }
  }

  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      errors.push("'metadata' must be an object");
    }
  }

  if (body.temperature !== undefined && body.temperature !== null) {
    if (typeof body.temperature !== 'number') {
      errors.push("'temperature' must be a number");
    }
  }

  if (body.max_output_tokens !== undefined && body.max_output_tokens !== null) {
    if (typeof body.max_output_tokens !== 'number' || body.max_output_tokens <= 0) {
      errors.push("'max_output_tokens' must be a positive number");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * ResponsesService
 *
 * A thin service that validates the Responses API request and delegates the
 * rest to the shared RequestExecutor. The executor resolves the provider's
 * ProviderAdapter, which performs the Responses -> Chat Completions request
 * mapping and the Chat Completions -> Responses response normalization
 * (including provider-specific translation like Anthropic's).
 *
 * This service owns only the gateway-facing Responses API contract.
 */
class ResponsesService {
  /**
   * @param {object} deps
   * @param {object} deps.requestExecutor - RequestExecutor instance
   */
  constructor({ requestExecutor }) {
    if (!requestExecutor) throw new Error('ResponsesService requires a requestExecutor');
    this.requestExecutor = requestExecutor;
  }

  /**
   * Handle a (non-streaming) Responses API request.
   *
   * @param {object} body - request body
   * @param {object} [ctx] - request context
   * @param {string} [ctx.requestId]
   * @returns {Promise<{status:number, body:object}>}
   */
  async create(body, ctx = {}) {
    const requestId = ctx.requestId || 'unknown';

    const { valid, errors } = validateResponsesRequest(body);
    if (!valid) {
      throw new AppError(
        `Invalid request: ${errors.join('; ')}`,
        400,
        { requestId, code: 'INVALID_REQUEST' }
      );
    }

    const result = await this.requestExecutor.execute({
      model: body.model,
      input: body,
      operation: 'responses',
      ctx,
    });

    return { status: result.status, body: result.body };
  }

  /**
   * Handle a streaming Responses API request ("stream": true).
   *
   * @param {object} body - request body (with stream:true)
   * @param {object} res - Express response (for SSE output)
   * @param {object} [ctx] - request context
   * @param {string} [ctx.requestId]
   * @returns {Promise<void>}
   */
  async stream(body, res, ctx = {}) {
    const requestId = ctx.requestId || 'unknown';

    const { valid, errors } = validateResponsesRequest(body);
    if (!valid) {
      throw new AppError(
        `Invalid request: ${errors.join('; ')}`,
        400,
        { requestId, code: 'INVALID_REQUEST' }
      );
    }

    const SSEWriter = require('./sseWriter');
    const StreamingResponseAdapter = require('./streamingResponseAdapter');

    const sseWriter = new SSEWriter(res);
    const streamAdapter = new StreamingResponseAdapter({
      endpoint: 'responses',
      model: body.model,
      ctx: { requestId },
    });

    await this.requestExecutor.executeStream({
      model: body.model,
      input: body,
      operation: 'responses',
      sseWriter,
      streamAdapter,
      ctx,
    });
  }
}

module.exports = {
  ResponsesService,
  validateResponsesRequest,
};
