const crypto = require('crypto');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

/**
 * Validate an OpenAI-compatible Chat Completions request body.
 *
 * Required:
 *   - model: non-empty string
 *   - messages: non-empty array of message objects
 *
 * Optional (tool calling):
 *   - tools: array of function tool definitions
 *   - tool_choice: "auto" | "none" | "required" | { type:"function", function:{ name } }
 *   - parallel_tool_calls: boolean
 *
 * @param {object} body
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateChatRequest(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }

  if (!body.model || typeof body.model !== 'string' || body.model.trim() === '') {
    errors.push("'model' is required and must be a non-empty string");
  }

  if (body.messages === undefined || body.messages === null) {
    errors.push("'messages' is required");
  } else if (!Array.isArray(body.messages)) {
    errors.push("'messages' must be an array");
  } else if (body.messages.length === 0) {
    errors.push("'messages' must contain at least one message");
  } else {
    for (let i = 0; i < body.messages.length; i += 1) {
      const msg = body.messages[i];
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        errors.push(`messages[${i}] must be an object`);
        continue;
      }
      if (!msg.role || typeof msg.role !== 'string') {
        errors.push(`messages[${i}].role is required and must be a string`);
      }

      // content rules vary by role:
      //   - assistant: content may be null when tool_calls is present
      //   - tool:      content must be a string, tool_call_id required
      //   - system/user: content must be a string or array
      const isAssistant = msg.role === 'assistant';
      const isTool = msg.role === 'tool';
      const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

      if (isTool) {
        if (typeof msg.content !== 'string') {
          errors.push(`messages[${i}].content must be a string for role 'tool'`);
        }
        if (!msg.tool_call_id || typeof msg.tool_call_id !== 'string') {
          errors.push(`messages[${i}].tool_call_id is required for role 'tool'`);
        }
      } else if (isAssistant && hasToolCalls) {
        // content may be null or a string when tool_calls present
        if (msg.content !== null && msg.content !== undefined
          && typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
          errors.push(`messages[${i}].content must be a string, array, or null`);
        }
        for (let t = 0; t < msg.tool_calls.length; t += 1) {
          const tc = msg.tool_calls[t];
          if (!tc || typeof tc !== 'object') {
            errors.push(`messages[${i}].tool_calls[${t}] must be an object`);
            continue;
          }
          if (!tc.id || typeof tc.id !== 'string') {
            errors.push(`messages[${i}].tool_calls[${t}].id is required`);
          }
          if (tc.type && tc.type !== 'function') {
            errors.push(`messages[${i}].tool_calls[${t}].type must be 'function'`);
          }
          if (!tc.function || typeof tc.function !== 'object'
            || !tc.function.name || typeof tc.function.name !== 'string') {
            errors.push(`messages[${i}].tool_calls[${t}].function.name is required`);
          }
        }
      } else {
        if (
          msg.content === undefined ||
          msg.content === null ||
          (typeof msg.content !== 'string' && !Array.isArray(msg.content))
        ) {
          errors.push(`messages[${i}].content must be a string or array`);
        }
      }
    }
  }

  // tools: array of function definitions
  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) {
      errors.push("'tools' must be an array");
    } else {
      for (let i = 0; i < body.tools.length; i += 1) {
        const tool = body.tools[i];
        if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
          errors.push(`tools[${i}] must be an object`);
          continue;
        }
        if (tool.type && tool.type !== 'function') {
          errors.push(`tools[${i}].type must be 'function'`);
        }
        if (!tool.function || typeof tool.function !== 'object') {
          errors.push(`tools[${i}].function is required and must be an object`);
          continue;
        }
        if (!tool.function.name || typeof tool.function.name !== 'string') {
          errors.push(`tools[${i}].function.name is required and must be a string`);
        }
        if (tool.function.parameters !== undefined && tool.function.parameters !== null) {
          if (typeof tool.function.parameters !== 'object' || Array.isArray(tool.function.parameters)) {
            errors.push(`tools[${i}].function.parameters must be a JSON schema object`);
          }
        }
      }
    }
  }

  // tool_choice: "auto" | "none" | "required" | { type:"function", function:{ name } }
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    const tc = body.tool_choice;
    if (tc === 'auto' || tc === 'none' || tc === 'required') {
      // valid string form
    } else if (tc && typeof tc === 'object' && !Array.isArray(tc)) {
      if (tc.type !== 'function') {
        errors.push("'tool_choice.type' must be 'function'");
      }
      if (!tc.function || typeof tc.function !== 'object'
        || !tc.function.name || typeof tc.function.name !== 'string') {
        errors.push("'tool_choice.function.name' is required");
      }
    } else {
      errors.push("'tool_choice' must be 'auto', 'none', 'required', or { type:'function', function:{ name } }");
    }
  }

  // parallel_tool_calls: boolean
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null) {
    if (typeof body.parallel_tool_calls !== 'boolean') {
      errors.push("'parallel_tool_calls' must be a boolean");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * ChatCompletionsService
 *
 * A thin service that validates the request and delegates everything else
 * (routing, payload mapping, response normalization, retry, fallback,
 * streaming) to the shared RequestExecutor, which in turn delegates the
 * provider-specific translation to the ProviderAdapter resolved per provider.
 *
 * This service owns only the gateway-facing contract (request validation
 * and the "chat" operation label). No provider knowledge lives here.
 */
class ChatCompletionsService {
  /**
   * @param {object} deps
   * @param {object} deps.requestExecutor - RequestExecutor instance
   */
  constructor({ requestExecutor }) {
    if (!requestExecutor) throw new Error('ChatCompletionsService requires a requestExecutor');
    this.requestExecutor = requestExecutor;
  }

  /**
   * Determine whether the request asks for tool calling. When tools or
   * tool_choice are present, the executor must only consider providers whose
   * adapter declares `supportsTools`. Returns the capability name or null.
   * @param {object} body
   * @returns {string|null}
   * @private
   */
  _requiredCapability(body) {
    if (body && (Array.isArray(body.tools) || body.tool_choice !== undefined)) {
      return 'supportsTools';
    }
    return null;
  }

  /**
   * Handle a (non-streaming) Chat Completions request.
   *
   * @param {object} body - request body
   * @param {object} [ctx] - request context
   * @param {string} [ctx.requestId]
   * @returns {Promise<{status:number, body:object}>}
   */
  async complete(body, ctx = {}) {
    const requestId = ctx.requestId || 'unknown';

    const { valid, errors } = validateChatRequest(body);
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
      operation: 'chat',
      requiredCapability: this._requiredCapability(body),
      ctx,
    });

    return { status: result.status, body: result.body };
  }

  /**
   * Handle a streaming Chat Completions request ("stream": true).
   *
   * @param {object} body - request body (with stream:true)
   * @param {object} res - Express response (for SSE output)
   * @param {object} [ctx] - request context
   * @param {string} [ctx.requestId]
   * @returns {Promise<void>}
   */
  async stream(body, res, ctx = {}) {
    const requestId = ctx.requestId || 'unknown';

    const { valid, errors } = validateChatRequest(body);
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
      endpoint: 'chat/completions',
      model: body.model,
      ctx: { requestId },
    });

    await this.requestExecutor.executeStream({
      model: body.model,
      input: body,
      operation: 'chat',
      requiredCapability: this._requiredCapability(body),
      sseWriter,
      streamAdapter,
      ctx,
    });
  }
}

module.exports = {
  ChatCompletionsService,
  validateChatRequest,
};
