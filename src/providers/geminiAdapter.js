const GenericOpenAIAdapter = require('./genericOpenAIAdapter');

/**
 * GeminiAdapter
 *
 * Adapter for Google Gemini's OpenAI-compatible endpoint
 * (https://generativelanguage.googleapis.com/v1beta/openai/). Google
 * provides an OpenAI-compatible Chat Completions route so we can reuse the
 * generic behaviour. Gemini supports multimodal (images), tools, and
 * reasoning models.
 */
class GeminiAdapter extends GenericOpenAIAdapter {
  static get id() { return 'gemini'; }

  capabilities() {
    return {
      supportsChat: true,
      supportsResponses: false,
      supportsStreaming: true,
      supportsEmbeddings: true,
      supportsImages: true,
      supportsAudio: false,
      supportsTools: true,
      supportsReasoning: true,
    };
  }
}

module.exports = GeminiAdapter;
