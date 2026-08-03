const GenericOpenAIAdapter = require('./genericOpenAIAdapter');

/**
 * TokenFaucetAdapter
 *
 * Adapter for TokenFaucet (OpenAI-compatible endpoint). TokenFaucet is a
 * community-run token faucet / playground exposing an OpenAI-compatible API.
 * No special payload mapping required — it inherits the generic behaviour.
 */
class TokenFaucetAdapter extends GenericOpenAIAdapter {
  static get id() { return 'tokenfaucet'; }

  capabilities() {
    return {
      supportsChat: true,
      supportsResponses: false,
      supportsStreaming: true,
      supportsEmbeddings: false,
      supportsImages: false,
      supportsAudio: false,
      supportsTools: false,
      supportsReasoning: false,
    };
  }
}

module.exports = TokenFaucetAdapter;
