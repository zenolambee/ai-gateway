const AppError = require('../utils/AppError');

const VALID_SPEECH_FORMATS = new Set(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm', 'json', 'verbose_json']);
const VALID_TRANSCRIPTION_FORMATS = new Set(['json', 'text', 'srt', 'verbose_json', 'vtt']);

/**
 * Validate an OpenAI Audio Speech API request body (JSON).
 *
 * Required:
 *   - model: non-empty string
 *   - input: non-empty string (max 4096 chars on OpenAI)
 *   - voice: non-empty string
 *
 * Optional:
 *   - response_format: one of mp3, opus, aac, flac, wav, pcm, json, verbose_json
 *   - speed: number 0.25–4.0
 *
 * @param {object} body
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateSpeechRequest(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }

  if (!body.model || typeof body.model !== 'string' || body.model.trim() === '') {
    errors.push("'model' is required and must be a non-empty string");
  }

  if (body.input === undefined || body.input === null || String(body.input).trim() === '') {
    errors.push("'input' is required");
  } else if (typeof body.input !== 'string') {
    errors.push("'input' must be a string");
  }

  if (body.voice === undefined || body.voice === null || String(body.voice).trim() === '') {
    errors.push("'voice' is required");
  } else if (typeof body.voice !== 'string') {
    errors.push("'voice' must be a string");
  }

  if (body.response_format !== undefined && body.response_format !== null) {
    if (typeof body.response_format !== 'string' || !VALID_SPEECH_FORMATS.has(body.response_format)) {
      errors.push(`'response_format' must be one of: ${[...VALID_SPEECH_FORMATS].join(', ')}`);
    }
  }

  if (body.speed !== undefined && body.speed !== null) {
    const speed = Number(body.speed);
    if (typeof speed !== 'number' || Number.isNaN(speed) || speed < 0.25 || speed > 4.0) {
      errors.push("'speed' must be a number between 0.25 and 4.0");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate an OpenAI Audio transcription/translation request (multipart form).
 *
 * Required:
 *   - model: non-empty string
 *   - file: audio file (multer file object with a buffer)
 *
 * Optional (transcriptions):
 *   - language: ISO-639-1 two-letter code
 *   - prompt, response_format, temperature
 *
 * Optional (translations — language is NOT accepted; always translates to English):
 *   - prompt, response_format, temperature
 *
 * @param {object} body
 * @param {string} operation - "audio.transcriptions" | "audio.translations"
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateTranscriptionRequest(body, operation) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be a multipart form or JSON object'] };
  }

  if (!body.model || typeof body.model !== 'string' || body.model.trim() === '') {
    errors.push("'model' is required and must be a non-empty string");
  }

  if (!body.file || !body.file.buffer || body.file.buffer.length === 0) {
    errors.push("'file' audio file is required");
  }

  // language: transcriptions only
  if (operation === 'audio.transcriptions') {
    if (body.language !== undefined && body.language !== null) {
      if (typeof body.language !== 'string' || body.language.length !== 2) {
        errors.push("'language' must be a two-letter ISO-639-1 code");
      }
    }
  } else if (body.language !== undefined && body.language !== null) {
    errors.push("'language' is not accepted for translations (always translates to English)");
  }

  if (body.prompt !== undefined && body.prompt !== null) {
    if (typeof body.prompt !== 'string') {
      errors.push("'prompt' must be a string");
    }
  }

  if (body.response_format !== undefined && body.response_format !== null) {
    if (typeof body.response_format !== 'string' || !VALID_TRANSCRIPTION_FORMATS.has(body.response_format)) {
      errors.push(`'response_format' must be one of: ${[...VALID_TRANSCRIPTION_FORMATS].join(', ')}`);
    }
  }

  if (body.temperature !== undefined && body.temperature !== null) {
    const temp = Number(body.temperature);
    if (typeof temp !== 'number' || Number.isNaN(temp) || temp < 0 || temp > 1) {
      errors.push("'temperature' must be a number between 0 and 1");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * AudioService
 *
 * A thin service that validates the OpenAI Audio API request and delegates
 * the rest to the shared RequestExecutor. The executor resolves the
 * provider's ProviderAdapter, which performs the audio request mapping
 * (JSON for speech, multipart/form-data for transcriptions/translations)
 * and response normalization (binary pass-through for speech, `{ text }`
 * JSON for transcriptions/translations). The executor also enforces the
 * provider's `supportsAudio` capability before issuing the request, so a
 * request against an audio-unsupported provider is rejected with an
 * OpenAI-compatible error.
 *
 * Audio is strictly non-streaming — this service exposes only `speech()`,
 * `transcribe()`, and `translate()` methods. Retry and fallback are
 * inherited from the executor.
 *
 * This service owns only the gateway-facing Audio API contract. No
 * provider knowledge lives here.
 */
class AudioService {
  /**
   * @param {object} deps
   * @param {object} deps.requestExecutor - RequestExecutor instance
   */
  constructor({ requestExecutor }) {
    if (!requestExecutor) throw new Error('AudioService requires a requestExecutor');
    this.requestExecutor = requestExecutor;
  }

  /**
   * Reject streaming requests and coerce multipart numeric strings.
   * @param {object} body
   * @param {string} requestId
   * @private
   */
  _preCheck(body, requestId) {
    if (body && body.stream === true) {
      throw new AppError(
        'Audio does not support streaming',
        400,
        { requestId, code: 'INVALID_REQUEST' }
      );
    }
    if (body) {
      if (body.speed !== undefined && typeof body.speed === 'string') body.speed = Number(body.speed);
      if (body.temperature !== undefined && typeof body.temperature === 'string') {
        body.temperature = Number(body.temperature);
      }
    }
  }

  /**
   * Handle a text-to-speech request (POST /v1/audio/speech).
   *
   * The result `body` is a binary `Buffer` when `response_format` is an audio
   * format (mp3/opus/aac/flac/wav/pcm), or a JSON object when
   * `response_format` is `json`/`verbose_json`. The route inspects the body
   * (`Buffer.isBuffer`) to decide whether to send raw bytes or JSON.
   *
   * @param {object} body - request body (JSON)
   * @param {object} [ctx] - request context
   * @returns {Promise<{status:number, body:Buffer|object}>}
   */
  async speech(body, ctx = {}) {
    const requestId = ctx.requestId || 'unknown';
    this._preCheck(body, requestId);

    const { valid, errors } = validateSpeechRequest(body);
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
      operation: 'audio.speech',
      ctx,
    });
    return { status: result.status, body: result.body };
  }

  /**
   * Handle a transcription request (POST /v1/audio/transcriptions).
   * @param {object} body - request body (multipart fields + multer file)
   * @param {object} [ctx] - request context
   * @returns {Promise<{status:number, body:object}>}
   */
  async transcribe(body, ctx = {}) {
    const requestId = ctx.requestId || 'unknown';
    this._preCheck(body, requestId);

    const { valid, errors } = validateTranscriptionRequest(body, 'audio.transcriptions');
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
      operation: 'audio.transcriptions',
      ctx,
    });
    return { status: result.status, body: result.body };
  }

  /**
   * Handle a translation request (POST /v1/audio/translations).
   * @param {object} body - request body (multipart fields + multer file)
   * @param {object} [ctx] - request context
   * @returns {Promise<{status:number, body:object}>}
   */
  async translate(body, ctx = {}) {
    const requestId = ctx.requestId || 'unknown';
    this._preCheck(body, requestId);

    const { valid, errors } = validateTranscriptionRequest(body, 'audio.translations');
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
      operation: 'audio.translations',
      ctx,
    });
    return { status: result.status, body: result.body };
  }
}

module.exports = {
  AudioService,
  validateSpeechRequest,
  validateTranscriptionRequest,
  VALID_SPEECH_FORMATS,
  VALID_TRANSCRIPTION_FORMATS,
};
