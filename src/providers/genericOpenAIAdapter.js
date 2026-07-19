const ProviderAdapter = require('./providerAdapter');

/**
 * GenericOpenAIAdapter
 *
 * The default adapter for any provider that speaks the OpenAI Chat
 * Completions wire format. All OpenAI-compatible behaviour is inherited from
 * the ProviderAdapter base class — this subclass just declares its id and
 * the default capabilities.
 *
 * Used as the fallback in the registry when a provider config does not
 * specify an `adapter` field.
 */
class GenericOpenAIAdapter extends ProviderAdapter {
  static get id() { return 'generic-openai'; }

  capabilities() {
    return {
      supportsChat: true,
      supportsResponses: true,
      supportsStreaming: true,
      supportsEmbeddings: false,
      supportsImages: false,
      supportsAudio: false,
      supportsTools: true,
      supportsReasoning: false,
    };
  }
}

module.exports = GenericOpenAIAdapter;
