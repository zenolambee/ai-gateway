const { ProviderAdapterSDK, ProviderManifest } = require('../../providerSDK');

class GrokAdapter extends ProviderAdapterSDK {
  static get MANIFEST() {
    return new ProviderManifest({
      id: 'grok',
      name: 'Grok (xAI)',
      homepage: 'https://console.x.ai',
      supportedAuth: ['api-key'],
      endpoints: { baseURL: 'https://api.x.ai/v1' },
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: true,
    });
  }
}

module.exports = GrokAdapter;
