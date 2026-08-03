const { ProviderAdapterSDK, ProviderManifest } = require('../../providerSDK');

class KimiAdapter extends ProviderAdapterSDK {
  static get MANIFEST() {
    return new ProviderManifest({
      id: 'kimi',
      name: 'Kimi (Moonshot)',
      homepage: 'https://kimi.moonshot.cn',
      supportedAuth: ['api-key'],
      endpoints: { baseURL: 'https://api.moonshot.cn/v1' },
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: false,
    });
  }
}

module.exports = KimiAdapter;
