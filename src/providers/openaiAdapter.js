const GenericOpenAIAdapter = require('./genericOpenAIAdapter');

/**
 * OpenAIAdapter
 *
 * Adapter for OpenAI (https://api.openai.com/v1). OpenAI is the canonical
 * OpenAI-compatible provider, so this adapter is effectively GenericOpenAI
 * with OpenAI-specific capabilities (supports Embeddings, Images, Audio).
 */
class OpenAIAdapter extends GenericOpenAIAdapter {
  static get id() { return 'openai'; }

  capabilities() {
    return {
      supportsChat: true,
      supportsResponses: true,
      supportsStreaming: true,
      supportsEmbeddings: true,
      supportsImages: true,
      supportsAudio: true,
      supportsTools: true,
      supportsReasoning: true,
    };
  }
}

module.exports = OpenAIAdapter;
