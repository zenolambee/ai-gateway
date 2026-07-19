const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Default capability set for an OpenAI-compatible provider. Individual
 * adapters override these as needed.
 */
const DEFAULT_CAPABILITIES = Object.freeze({
  supportsChat: true,
  supportsResponses: true,
  supportsStreaming: true,
  supportsEmbeddings: false,
  supportsImages: false,
  supportsAudio: false,
  supportsTools: true,
  supportsReasoning: false,
});

/**
 * OpenAI Chat Completions parameters that the gateway forwards through to
 * the provider when present in the client request. Adapters may add or
 * remove fields via buildPayload overrides.
 */
const CHAT_PASS_THROUGH = [
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'max_tokens',
  'n',
  'presence_penalty',
  'response_format',
  'seed',
  'stop',
  'temperature',
  'top_p',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'user',
];

/**
 * ProviderAdapter
 *
 * The base interface for every provider adapter. Adapters own the translation
 * between the gateway's OpenAI-compatible internal representation and the
 * provider's wire format. They deliberately contain NO retry, NO fallback,
 * NO logging, NO HTTP transport — all of that stays in the core gateway
 * (RequestExecutor, HttpClient, ApiKeyManager). Adapters are pure
 * data-transformation objects.
 *
 * Subclasses typically override:
 *   - capabilities()         — declare what the provider supports
 *   - chatEndpoint(provider)  — the provider's chat completions path
 *   - responsesEndpoint(provider) — the provider's responses API path
 *   - buildChatPayload(provider, input)        — request mapping
 *   - normalizeChatResponse(providerResponse, input) — response mapping
 *   - buildResponsesPayload(provider, input)
 *   - normalizeResponsesResponse(providerResponse, input)
 *   - adaptStreamChunk(parsedEvent, ctx)  — SSE chunk translation (optional)
 *   - buildHeaders(provider, ctx)          — extra request headers (optional)
 *
 * The base class implements the OpenAI-compatible behaviour that used to live
 * in the services, so GenericOpenAIAdapter is a trivial subclass.
 */
class ProviderAdapter {
  /**
   * @param {object} provider - normalized provider config object
   */
  constructor(provider) {
    this.provider = provider || {};
  }

  /**
   * Static id used by the registry to map `provider.adapter` -> class.
   * Subclasses override this.
   */
  static get id() { return 'base'; }

  /**
   * Return the capabilities for this provider. Subclasses override to declare
   * what the provider actually supports.
   * @returns {object}
   */
  capabilities() {
    return { ...DEFAULT_CAPABILITIES };
  }

  /**
   * Convenience capability check.
   */
  supports(name) {
    const caps = this.capabilities();
    return !!caps[name];
  }

  /**
   * List the model ids this provider serves. The base implementation reads
   * the `supportedModels` array from the provider config. Adapters whose
   * provider exposes a dynamic model list endpoint may override this to
   * fetch the live catalogue; the base implementation is config-driven so
   * it works for every provider without an extra network call.
   *
   * Returns an array of model id strings (deduplicated).
   *
   * @param {object} provider - normalized provider config
   * @returns {Array<string>}
   */
  listModels(provider) {
    const p = provider || this.provider;
    if (p && Array.isArray(p.supportedModels)) {
      return [...new Set(p.supportedModels.filter((m) => typeof m === 'string' && m))];
    }
    return [];
  }

  /**
   * Whether this provider serves a specific model id. The base
   * implementation checks `listModels()`; adapters may override for a
   * cheaper check when the provider supports prefix/regex matching.
   *
   * @param {object} provider - normalized provider config
   * @param {string} modelId
   * @returns {boolean}
   */
  supportsModel(provider, modelId) {
    if (!modelId || typeof modelId !== 'string') return false;
    return this.listModels(provider).includes(modelId);
  }

  /**
   * Return a compact, serializable description of the provider's
   * capabilities for the model registry. This is the shape stored internally
   * (never exposed directly to the client) alongside each model entry.
   *
   * @returns {object}
   */
  capabilityInfo() {
    const caps = this.capabilities();
    return {
      chat: !!caps.supportsChat,
      responses: !!caps.supportsResponses,
      streaming: !!caps.supportsStreaming,
      embeddings: !!caps.supportsEmbeddings,
      images: !!caps.supportsImages,
      audio: !!caps.supportsAudio,
      tools: !!caps.supportsTools,
      reasoning: !!caps.supportsReasoning,
    };
  }

  /**
   * Chat Completions endpoint path for this provider.
   * @param {object} provider
   * @returns {string}
   */
  chatEndpoint(provider) {
    return '/chat/completions';
  }

  /**
   * Responses API endpoint path for this provider. For OpenAI-compatible
   * providers that only implement Chat Completions, the executor targets this
   * path; if the provider returns 404 the fallback layer handles it.
   * @param {object} provider
   * @returns {string}
   */
  responsesEndpoint(provider) {
    return '/responses';
  }

  /**
   * Extra request headers to merge into the HttpClient request. Subclasses
   * can override to add provider-specific headers (e.g. anthropic-version).
   * @param {object} provider
   * @param {object} [ctx]
   * @returns {object}
   */
  buildHeaders(provider, ctx = {}) {
    return {};
  }

  // ---------------------------------------------------------------
  // Chat Completions
  // ---------------------------------------------------------------

  /**
   * Build a provider-specific Chat Completions request body.
   * @param {object} provider - provider config
   * @param {object} input - validated client request body
   * @returns {object} provider request body
   */
  buildChatPayload(provider, input) {
    const payload = {
      model: input.model,
      messages: input.messages,
      stream: input.stream === true,
    };
    for (const key of CHAT_PASS_THROUGH) {
      if (input[key] !== undefined && input[key] !== null) {
        payload[key] = input[key];
      }
    }
    return payload;
  }

  /**
   * Normalize a provider Chat Completions response into the OpenAI
   * `chat.completion` shape that the gateway returns to the client.
   * @param {object} providerResponse - { status, headers, data }
   * @param {object} input - original client request body
   * @returns {object}
   */
  normalizeChatResponse(providerResponse, input) {
    const data = providerResponse && providerResponse.data;
    const model = input.model;

    if (data && typeof data === 'object' && data.object === 'chat.completion' && Array.isArray(data.choices)) {
      return data;
    }
    if (data && typeof data === 'object' && Array.isArray(data.choices)) {
      return { ...data, object: data.object || 'chat.completion' };
    }

    logger.warn('Provider response was not OpenAI-shaped, synthesizing minimal response', {
      model,
      keys: data && typeof data === 'object' ? Object.keys(data) : typeof data,
    });

    const content = (data && typeof data === 'object' && (data.content || data.text)) || '';
    return {
      id: `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  // ---------------------------------------------------------------
  // Embeddings API
  // ---------------------------------------------------------------

  /**
   * Embeddings endpoint path for this provider.
   * @param {object} provider
   * @returns {string}
   */
  embeddingsEndpoint(provider) {
    return '/embeddings';
  }

  /**
   * Build a provider-specific Embeddings request body.
   *
   * The OpenAI Embeddings API accepts:
   *   - model: string
   *   - input: string OR array of strings (or array of number arrays for
   *     token inputs; we forward strings only)
   *   - encoding_format: "float" | "base64" (optional)
   *   - dimensions: number (optional, when the provider supports it)
   *
   * OpenAI-compatible providers accept this shape verbatim, so the base
   * implementation is a pass-through that filters to the known fields.
   *
   * @param {object} provider - provider config
   * @param {object} input - validated client request body
   * @returns {object} provider request body
   */
  buildEmbeddingsPayload(provider, input) {
    const payload = {
      model: input.model,
      input: input.input,
    };
    if (input.encoding_format !== undefined && input.encoding_format !== null) {
      payload.encoding_format = input.encoding_format;
    }
    if (input.dimensions !== undefined && input.dimensions !== null) {
      payload.dimensions = input.dimensions;
    }
    return payload;
  }

  /**
   * Normalize a provider Embeddings response into the OpenAI `list` shape
   * that the gateway returns to the client.
   *
   * OpenAI response:
   *   {
   *     "object": "list",
   *     "data": [
   *       { "object": "embedding", "embedding": [...], "index": 0 },
   *       ...
   *     ],
   *     "model": "...",
   *     "usage": { "prompt_tokens": N, "total_tokens": N }
   *   }
   *
   * Some providers may return slightly different shapes (e.g. a bare array
   * of vectors). This method normalizes them into the canonical OpenAI
   * shape so the gateway's contract stays OpenAI-compatible.
   *
   * @param {object} providerResponse - { status, headers, data }
   * @param {object} input - original client request body
   * @returns {object}
   */
  normalizeEmbeddingsResponse(providerResponse, input) {
    const data = providerResponse && providerResponse.data;
    const model = input.model;

    if (data && typeof data === 'object' && data.object === 'list' && Array.isArray(data.data)) {
      // Already OpenAI-shaped — ensure the model field reflects the requested model.
      return { ...data, model };
    }

    if (data && typeof data === 'object' && Array.isArray(data.data)) {
      // Partial OpenAI shape (missing "object":"list"); normalize it.
      return {
        object: 'list',
        data: data.data,
        model,
        usage: data.usage || { prompt_tokens: 0, total_tokens: 0 },
      };
    }

    if (Array.isArray(data)) {
      // Bare array of embedding vectors — synthesize the full response.
      return {
        object: 'list',
        data: data.map((vec, index) => ({
          object: 'embedding',
          embedding: vec,
          index,
        })),
        model,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      };
    }

    logger.warn('Provider embeddings response was not OpenAI-shaped, synthesizing empty response', {
      model,
      keys: data && typeof data === 'object' ? Object.keys(data) : typeof data,
    });

    return {
      object: 'list',
      data: [],
      model,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  }

  // ---------------------------------------------------------------
  // Images API
  // ---------------------------------------------------------------

  /**
   * Images endpoint path for a given image operation.
   *
   * @param {object} provider
   * @param {string} operation - "images.generations" | "images.edits" | "images.variations"
   * @returns {string}
   */
  imagesEndpoint(provider, operation) {
    if (operation === 'images.edits') return '/images/edits';
    if (operation === 'images.variations') return '/images/variations';
    return '/images/generations';
  }

  /**
   * Build a provider-specific Images request body for the given operation.
   *
   * For "generations" the request is a JSON body:
   *   { model, prompt, n, size, quality, style, response_format, user }
   *
   * For "edits" and "variations" the request is multipart/form-data. The
   * adapter returns a FormData-like object that the HttpClient forwards
   * with the appropriate content-type. The base implementation builds an
   * OpenAI-compatible multipart form using the `form-data` library; the
   * fields are:
   *   - image (file, required)         [edits, variations]
   *   - mask  (file, optional)         [edits]
   *   - prompt (string, required)      [edits]
   *   - model, n, size, response_format, user  [all, optional]
   *
   * Adapters whose provider uses a different wire format override this.
   *
   * @param {object} provider - provider config
   * @param {object} input - validated client request (fields may include
   *   multer-parsed file buffers under `image` / `mask`)
   * @param {string} operation - "images.generations" | "images.edits" | "images.variations"
   * @returns {object|string} a JSON body (generations) or a FormData
   *   instance (edits/variations)
   */
  buildImagesPayload(provider, input, operation) {
    if (operation === 'images.generations') {
      return this._buildImagesGenerationsPayload(provider, input);
    }
    return this._buildImagesMultipartPayload(provider, input, operation);
  }

  /**
   * Build the JSON body for image generations (OpenAI-compatible).
   * @param {object} provider
   * @param {object} input
   * @returns {object}
   * @private
   */
  _buildImagesGenerationsPayload(provider, input) {
    const payload = { model: input.model, prompt: input.prompt };
    for (const key of ['n', 'size', 'quality', 'style', 'response_format', 'user']) {
      if (input[key] !== undefined && input[key] !== null) {
        payload[key] = input[key];
      }
    }
    return payload;
  }

  /**
   * Build a multipart/form-data body for image edits or variations.
   *
   * `input.image` and `input.mask` are expected to be multer file objects
   * (Buffer in `buffer`, filename in `originalname`, mime in `mimetype`).
   * The returned FormData is forwarded to the provider by the HttpClient,
   * which sets the multipart content-type header from the form.
   *
   * @param {object} provider
   * @param {object} input
   * @param {string} operation
   * @returns {FormData}
   * @private
   */
  _buildImagesMultipartPayload(provider, input, operation) {
    const FormData = require('form-data');
    const form = new FormData();

    // image (required for edits + variations)
    if (input.image && input.image.buffer) {
      form.append('image', input.image.buffer, {
        filename: input.image.originalname || 'image.png',
        contentType: input.image.mimetype || 'image/png',
      });
    }

    // mask (optional, edits only)
    if (operation === 'images.edits' && input.mask && input.mask.buffer) {
      form.append('mask', input.mask.buffer, {
        filename: input.mask.originalname || 'mask.png',
        contentType: input.mask.mimetype || 'image/png',
      });
    }

    // prompt (required for edits)
    if (operation === 'images.edits' && input.prompt !== undefined && input.prompt !== null) {
      form.append('prompt', String(input.prompt));
    }

    for (const key of ['model', 'n', 'size', 'response_format', 'user']) {
      if (input[key] !== undefined && input[key] !== null) {
        form.append(key, String(input[key]));
      }
    }
    return form;
  }

  /**
   * Normalize a provider Images response into the OpenAI `images` shape
   * that the gateway returns to the client.
   *
   * OpenAI response:
   *   {
   *     "created": 1700000000,
   *     "data": [
   *       { "url": "https://..." }              // or
   *       { "b64_json": "iVBORw0KGgo..." }
   *     ]
   *   }
   *
   * Some providers may return the image data under different keys (e.g.
   * `b64` instead of `b64_json`, or a bare array of strings). This method
   * normalizes them into the canonical OpenAI shape so the gateway's
   * contract stays OpenAI-compatible.
   *
   * @param {object} providerResponse - { status, headers, data }
   * @param {object} input - original client request body
   * @returns {object}
   */
  normalizeImagesResponse(providerResponse, input) {
    const data = providerResponse && providerResponse.data;

    if (data && typeof data === 'object' && typeof data.created === 'number' && Array.isArray(data.data)) {
      return {
        created: data.created,
        data: data.data.map((item, index) => this._normalizeImageItem(item, index)),
      };
    }

    if (data && typeof data === 'object' && Array.isArray(data.data)) {
      return {
        created: data.created || Math.floor(Date.now() / 1000),
        data: data.data.map((item, index) => this._normalizeImageItem(item, index)),
      };
    }

    if (Array.isArray(data)) {
      return {
        created: Math.floor(Date.now() / 1000),
        data: data.map((item, index) => this._normalizeImageItem(item, index)),
      };
    }

    logger.warn('Provider images response was not OpenAI-shaped, synthesizing empty response', {
      model: input.model,
      keys: data && typeof data === 'object' ? Object.keys(data) : typeof data,
    });

    return {
      created: Math.floor(Date.now() / 1000),
      data: [],
    };
  }

  /**
   * Normalize a single image item into the OpenAI `{ url } | { b64_json }`
   * shape. Handles common provider variations.
   * @param {*} item
   * @param {number} index
   * @returns {object}
   * @private
   */
  _normalizeImageItem(item, index) {
    if (item && typeof item === 'object') {
      if (typeof item.url === 'string') return { url: item.url };
      if (typeof item.b64_json === 'string') return { b64_json: item.b64_json };
      if (typeof item.b64 === 'string') return { b64_json: item.b64 };
      if (typeof item.image === 'string') return { b64_json: item.image };
      if (typeof item.data === 'string') return { b64_json: item.data };
    }
    if (typeof item === 'string') {
      if (/^https?:\/\//.test(item)) return { url: item };
      return { b64_json: item };
    }
    return {};
  }

  // ---------------------------------------------------------------
  // Audio API
  // ---------------------------------------------------------------

  /**
   * Audio endpoint path for a given audio operation.
   *
   * @param {object} provider
   * @param {string} operation - "audio.speech" | "audio.transcriptions" | "audio.translations"
   * @returns {string}
   */
  audioEndpoint(provider, operation) {
    if (operation === 'audio.transcriptions') return '/audio/transcriptions';
    if (operation === 'audio.translations') return '/audio/translations';
    return '/audio/speech';
  }

  /**
   * Whether the audio operation returns a BINARY response (raw audio bytes)
   * rather than a JSON body. The route uses this to decide between
   * `res.send(buffer)` and `res.json(body)`.
   *
   * Speech returns raw audio bytes for the non-JSON response formats
   * (mp3, opus, aac, flac, wav, pcm). When `response_format` is "json"
   * (or unset on OpenAI for speech — though OpenAI defaults to mp3), the
   * provider returns raw audio. Only verbose_json returns a JSON body.
   *
   * @param {object} input - validated client request body
   * @param {string} operation
   * @returns {boolean}
   */
  isAudioBinaryResponse(input, operation) {
    if (operation !== 'audio.speech') return false;
    const fmt = input && input.response_format;
    // "json" and "verbose_json" are JSON bodies; everything else is binary.
    // OpenAI's default for speech is "mp3" (binary), so when unset we treat
    // the response as binary.
    return fmt !== 'json' && fmt !== 'verbose_json';
  }

  /**
   * Build a provider-specific Audio request body for the given operation.
   *
   * - "audio.speech": JSON body `{ model, input, voice, response_format, speed }`
   * - "audio.transcriptions" / "audio.translations": multipart/form-data
   *   with the `file` (audio file) plus `model`, `language`, `prompt`,
   *   `response_format`, `temperature` fields as applicable.
   *
   * @param {object} provider - provider config
   * @param {object} input - validated client request (file buffers under
   *   `input.file` for transcriptions/translations)
   * @param {string} operation - "audio.speech" | "audio.transcriptions" | "audio.translations"
   * @returns {object|FormData} a JSON body (speech) or a FormData instance
   *   (transcriptions/translations)
   */
  buildAudioPayload(provider, input, operation) {
    if (operation === 'audio.speech') {
      return this._buildAudioSpeechPayload(provider, input);
    }
    return this._buildAudioMultipartPayload(provider, input, operation);
  }

  /**
   * Build the JSON body for text-to-speech (OpenAI-compatible).
   * @param {object} provider
   * @param {object} input
   * @returns {object}
   * @private
   */
  _buildAudioSpeechPayload(provider, input) {
    const payload = {
      model: input.model,
      input: input.input,
      voice: input.voice,
    };
    if (input.response_format !== undefined && input.response_format !== null) {
      payload.response_format = input.response_format;
    }
    if (input.speed !== undefined && input.speed !== null) {
      payload.speed = input.speed;
    }
    return payload;
  }

  /**
   * Build a multipart/form-data body for audio transcriptions or
   * translations. Reuses the same multipart construction approach as the
   * Images API (`_buildImagesMultipartPayload`).
   *
   * `input.file` is expected to be a multer file object (Buffer in `buffer`,
   * filename in `originalname`, mime in `mimetype`).
   *
   * @param {object} provider
   * @param {object} input
   * @param {string} operation - "audio.transcriptions" | "audio.translations"
   * @returns {FormData}
   * @private
   */
  _buildAudioMultipartPayload(provider, input, operation) {
    const FormData = require('form-data');
    const form = new FormData();

    // file (required)
    if (input.file && input.file.buffer) {
      form.append('file', input.file.buffer, {
        filename: input.file.originalname || 'audio.mp3',
        contentType: input.file.mimetype || 'audio/mpeg',
      });
    }

    // model (required)
    form.append('model', String(input.model));

    // language (transcriptions only; translations always translate to English)
    if (operation === 'audio.transcriptions'
      && input.language !== undefined && input.language !== null) {
      form.append('language', String(input.language));
    }

    // prompt (optional context for both)
    if (input.prompt !== undefined && input.prompt !== null) {
      form.append('prompt', String(input.prompt));
    }

    // response_format (optional)
    if (input.response_format !== undefined && input.response_format !== null) {
      form.append('response_format', String(input.response_format));
    }

    // temperature (optional)
    if (input.temperature !== undefined && input.temperature !== null) {
      form.append('temperature', String(input.temperature));
    }
    return form;
  }

  /**
   * Normalize a provider Audio response into the OpenAI shape that the
   * gateway returns to the client.
   *
   * - Speech: the provider returns raw audio bytes (Buffer). The adapter
   *   passes them through unchanged; the route writes them directly with the
   *   appropriate Content-Type.
   * - Transcriptions / Translations: the provider returns a JSON object
   *   `{ text: "..." }` (or `verbose_json` with additional metadata). The
   *   adapter normalizes alternative shapes (e.g. a bare string) into the
   *   canonical `{ text }` form.
   *
   * @param {object} providerResponse - { status, headers, data }
   * @param {object} input - original client request body
   * @param {string} operation - "audio.speech" | "audio.transcriptions" | "audio.translations"
   * @returns {Buffer|object} raw audio Buffer (speech) or a JSON object
   *   (transcriptions/translations)
   */
  normalizeAudioResponse(providerResponse, input, operation) {
    const data = providerResponse && providerResponse.data;

    // Speech returns raw audio bytes for audio formats, but a JSON object
    // when response_format is "json" / "verbose_json". Only coerce to a
    // Buffer when a binary response is expected; otherwise pass the JSON
    // body through unchanged.
    if (operation === 'audio.speech') {
      if (this.isAudioBinaryResponse(input, operation)) {
        if (Buffer.isBuffer(data)) return data;
        if (data instanceof ArrayBuffer) return Buffer.from(data);
        if (Array.isArray(data)) {
          return Buffer.concat(data.map((b) => Buffer.isBuffer(b) ? b : Buffer.from(String(b))));
        }
        if (typeof data === 'string') return Buffer.from(data);
        return Buffer.from(typeof data === 'undefined' ? '' : String(data));
      }
      // JSON response_format — pass the provider's JSON body through.
      if (data && typeof data === 'object') return data;
      if (typeof data === 'string') {
        try { return JSON.parse(data); } catch { return { text: data }; }
      }
      return { text: '' };
    }

    // Transcriptions / translations return { text } JSON.
    if (data && typeof data === 'object' && typeof data.text === 'string') {
      return data;
    }

    // Some providers return a bare string (the transcript).
    if (typeof data === 'string') {
      return { text: data };
    }

    logger.warn('Provider audio response was not OpenAI-shaped, synthesizing empty response', {
      model: input.model,
      operation,
      keys: data && typeof data === 'object' ? Object.keys(data) : typeof data,
    });

    return { text: '' };
  }

  // ---------------------------------------------------------------
  // Responses API
  // ---------------------------------------------------------------

  /**
   * Translate a Responses API request into a provider Chat Completions
   * payload. The Responses API is a higher-level abstraction; for
   * OpenAI-compatible providers we always send Chat Completions to the
   * provider and translate the response back.
   * @param {object} provider - provider config
   * @param {object} input - validated Responses request body
   * @returns {object} provider request body
   */
  buildResponsesPayload(provider, input) {
    const messages = [];

    if (input.instructions) {
      messages.push({ role: 'system', content: input.instructions });
    }

    if (typeof input.input === 'string') {
      messages.push({ role: 'user', content: input.input });
    } else if (Array.isArray(input.input)) {
      for (const item of input.input) {
        if (typeof item === 'string') {
          messages.push({ role: 'user', content: item });
        } else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const role = item.role || 'user';
          const content = item.content !== undefined ? item.content : '';
          messages.push({ role, content });
        } else {
          messages.push({ role: 'user', content: String(item) });
        }
      }
    }

    const payload = {
      model: input.model,
      messages,
      stream: input.stream === true,
    };

    if (input.temperature !== undefined && input.temperature !== null) {
      payload.temperature = input.temperature;
    }
    if (input.max_output_tokens !== undefined && input.max_output_tokens !== null) {
      payload.max_tokens = input.max_output_tokens;
    }
    return payload;
  }

  /**
   * Normalize a provider Chat Completions response into the OpenAI
   * Responses API `response` shape.
   * @param {object} providerResponse - { status, headers, data }
   * @param {object} input - original client request body
   * @returns {object}
   */
  normalizeResponsesResponse(providerResponse, input) {
    const data = providerResponse && providerResponse.data;
    const model = input.model;
    const now = Math.floor(Date.now() / 1000);

    if (data && typeof data === 'object' && data.object === 'response' && Array.isArray(data.output)) {
      return data;
    }

    let outputText = '';
    let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

    if (data && typeof data === 'object') {
      if (Array.isArray(data.choices) && data.choices[0]) {
        const choice = data.choices[0];
        outputText = (choice.message && choice.message.content) || '';
      }
      if (data.usage && typeof data.usage === 'object') {
        usage = {
          input_tokens: data.usage.prompt_tokens || 0,
          output_tokens: data.usage.completion_tokens || 0,
          total_tokens: data.usage.total_tokens || 0,
        };
      }
    } else if (typeof data === 'string') {
      outputText = data;
    } else if (data && typeof data === 'object' && (data.content || data.text)) {
      outputText = data.content || data.text;
    }

    if (!outputText) {
      logger.warn('Responses API: empty provider output, synthesizing empty response', { model });
    }

    return {
      id: `resp_${crypto.randomBytes(12).toString('hex')}`,
      object: 'response',
      created_at: now,
      model,
      status: 'completed',
      output: [
        {
          type: 'message',
          id: `msg_${crypto.randomBytes(12).toString('hex')}`,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: outputText }],
        },
      ],
      usage,
    };
  }

  // ---------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------

  /**
   * Translate a parsed provider SSE event into an array of OpenAI
   * chat.completion.chunk-shaped SSE events to forward to the client (Chat
   * Completions endpoint). The base implementation passes the chunk through
   * as-is and normalizes the model field. Providers with non-OpenAI streaming
   * formats override this.
   *
   * @param {object} parsedEvent - { data: string } from StreamParser
   * @param {object} ctx - { model, requestId, endpoint }
   * @returns {Array<{data: string}>} SSE events to write to the client
   */
  adaptChatStreamChunk(parsedEvent, ctx) {
    if (parsedEvent.data === '[DONE]') return [{ data: '[DONE]' }];
    let chunk;
    try {
      chunk = JSON.parse(parsedEvent.data);
    } catch {
      return [];
    }
    if (chunk && chunk.model !== undefined) {
      chunk.model = ctx.model;
    }
    return [{ data: JSON.stringify(chunk) }];
  }

  /**
   * Whether the provider's streaming SSE format matches the OpenAI Chat
   * Completions chunk shape. If false, the StreamingResponseAdapter will
   * call `adaptChatStreamChunk` to translate. Default: true (OpenAI-compat).
   * @returns {boolean}
   */
  isChatStreamOpenAICompatible() {
    return true;
  }
}

module.exports = ProviderAdapter;
module.exports.DEFAULT_CAPABILITIES = DEFAULT_CAPABILITIES;
module.exports.CHAT_PASS_THROUGH = CHAT_PASS_THROUGH;
