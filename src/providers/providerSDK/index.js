/**
 * Provider Adapter SDK
 *
 * Provider baru cukup membuat satu adapter dan satu manifest,
 * register lewat ProviderSDKRegistry — tidak perlu menyentuh core gateway.
 *
 * Setiap adapter wajib mengimplementasikan:
 *   initialize()  connect()  disconnect()  refresh()  validate()
 *   listModels()  healthCheck()  sendRequest()  shutdown()
 *
 * plus static MANIFEST (ProviderManifest) dengan metadata provider.
 *
 * Untuk auth, adapter cukup register auth type-nya:
 *   authAdapterFactory.registerProvider(MyAdapter.MANIFEST);
 *
 * Atau gunakan build-in auth via authAdapterFactory.create().
 */

const ProviderAdapterSDK = require('./ProviderAdapterSDK');
const ProviderManifest = require('./ProviderManifest');
const ProviderSDKRegistry = require('./ProviderSDKRegistry');
const SDKRoutingBridge = require('./SDKRoutingBridge');

module.exports = {
  ProviderAdapterSDK,
  ProviderManifest,
  ProviderSDKRegistry,
  SDKRoutingBridge,
  createRegistry: (opts = {}) => {
    const r = new ProviderSDKRegistry();
    if (opts.httpClient) r.setHttpClient(opts.httpClient);
    return r;
  },
};
