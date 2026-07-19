const crypto = require('crypto');
const logger = require('../utils/logger');
const ProviderAdapter = require('./providerAdapter');

/**
 * AnthropicAdapter
 *
 * Adapter for Anthropic's Messages API (https://api.anthropic.com/v1).
 *
 * Anthropic's wire format differs from OpenAI Chat Completions:
 *
 *   - Endpoint is `/messages` (not `/chat/completions`)
 *   - The `system` message is a top-level `system` string, not an item in
 *     `messages`
 *   - Each message has `role` (only `user` / `assistant`) and `content`
 *     (string or array of {type, text})
 *   - Required params: `model`, `messages`, `max_tokens`
 *   - Auth header is `x-api-key` + `anthropic-version` header (the HttpClient
 *     sets the `Authorization: Bearer` from the apiKeys; we translate it here
 *     by emitting the x-api-key header and letting the provider config's
 *     `headers` carry `anthropic-version`).
 *   - Response shape: { id, type: "message", role: "assistant",
 *     content: [{type:"text", text:"..."}], stop_reason, usage }
 *
 * This adapter translates OpenAI Chat Completions requests/responses to and
 * from the Anthropic Messages API format, so the gateway's external contract
 * stays OpenAI-compatible.
 *
 * NO retry, NO fallback, NO HTTP — pure mapping only.
 */
class AnthropicAdapter extends ProviderAdapter {
  static get id() { return 'anthropic'; }

  capabilities() {
    return {
      supportsChat: true,
      supportsResponses: false,
      supportsStreaming: true,
      supportsEmbeddings: false,
      supportsImages: false,
      supportsAudio: false,
      supportsTools: true,
      supportsReasoning: true,
    };
  }

  /**
   * Anthropic uses the Messages API endpoint, not /chat/completions.
   */
  chatEndpoint(provider) {
    return provider.chatPath || '/messages';
  }

  /**
   * Anthropic has no native Responses API. The gateway translates Responses
   * requests into Chat Completions for the provider, so route them to the
   * same Messages endpoint.
   */
  responsesEndpoint(provider) {
    return this.chatEndpoint(provider);
  }

  /**
   * Anthropic requires x-api-key (not Bearer) and anthropic-version headers.
   * The provider config is expected to carry `anthropic-version` in `headers`;
   * we emit `x-api-key` here using the first configured key (the HttpClient
   * also sets an `Authorization: Bearer` header which Anthropic ignores).
   */
  buildHeaders(provider, ctx = {}) {
    const headers = {};
    const key = Array.isArray(provider.apiKeys) ? provider.apiKeys.find((k) => k) : null;
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = provider.anthropicVersion || '2023-06-01';
    return headers;
  }

  /**
   * Translate an OpenAI Chat Completions request into an Anthropic Messages
   * request body.
   *
   * Mapping:
   *   - system role messages -> top-level `system` string (joined)
   *   - user/assistant messages -> kept in `messages` (roles clamped to
   *     user/assistant); assistant messages with `tool_calls` are expanded
   *     into Anthropic `tool_use` content blocks; `tool` role messages
   *     become `user` messages with `tool_result` content blocks
   *   - max_tokens defaults to 1024 (Anthropic requires it)
   *   - temperature, top_p, stop -> forwarded
   *   - tools -> mapped from OpenAI `{type:"function",function:{name,
   *     description, parameters}}` to Anthropic `{name, description,
   *     input_schema}`
   *   - tool_choice -> mapped from OpenAI ("auto"|"none"|"required"|
   *     {type:"function",function:{name}}) to Anthropic
   *     ({type:"auto"}|{type:"any"}|{type:"tool",name})
   *   - parallel_tool_calls -> Anthropic `disable_parallel_tool_use` (inverted)
   */
  buildChatPayload(provider, input) {
    const messages = input.messages || [];
    const systemParts = [];
    const anthropicMessages = [];

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content) ? msg.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('') : '';
        if (text) systemParts.push(text);
      } else if (msg.role === 'tool') {
        // OpenAI tool result -> Anthropic user message with tool_result block
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          }],
        });
      } else if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        // OpenAI assistant with tool_calls -> Anthropic assistant message with
        // tool_use content blocks (plus any text content).
        const content = [];
        if (typeof msg.content === 'string' && msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          if (!tc || !tc.function) continue;
          let args = tc.function.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { /* keep string */ }
          }
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: args || {},
          });
        }
        anthropicMessages.push({ role: 'assistant', content });
      } else {
        anthropicMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        });
      }
    }

    const payload = {
      model: input.model,
      messages: anthropicMessages,
      max_tokens: input.max_tokens || 1024,
      stream: input.stream === true,
    };

    if (systemParts.length > 0) {
      payload.system = systemParts.join('\n\n');
    }
    if (input.temperature !== undefined && input.temperature !== null) {
      payload.temperature = input.temperature;
    }
    if (input.top_p !== undefined && input.top_p !== null) {
      payload.top_p = input.top_p;
    }
    if (input.stop !== undefined && input.stop !== null) {
      payload.stop_sequences = Array.isArray(input.stop) ? input.stop : [input.stop];
    }
    if (Array.isArray(input.tools) && input.tools.length > 0) {
      payload.tools = input.tools.map(this._mapOpenAIToolToAnthropic).filter(Boolean);
    }
    if (input.tool_choice !== undefined && input.tool_choice !== null) {
      payload.tool_choice = this._mapOpenAIToolChoiceToAnthropic(input.tool_choice);
    }
    if (input.parallel_tool_calls !== undefined && input.parallel_tool_calls !== null) {
      // OpenAI: parallel_tool_calls=true (allow parallel). Anthropic:
      // disable_parallel_tool_use=false (allow parallel). Inverted.
      if (payload.tool_choice && typeof payload.tool_choice === 'object') {
        payload.tool_choice.disable_parallel_tool_use = !input.parallel_tool_calls;
      }
    }
    return payload;
  }

  /**
   * Map an OpenAI tool definition to Anthropic's tool format.
   * OpenAI:   { type:"function", function:{ name, description, parameters } }
   * Anthropic:{ name, description, input_schema }
   * @param {object} tool
   * @returns {object|null}
   * @private
   */
  _mapOpenAIToolToAnthropic(tool) {
    if (!tool || !tool.function) return null;
    return {
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters || { type: 'object', properties: {} },
    };
  }

  /**
   * Map an OpenAI tool_choice to Anthropic's tool_choice format.
   *   "auto"     -> { type: "auto" }
   *   "none"     -> (omitted; Anthropic has no "none" — caller should not send tools)
   *   "required" -> { type: "any" }
   *   { type:"function", function:{ name } } -> { type:"tool", name }
   * @param {*} tc
   * @returns {object|undefined}
   * @private
   */
  _mapOpenAIToolChoiceToAnthropic(tc) {
    if (tc === 'auto') return { type: 'auto' };
    if (tc === 'none') return { type: 'auto' };
    if (tc === 'required') return { type: 'any' };
    if (tc && typeof tc === 'object' && tc.type === 'function' && tc.function) {
      return { type: 'tool', name: tc.function.name };
    }
    return undefined;
  }

  /**
   * Translate an Anthropic Messages response into the OpenAI Chat Completions
   * response shape.
   *
   * Anthropic response:
   *   { id, type:"message", role:"assistant",
   *     content:[{type:"text", text:"..."} | {type:"tool_use", id, name,
   *     input}], stop_reason, usage }
   *
   * OpenAI shape:
   *   { id, object:"chat.completion", model, choices:[{index, message,
   *     finish_reason}], usage:{prompt_tokens, completion_tokens, total_tokens} }
   *
   * Tool calls are mapped from Anthropic `tool_use` content blocks into
   * `message.tool_calls[]` with `id`, `type:"function"`, and
   * `function.name` / `function.arguments` (JSON string).
   */
  normalizeChatResponse(providerResponse, input) {
    const data = providerResponse && providerResponse.data;
    const model = input.model;

    // If the provider somehow returned an OpenAI-shaped body, forward as-is.
    if (data && typeof data === 'object' && data.object === 'chat.completion' && Array.isArray(data.choices)) {
      return data;
    }

    if (!data || typeof data !== 'object') {
      return {
        id: `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    }

    // Extract text + tool_use from content blocks
    let text = '';
    const toolCalls = [];
    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          text += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: typeof block.input === 'string'
                ? block.input
                : JSON.stringify(block.input || {}),
            },
          });
        }
      }
    } else if (typeof data.content === 'string') {
      text = data.content;
    }

    const finishReason = this._mapStopReason(data.stop_reason);
    const usage = {
      prompt_tokens: (data.usage && data.usage.input_tokens) || 0,
      completion_tokens: (data.usage && data.usage.output_tokens) || 0,
      total_tokens: ((data.usage && data.usage.input_tokens) || 0) + ((data.usage && data.usage.output_tokens) || 0),
    };

    const message = { role: 'assistant', content: text || null };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    return {
      id: data.id || `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, message, finish_reason: finishReason },
      ],
      usage,
    };
  }

  /**
   * Responses API is not supported by Anthropic directly; reuse the base
   * translation (which converts a Chat Completions response to a Responses
   * body after our normalizeChatResponse has produced OpenAI shape).
   */
  normalizeResponsesResponse(providerResponse, input) {
    const openAIResponse = { ...providerResponse, data: this.normalizeChatResponse(providerResponse, input) };
    return super.normalizeResponsesResponse(openAIResponse, input);
  }

  /**
   * Anthropic's streaming format uses `event:` + `data:` lines with event
   * types like content_block_delta, message_stop, etc. The gateway's
   * StreamParser already separates events; here we translate them into
   * OpenAI chat.completion.chunk events for the StreamingResponseAdapter.
   *
   * Tool-call streaming is mapped to incremental OpenAI tool_call deltas:
   *   - content_block_start (tool_use) -> delta.tool_calls[index] with id +
   *     function.name
   *   - input_json_delta -> delta.tool_calls[index].function.arguments
   *     (partial JSON string, exactly like OpenAI)
   *   - content_block_stop -> closes the tool call
   */
  isChatStreamOpenAICompatible() {
    return false;
  }

  adaptChatStreamChunk(parsedEvent, ctx) {
    if (parsedEvent.data === '[DONE]') return [{ data: '[DONE]' }];
    let evt;
    try { evt = JSON.parse(parsedEvent.data); } catch { return []; }

    const out = [];
    const chunk = {
      id: ctx.responseId || `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
      object: 'chat.completion.chunk',
      created: ctx.createdAt || Math.floor(Date.now() / 1000),
      model: ctx.model,
      choices: [],
    };

    switch (parsedEvent.event || evt.type) {
      case 'message_start':
        ctx.started = true;
        break;
      case 'content_block_start': {
        // tool_use block start -> emit tool_call id + function.name
        if (evt.content_block && evt.content_block.type === 'tool_use') {
          const idx = evt.index || 0;
          chunk.choices = [{
            index: 0,
            delta: {
              tool_calls: [{
                index: idx,
                id: evt.content_block.id,
                type: 'function',
                function: { name: evt.content_block.name, arguments: '' },
              }],
            },
            finish_reason: null,
          }];
          out.push({ data: JSON.stringify(chunk) });
        }
        break;
      }
      case 'content_block_delta':
        if (evt.delta && evt.delta.type === 'text_delta' && typeof evt.delta.text === 'string') {
          chunk.choices = [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }];
          out.push({ data: JSON.stringify(chunk) });
        } else if (evt.delta && evt.delta.type === 'input_json_delta' && typeof evt.delta.partial_json === 'string') {
          // Tool argument fragment -> OpenAI arguments delta
          const idx = evt.index || 0;
          chunk.choices = [{
            index: 0,
            delta: {
              tool_calls: [{
                index: idx,
                function: { arguments: evt.delta.partial_json },
              }],
            },
            finish_reason: null,
          }];
          out.push({ data: JSON.stringify(chunk) });
        }
        break;
      case 'message_delta':
        if (evt.delta && evt.delta.stop_reason) {
          chunk.choices = [{ index: 0, delta: {}, finish_reason: this._mapStopReason(evt.delta.stop_reason) }];
          out.push({ data: JSON.stringify(chunk) });
        }
        break;
      case 'message_stop':
        out.push({ data: '[DONE]' });
        break;
      default:
        // ignore other Anthropic events (ping, content_block_stop, ...)
        break;
    }
    return out;
  }

  _mapStopReason(reason) {
    switch (reason) {
      case 'end_turn': return 'stop';
      case 'stop_sequence': return 'stop';
      case 'max_tokens': return 'length';
      case 'tool_use': return 'tool_calls';
      default: return 'stop';
    }
  }
}

module.exports = AnthropicAdapter;
