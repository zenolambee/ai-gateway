const GenericOpenAIAdapter = require('./genericOpenAIAdapter');

/**
 * OpenRouterAdapter
 *
 * Adapter for OpenRouter (https://openrouter.ai/api/v1). OpenRouter is
 * OpenAI-compatible but adds an optional HTTP-Referer and X-Title header for
 * ranking attribution. It supports a wide model catalogue including reasoning
 * models.
 */
class OpenRouterAdapter extends GenericOpenAIAdapter {
  static get id() { return 'openrouter'; }

  capabilities() {
    return {
      supportsChat: true,
      supportsResponses: false,
      supportsStreaming: true,
      supportsEmbeddings: true,
      supportsImages: true,
      supportsAudio: true,
      supportsTools: true,
      supportsReasoning: true,
    };
  }

  /**
   * Add OpenRouter's optional ranking headers. The values come from the
   * provider config (`provider.headers`) or fall back to a neutral default.
   */
  buildHeaders(provider, ctx = {}) {
    const headers = {};
    if (provider.openrouterReferer) {
      headers['HTTP-Referer'] = provider.openrouterReferer;
    }
    if (provider.openrouterTitle) {
      headers['X-Title'] = provider.openrouterTitle;
    }
    return headers;
  }
}

module.exports = OpenRouterAdapter;
