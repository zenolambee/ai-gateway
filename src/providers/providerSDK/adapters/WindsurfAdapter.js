const { ProviderAdapterSDK, ProviderManifest } = require('../../providerSDK');

class WindsurfAdapter extends ProviderAdapterSDK {
  static get MANIFEST() {
    return new ProviderManifest({
      id: 'windsurf',
      name: 'Windsurf (Codeium)',
      homepage: 'https://codeium.com',
      supportedAuth: ['browser-login', 'session', 'api-key'],
      endpoints: { baseURL: 'https://api.codeium.com' },
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: false,
    });
  }
}

module.exports = WindsurfAdapter;
