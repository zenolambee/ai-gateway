const { ProviderAdapterSDK, ProviderManifest } = require('../../providerSDK');

class CopilotAdapter extends ProviderAdapterSDK {
  static get MANIFEST() {
    return new ProviderManifest({
      id: 'copilot',
      name: 'GitHub Copilot',
      homepage: 'https://github.com/features/copilot',
      supportedAuth: ['oauth', 'device-code'],
      endpoints: {
        baseURL: 'https://api.githubcopilot.com',
        deviceAuth: 'https://github.com/login/device/code',
        oauthToken: 'https://github.com/login/oauth/access_token',
      },
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: false,
    });
  }
}

module.exports = CopilotAdapter;
