const { ProviderAdapterSDK, ProviderManifest } = require('../../providerSDK');

class CursorAdapter extends ProviderAdapterSDK {
  static get MANIFEST() {
    return new ProviderManifest({
      id: 'cursor',
      name: 'Cursor',
      homepage: 'https://cursor.sh',
      supportedAuth: ['browser-login', 'session'],
      endpoints: { baseURL: 'https://api2.cursor.sh/ai' },
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: false,
    });
  }
}

module.exports = CursorAdapter;
