const crypto = require('crypto');
const logger = require('../utils/logger');

const DONE = '[DONE]';

/**
 * StreamingResponseAdapter
 *
 * Translates provider SSE events (Chat Completions streaming format) into the
 * SSE format expected by the gateway endpoint. This keeps the translation
 * logic separate from the transport (SSEWriter) and the protocol (StreamParser),
 * so each endpoint can have its own adapter without duplicating transport code.
 *
 * The adapter is stateful: it accumulates state across events (e.g. response
 * id, created timestamp) so it can synthesize a consistent stream even when
 * the provider's events are minimal.
 *
 * Two modes are supported via the `endpoint` option:
 *   - "chat/completions": pass-through — provider chat.completion.chunk
 *     events are forwarded to the client as-is.
 *   - "responses": translate — provider chat.completion.chunk events are
 *     converted into OpenAI Responses API streaming events
 *     (response.created, response.output_item.added, ...).
 */
class StreamingResponseAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint - "chat/completions" or "responses"
   * @param {string} opts.model - requested model id
   * @param {object} [opts.ctx] - request context (requestId, providerId, ...)
   */
  constructor({ endpoint, model, ctx = {} }) {
    this.endpoint = endpoint;
    this.model = model;
    this.ctx = ctx;
    this.responseId = this._genId(endpoint);
    this.messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;
    this.createdAt = Math.floor(Date.now() / 1000);
    this.started = false;
    this.contentBuffer = '';
    this.usage = null;
    this.providerAdapter = null;
  }

  /**
   * Set the provider adapter for the current provider so non-OpenAI streaming
   * formats can be translated. Called by RequestExecutor before piping.
   * @param {object} adapter - ProviderAdapter instance
   */
  setProviderAdapter(adapter) {
    this.providerAdapter = adapter;
  }

  _genId(endpoint) {
    const prefix = endpoint === 'responses' ? 'resp_' : 'chatcmpl-';
    return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
  }

  /**
   * Convert a parsed provider SSE event into one or more SSE events to write
   * to the client. Returns an array of { data: string } events, or an empty
   * array if the event should be skipped.
   *
   * @param {object} parsed - { data: string } from StreamParser
   * @returns {Array<{data: string}>}
   */
  adapt(parsed) {
    if (parsed.data === DONE) {
      return this._adaptDone();
    }

    // If the provider's streaming format is NOT OpenAI-compatible (e.g.
    // Anthropic's Messages streaming), let the provider adapter translate the
    // raw SSE event into OpenAI chat.completion.chunk events first.
    if (this.providerAdapter && !this.providerAdapter.isChatStreamOpenAICompatible()) {
      const streamCtx = {
        model: this.model,
        requestId: this.ctx.requestId,
        responseId: this.responseId,
        createdAt: this.createdAt,
      };
      const openAIEvents = this.providerAdapter.adaptChatStreamChunk(parsed, streamCtx);
      // Each emitted event is an OpenAI chat.completion.chunk. Forward them
      // through the appropriate endpoint translator (chat pass-through or
      // responses translation).
      const out = [];
      for (const ev of openAIEvents) {
        if (ev.data === DONE) { out.push(ev); continue; }
        let chunk;
        try { chunk = JSON.parse(ev.data); } catch { continue; }
        if (this.endpoint === 'responses') {
          out.push(...this._adaptResponsesChunk(chunk));
        } else {
          out.push({ data: JSON.stringify(chunk) });
        }
      }
      return out;
    }

    let chunk;
    try {
      chunk = JSON.parse(parsed.data);
    } catch {
      logger.warn('Stream adapter: could not parse SSE JSON', {
        requestId: this.ctx.requestId,
        data: parsed.data,
      });
      return [];
    }

    if (this.endpoint === 'responses') {
      return this._adaptResponsesChunk(chunk);
    }
    return this._adaptChatChunk(chunk);
  }

  // --- Chat Completions pass-through ---

  _adaptChatChunk(chunk) {
    // Forward the provider's chunk as-is, but normalize the model field so the
    // client sees the model they requested.
    if (chunk && chunk.model !== undefined) {
      chunk.model = this.model;
    }
    return [{ data: JSON.stringify(chunk) }];
  }

  // --- Responses API translation ---

  _adaptResponsesChunk(chunk) {
    const events = [];

    if (!this.started) {
      this.started = true;
      events.push({
        data: JSON.stringify({
          type: 'response.created',
          response: {
            id: this.responseId,
            object: 'response',
            created_at: this.createdAt,
            model: this.model,
            status: 'in_progress',
            output: [],
          },
        }),
      });
      events.push({
        data: JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'message',
            id: this.messageId,
            status: 'in_progress',
            role: 'assistant',
            content: [],
          },
        }),
      });
    }

    // Extract delta content from the chat completion chunk
    let deltaContent = '';
    let finishReason = null;

    if (chunk && Array.isArray(chunk.choices)) {
      const choice = chunk.choices[0];
      if (choice && choice.delta && typeof choice.delta.content === 'string') {
        deltaContent = choice.delta.content;
        this.contentBuffer += deltaContent;
      }
      if (choice && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
    if (chunk && chunk.usage) {
      this.usage = {
        input_tokens: chunk.usage.prompt_tokens || 0,
        output_tokens: chunk.usage.completion_tokens || 0,
        total_tokens: chunk.usage.total_tokens || 0,
      };
    }

    if (deltaContent) {
      events.push({
        data: JSON.stringify({
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: deltaContent,
        }),
      });
    }

    if (finishReason) {
      events.push({
        data: JSON.stringify({
          type: 'response.output_text.done',
          output_index: 0,
          content_index: 0,
          text: this.contentBuffer,
        }),
      });
      events.push({
        data: JSON.stringify({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: this.messageId,
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: this.contentBuffer }],
          },
        }),
      });
      events.push({
        data: JSON.stringify({
          type: 'response.completed',
          response: {
            id: this.responseId,
            object: 'response',
            created_at: this.createdAt,
            model: this.model,
            status: 'completed',
            output: [
              {
                type: 'message',
                id: this.messageId,
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: this.contentBuffer }],
              },
            ],
            usage: this.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          },
        }),
      });
    }

    return events;
  }

  _adaptDone() {
    // For chat completions, [DONE] is forwarded as-is.
    // For responses, the completed event was already emitted on finish_reason;
    // but if the provider sends [DONE] without a finish_reason, synthesize the
    // closing events here.
    if (this.endpoint === 'responses') {
      if (this.started) {
        return [{ data: DONE }];
      }
      // Provider sent [DONE] without any chunks — synthesize an empty response
      return this._adaptResponsesChunk({ choices: [{ finish_reason: 'stop' }] }).concat([{ data: DONE }]);
    }
    return [{ data: DONE }];
  }
}

module.exports = StreamingResponseAdapter;
