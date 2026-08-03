const { ProviderAdapterSDK, ProviderManifest } = require('../../providerSDK');

class QwenAdapter extends ProviderAdapterSDK {
  static get MANIFEST() {
    return new ProviderManifest({
      id: 'qwen',
      name: 'Qwen (Alibaba Cloud)',
      homepage: 'https://dashscope.aliyun.com',
      supportedAuth: ['api-key'],
      endpoints: { baseURL: 'https://dashscope.aliyun.com/compatible-mode/v1' },
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: true,
    });
  }
}

module.exports = QwenAdapter;
