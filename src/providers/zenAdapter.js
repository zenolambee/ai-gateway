const ProviderAdapter = require('./providerAdapter');
const logger = require('../utils/logger');

/**
 * ZenAdapter
 *
 * Adapter for the "Zen" gateway at https://opencode.ai/zen/v1.
 *
 * Zen implements Chat Completions with full tool calling, but its
 * Responses API endpoint rejects `tools` (upstream sglang validation) and
 * streaming is flaky with the Responses wire format. To keep tool calling
 * working for Responses API clients (e.g. Codex), this adapter:
 *
 *   - routes `responses` operations to the chat completions path
 *   - maps Responses input items (message / function_call /
 *     function_call_output) to chat messages (incl. assistant tool_calls)
 *   - maps chat completions responses back into the Responses API shape
 *     (message + function_call output items)
 *
 * Streaming is handled by the shared StreamingResponseAdapter, which feeds
 * chat.completion.chunk events through this adapter via
 * `adaptResponsesChunk` when the endpoint is "responses".
 */
class ZenAdapter extends ProviderAdapter {
  static get id() { return 'zen'; }

  capabilities() {
    return {
      supportsChat: true,
      supportsResponses: true,
      supportsStreaming: true,
      supportsEmbeddings: false,
      supportsImages: false,
      supportsAudio: false,
      supportsTools: true,
      supportsReasoning: true,
    };
  }

  responsesEndpoint() {
    return '/chat/completions';
  }

  /**
   * Convert Responses API input items into chat messages. Consecutive
   * function_call items are coalesced into one assistant message carrying
   * multiple tool_calls (chat format requires tool responses to follow the
   * tool_calls message).
   * @param {object} input - gateway responses request body
   * @returns {Array<object>} chat messages
   */
  _chatMessages(input) {
    const messages = [];
    if (input.instructions) {
      messages.push({ role: 'system', content: input.instructions });
    }

    if (typeof input.input === 'string') {
      messages.push({ role: 'user', content: input.input });
      return messages;
    }
    if (!Array.isArray(input.input)) return messages;

    let pendingCalls = [];
    const flush = () => {
      if (pendingCalls.length === 0) return;
      const calls = pendingCalls.map((item) => {
        let args = item.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        return {
          id: item.call_id || item.id || `call_${Math.random().toString(36).slice(2, 14)}`,
          type: 'function',
          function: {
            name: item.name || '',
            arguments: JSON.stringify(args || {}),
          },
        };
      });
      messages.push({ role: 'assistant', content: null, tool_calls: calls });
      pendingCalls = [];
    };

    for (const item of input.input) {
      if (typeof item === 'string') {
        flush();
        messages.push({ role: 'user', content: item });
        continue;
      }
      if (!item || typeof item !== 'object') {
        flush();
        messages.push({ role: 'user', content: String(item) });
        continue;
      }
      const itype = item.type || 'message';
      if (itype === 'function_call') {
        pendingCalls.push(item);
      } else if (itype === 'function_call_output') {
        flush();
        let out = item.output !== undefined ? item.output : '';
        if (Array.isArray(out)) {
          const parts = [];
          let imgs = 0;
          for (const c of out) {
            if (c && typeof c === 'object' && c.type === 'input_image') imgs += 1;
            else if (c && typeof c === 'object' && c.text) parts.push(c.text);
            else parts.push(typeof c === 'string' ? c : JSON.stringify(c));
          }
          if (imgs) parts.push(`[${imgs} image(s) omitted - images not supported upstream]`);
          out = parts.join('\n');
        } else if (typeof out !== 'string') {
          out = JSON.stringify(out);
        }
        if (out.length > 1500) {
          logger.info('ZenAdapter: tool output truncated', { len: out.length });
          out = `${out.slice(0, 1500)}\n...[output truncated: ${out.length} chars]`;
        }
        messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: out });
      } else {
        flush();
        const role = item.role === 'developer' ? 'system' : (item.role || 'user');
        let content = item.content !== undefined ? item.content : '';
        if (Array.isArray(content)) {
          content = content
            .filter((c) => c && typeof c === 'object')
            .map((c) => (c.text !== undefined ? c.text : ''))
            .filter((t) => t !== '')
            .join('\n');
        }
        messages.push({ role, content: String(content) });
      }
    }
    flush();
    return messages;
  }

  buildResponsesPayload(provider, input) {
    const messages = this._chatMessages(input);
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
    if (Array.isArray(input.tools) && input.tools.length > 0) {
      payload.tools = input.tools
        .map((t) => {
          if (t && typeof t === 'object' && t.function && typeof t.function === 'object') {
            const name = (t.function.name || '').trim();
            if (!name || name === 'unknown') return null;
            return t;
          }
          if (t && typeof t === 'object' && t.name && t.name.trim()) {
            return { type: 'function', function: t };
          }
          return null;
        })
        .filter(Boolean);
      if (payload.tools.length === 0) delete payload.tools;
    }
    if (input.tool_choice !== undefined && input.tool_choice !== null) {
      payload.tool_choice = input.tool_choice;
    }
    return payload;
  }

  /**
   * Normalize a chat completions response into a Responses API body.
   * Handles assistant text plus tool_calls (function_call items).
   */
  normalizeResponsesResponse(providerResponse, input) {
    const data = providerResponse && providerResponse.data;
    const requestedModel = input.model;
    const now = Math.floor(Date.now() / 1000);

    if (data && typeof data === 'object' && data.object === 'response' && Array.isArray(data.output)) {
      return data;
    }

    const output = [];
    let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    if (data && typeof data === 'object' && data.usage) {
      usage = {
        input_tokens: data.usage.prompt_tokens || 0,
        output_tokens: data.usage.completion_tokens || 0,
        total_tokens: data.usage.total_tokens || 0,
      };
    }

    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const message = (choice && choice.message) || choice || {};
    const text = message.content || '';

    if (text) {
      output.push({
        type: 'message',
        id: `msg_${Math.random().toString(36).slice(2, 14)}`,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      });
    }

    for (const tc of message.tool_calls || []) {
      const fn = tc.function || {};
      let args = fn.arguments;
      if (typeof args !== 'string') {
        args = JSON.stringify(args || {});
      }
      const id = tc.id || `call_${Math.random().toString(36).slice(2, 14)}`;
      output.push({
        type: 'function_call',
        id,
        call_id: id,
        name: fn.name || '',
        arguments: args,
        status: 'completed',
      });
    }

    return {
      id: `resp_${Math.random().toString(36).slice(2, 14)}`,
      object: 'response',
      created_at: now,
      model: requestedModel,
      status: 'completed',
      output,
      usage,
    };
  }

  /**
   * Translate one chat.completion.chunk (from the zen stream) into
   * Responses API SSE events. Called by StreamingResponseAdapter for
   * endpoints === 'responses'.
   */
  adaptApiChunk(chunk, ctx) {
    return [chunk];
  }

  /**
   * Whether provider SSE matches OpenAI chat chunk shape.
   */
  isChatStreamOpenAICompatible() {
    return true;
  }
}

module.exports = ZenAdapter;