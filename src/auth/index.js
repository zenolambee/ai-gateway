/**
 * Auth module — "Connect Account" generic authentication architecture.
 *
 * Provides:
 *   - AuthAdapter          : abstract interface (connect/refresh/disconnect/
 *                            status/validate/save/load)
 *   - AuthAdapterFactory   : extension point for new providers
 *   - ConnectionRegistry   : lifecycle + storage + encryption ownership
 *   - EncryptionService    : AES-256-GCM credential encryption
 *   - TokenManager         : persists token records (encrypted)
 *   - RefreshScheduler     : background auto-refresh with backoff/retry
 *   - ProviderCatalog      : metadata + templates for known providers
 *   - built-in adapters    : api-key, oauth, device-code, browser-login,
 *                            session, custom
 */

const AuthAdapter = require('./AuthAdapter');
const AuthAdapterFactory = require('./AuthAdapterFactory');
const ConnectionRegistry = require('./ConnectionRegistry');
const EncryptionService = require('./EncryptionService');
const TokenManager = require('./TokenManager');
const RefreshScheduler = require('./RefreshScheduler');
const ProviderCatalog = require('./ProviderCatalog');

module.exports = {
  AuthAdapter,
  AuthAdapterFactory,
  ConnectionRegistry,
  EncryptionService,
  TokenManager,
  RefreshScheduler,
  ProviderCatalog,
  createRegistry: (opts = {}) => new ConnectionRegistry({
    factory: opts.factory || new AuthAdapterFactory(),
    storageProvider: opts.storageProvider,
    prefix: opts.prefix,
    encryption: opts.encryption,
    httpClient: opts.httpClient,
  }),
};
