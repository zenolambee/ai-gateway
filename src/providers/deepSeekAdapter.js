const GenericOpenAIAdapter = require('./genericOpenAIAdapter');

/**
 * DeepSeekAdapter
 *
 * Adapter for DeepSeek (https://api.deepseek.com/v1). DeepSeek is
 * OpenAI-compatible for Chat Completions. The `deepseek-reasoner` model emits
 * a `reasoning_content` field alongside `content`, so reasoning is supported.
 * DeepSeek does not implement the Responses API directly.
 */
class DeepSeekAdapter extends GenericOpenAIAdapter {
  static get id() { return 'deepseek'; }

  capabilities() {
    return {
      supportsChat: true,
      supportsResponses: false,
      supportsStreaming: true,
      supportsEmbeddings: true,
      supportsImages: false,
      supportsAudio: false,
      supportsTools: true,
      supportsReasoning: true,
    };
  }
}

module.exports = DeepSeekAdapter;
