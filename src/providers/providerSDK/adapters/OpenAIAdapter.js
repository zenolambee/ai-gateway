const { ProviderAdapterSDK, ProviderManifest } = require('../../providerSDK');

class OpenAIAdapter extends ProviderAdapterSDK {
  static get MANIFEST() {
    return new ProviderManifest({
      id: 'openai',
      name: 'OpenAI',
      homepage: 'https://platform.openai.com',
      supportedAuth: ['api-key', 'oauth'],
      endpoints: {
        baseURL: 'https://api.openai.com/v1',
        oauthAuthorize: 'https://auth.openai.com/authorize',
        oauthToken: 'https://auth.openai.com/token',
        oauthRevoke: 'https://auth.openai.com/revoke',
      },
      supportsStreaming: true,
      supportsImages: true,
      supportsAudio: true,
      supportsTools: true,
      supportsEmbeddings: true,
      supportsVision: true,
    });
  }
}

module.exports = OpenAIAdapter;
