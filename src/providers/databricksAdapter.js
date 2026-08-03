const GenericOpenAIAdapter = require('./genericOpenAIAdapter');

/**
 * DatabricksAdapter
 *
 * Adapter for Databricks Model Serving (https://<workspace>.cloud.databricks.com/serving-endpoints/<name>/...).
 * Databricks exposes an OpenAI-compatible Chat Completions API on its
 * Foundation Model endpoints. The base URL in the provider config should
 * point to the serving endpoint root (e.g. .../serving-endpoints/<name>),
 * and the chat endpoint is `/invocations` for the Foundation Model API or
 * `/chat/completions` for the OpenAI-compatible route.
 *
 * By default we use the OpenAI-compatible route; the provider config can
 * override `provider.chatPath` if needed.
 */
class DatabricksAdapter extends GenericOpenAIAdapter {
  static get id() { return 'databricks'; }

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

  /**
   * Databricks may use a per-endpoint chat path. Allow the provider config to
   * override it via `provider.chatPath`.
   */
  chatEndpoint(provider) {
    return provider.chatPath || '/chat/completions';
  }
}

module.exports = DatabricksAdapter;
