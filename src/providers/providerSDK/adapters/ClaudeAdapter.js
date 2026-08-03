const { ProviderAdapterSDK, ProviderManifest } = require('../../providerSDK');

class ClaudeAdapter extends ProviderAdapterSDK {
  static get MANIFEST() {
    return new ProviderManifest({
      id: 'claude',
      name: 'Anthropic Claude',
      homepage: 'https://console.anthropic.com',
      supportedAuth: ['api-key'],
      endpoints: { baseURL: 'https://api.anthropic.com/v1' },
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: true,
    });
  }
}

module.exports = ClaudeAdapter;
