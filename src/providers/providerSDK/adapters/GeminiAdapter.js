const { ProviderAdapterSDK, ProviderManifest } = require('../../providerSDK');

class GeminiAdapter extends ProviderAdapterSDK {
  static get MANIFEST() {
    return new ProviderManifest({
      id: 'gemini',
      name: 'Google Gemini',
      homepage: 'https://makersuite.google.com',
      supportedAuth: ['api-key', 'oauth'],
      endpoints: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: true,
      supportsEmbeddings: true,
    });
  }
}

module.exports = GeminiAdapter;
