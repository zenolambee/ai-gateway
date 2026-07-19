const AppError = require('../utils/AppError');

const VALID_RESPONSE_FORMATS = new Set(['url', 'b64_json']);
const VALID_QUALITIES = new Set(['standard', 'hd']);
const VALID_STYLES = new Set(['vivid', 'natural']);
const VALID_SIZES = new Set([
  '256x256', '512x512', '1024x1024',
  '1792x1024', '1024x1792',
]);

/**
 * Validate the common fields shared by all Images API operations.
 *
 * @param {object} body - request body (JSON + multer fields)
 * @param {string} operation - "images.generations" | "images.edits" | "images.variations"
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateImagesRequest(body, operation) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be a JSON object or multipart form'] };
  }

  // model is optional in OpenAI Images (defaults to dall-e-2 on OpenAI), but
  // the gateway requires it because it routes by model -> provider.
  if (!body.model || typeof body.model !== 'string' || body.model.trim() === '') {
    errors.push("'model' is required and must be a non-empty string");
  }

  // prompt: required for generations + edits, NOT accepted for variations.
  if (operation !== 'images.variations') {
    if (body.prompt === undefined || body.prompt === null || String(body.prompt).trim() === '') {
      errors.push("'prompt' is required");
    } else if (typeof body.prompt !== 'string') {
      errors.push("'prompt' must be a string");
    }
  } else if (body.prompt !== undefined && body.prompt !== null) {
    errors.push("'prompt' is not accepted for variations");
  }

  // image: required file for edits + variations (multer file object).
  if (operation !== 'images.generations') {
    if (!body.image || !body.image.buffer || body.image.buffer.length === 0) {
      errors.push("'image' file is required");
    }
  } else if (body.image !== undefined) {
    errors.push("'image' is not accepted for generations");
  }

  // mask: optional file, edits only.
  if (operation === 'images.edits') {
    if (body.mask !== undefined && body.mask !== null) {
      if (!body.mask.buffer || body.mask.buffer.length === 0) {
        errors.push("'mask' file must be non-empty when provided");
      }
    }
  } else if (body.mask !== undefined && body.mask !== null) {
    errors.push(`'mask' is not accepted for ${operation === 'images.variations' ? 'variations' : 'generations'}`);
  }

  // n: 1-10
  if (body.n !== undefined && body.n !== null) {
    const n = Number(body.n);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      errors.push("'n' must be an integer between 1 and 10");
    }
  }

  // size
  if (body.size !== undefined && body.size !== null) {
    if (typeof body.size !== 'string' || !VALID_SIZES.has(body.size)) {
      errors.push(`'size' must be one of: ${[...VALID_SIZES].join(', ')}`);
    }
  }

  // quality (generations only on OpenAI; we accept it for all but validate)
  if (body.quality !== undefined && body.quality !== null) {
    if (typeof body.quality !== 'string' || !VALID_QUALITIES.has(body.quality)) {
      errors.push(`'quality' must be one of: ${[...VALID_QUALITIES].join(', ')}`);
    }
  }

  // style (generations only on OpenAI)
  if (body.style !== undefined && body.style !== null) {
    if (typeof body.style !== 'string' || !VALID_STYLES.has(body.style)) {
      errors.push(`'style' must be one of: ${[...VALID_STYLES].join(', ')}`);
    }
  }

  // response_format
  if (body.response_format !== undefined && body.response_format !== null) {
    if (typeof body.response_format !== 'string' || !VALID_RESPONSE_FORMATS.has(body.response_format)) {
      errors.push(`'response_format' must be one of: ${[...VALID_RESPONSE_FORMATS].join(', ')}`);
    }
  }

  // user
  if (body.user !== undefined && body.user !== null) {
    if (typeof body.user !== 'string') {
      errors.push("'user' must be a string");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * ImagesService
 *
 * A thin service that validates the OpenAI Images API request and delegates
 * the rest to the shared RequestExecutor. The executor resolves the
 * provider's ProviderAdapter, which performs the images request mapping
 * (JSON for generations, multipart/form-data for edits/variations) and
 * response normalization. The executor also enforces the provider's
 * `supportsImages` capability before issuing the request, so a request
 * against an images-unsupported provider (e.g. Anthropic) is rejected with
 * an OpenAI-compatible error.
 *
 * Images are strictly non-streaming — this service exposes only a
 * `generate()`, `edit()`, and `variation()` method. Retry and fallback are
 * inherited from the executor.
 *
 * This service owns only the gateway-facing Images API contract. No
 * provider knowledge lives here.
 */
class ImagesService {
  /**
   * @param {object} deps
   * @param {object} deps.requestExecutor - RequestExecutor instance
   */
  constructor({ requestExecutor }) {
    if (!requestExecutor) throw new Error('ImagesService requires a requestExecutor');
    this.requestExecutor = requestExecutor;
  }

  /**
   * Coerce multipart string fields (multer leaves them as strings already,
   * but clients can also send JSON) into the shape the adapter expects, and
   * reject streaming requests.
   * @param {object} body
   * @param {string} requestId
   * @private
   */
  _preCheck(body, requestId) {
    if (body && body.stream === true) {
      throw new AppError(
        'Images do not support streaming',
        400,
        { requestId, code: 'INVALID_REQUEST' }
      );
    }
    // Coerce numeric strings from multipart to numbers where the validator
    // expects a number.
    if (body) {
      if (body.n !== undefined && typeof body.n === 'string') body.n = Number(body.n);
    }
  }

  /**
   * Handle an image generation request (POST /v1/images/generations).
   * @param {object} body - request body (JSON)
   * @param {object} [ctx] - request context
   * @returns {Promise<{status:number, body:object}>}
   */
  async generate(body, ctx = {}) {
    const requestId = ctx.requestId || 'unknown';
    this._preCheck(body, requestId);

    const { valid, errors } = validateImagesRequest(body, 'images.generations');
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
      operation: 'images.generations',
      ctx,
    });
    return { status: result.status, body: result.body };
  }

  /**
   * Handle an image edit request (POST /v1/images/edits).
   * @param {object} body - request body (JSON + multer file fields)
   * @param {object} [ctx] - request context
   * @returns {Promise<{status:number, body:object}>}
   */
  async edit(body, ctx = {}) {
    const requestId = ctx.requestId || 'unknown';
    this._preCheck(body, requestId);

    const { valid, errors } = validateImagesRequest(body, 'images.edits');
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
      operation: 'images.edits',
      ctx,
    });
    return { status: result.status, body: result.body };
  }

  /**
   * Handle an image variation request (POST /v1/images/variations).
   * @param {object} body - request body (JSON + multer file fields)
   * @param {object} [ctx] - request context
   * @returns {Promise<{status:number, body:object}>}
   */
  async variation(body, ctx = {}) {
    const requestId = ctx.requestId || 'unknown';
    this._preCheck(body, requestId);

    const { valid, errors } = validateImagesRequest(body, 'images.variations');
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
      operation: 'images.variations',
      ctx,
    });
    return { status: result.status, body: result.body };
  }
}

module.exports = {
  ImagesService,
  validateImagesRequest,
  VALID_RESPONSE_FORMATS,
  VALID_QUALITIES,
  VALID_STYLES,
  VALID_SIZES,
};
