const GenericOpenAIAdapter = require('./genericOpenAIAdapter');

/**
 * NvidiaAdapter
 *
 * Adapter for NVIDIA NIM / build.nvidia.com OpenAI-compatible endpoints
 * (https://integrate.api.nvidia.com/v1). NVIDIA exposes an OpenAI-compatible
 * Chat Completions API for its NIM models. The base class behaviour works
 * as-is.
 */
class NvidiaAdapter extends GenericOpenAIAdapter {
  static get id() { return 'nvidia'; }

  capabilities() {
    return {
      supportsChat: true,
      supportsResponses: false,
      supportsStreaming: true,
      supportsEmbeddings: true,
      supportsImages: false,
      supportsAudio: false,
      supportsTools: true,
      supportsReasoning: false,
    };
  }
}

module.exports = NvidiaAdapter;
