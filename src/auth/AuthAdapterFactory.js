/**
 * AuthAdapterFactory
 *
 * The extension point for the "Connect Account" system. Registers auth adapter
 * types and instantiates the right adapter for a provider.
 *
 * Adding a new provider authentication is simply:
 *
 *   factory.register('grok', GrokAdapter);
 *   // or
 *   factory.registerCustom('grok', { connect, refresh, disconnect, status, validate });
 *
 * No core gateway change is required.
 */

const AuthAdapter = require('./AuthAdapter');
const ApiKeyAdapter = require('./adapters/ApiKeyAdapter');
const OAuthAdapter = require('./adapters/OAuthAdapter');
const DeviceCodeAdapter = require('./adapters/DeviceCodeAdapter');
const BrowserLoginAdapter = require('./adapters/BrowserLoginAdapter');
const SessionAdapter = require('./adapters/SessionAdapter');
const CustomAdapter = require('./adapters/CustomAdapter');

const BUILTIN = {
  'api-key': ApiKeyAdapter,
  'api_key': ApiKeyAdapter,
  'apikey': ApiKeyAdapter,
  'oauth': OAuthAdapter,
  'device-code': DeviceCodeAdapter,
  'device_code': DeviceCodeAdapter,
  'device': DeviceCodeAdapter,
  'browser-login': BrowserLoginAdapter,
  'browser_login': BrowserLoginAdapter,
  'browser': BrowserLoginAdapter,
  'session': SessionAdapter,
  'session/cookie': SessionAdapter,
  'session-cookie': SessionAdapter,
  'custom': CustomAdapter,
};

const NORMALIZE = {
  'api-key': 'api-key',
  'api_key': 'api-key',
  'apikey': 'api-key',
  'oauth': 'oauth',
  'device-code': 'device-code',
  'device_code': 'device-code',
  'device': 'device-code',
  'browser-login': 'browser-login',
  'browser_login': 'browser-login',
  'browser': 'browser-login',
  'session': 'session',
  'session/cookie': 'session',
  'session-cookie': 'session',
  'custom': 'custom',
};

class AuthAdapterFactory {
  constructor() {
    this._registry = new Map();
    for (const [key, Cls] of Object.entries(BUILTIN)) {
      this._registry.set(key, (opts) => new Cls(opts));
    }
    this._customHooks = new Map();
  }

  /** Normalize an auth-type string to a canonical key. */
  normalize(type) {
    if (!type) return 'custom';
    return NORMALIZE[String(type).toLowerCase()] || 'custom';
  }

  /**
   * Register a custom adapter class for a provider id.
   * @param {string} id - provider id (e.g. 'grok')
   * @param {typeof AuthAdapter} AdapterClass
   */
  register(id, AdapterClass) {
    const key = String(id).toLowerCase();
    this._registry.set(key, (opts) => new AdapterClass(opts));
    return this;
  }

  /**
   * Register a provider whose auth is driven by hook functions (no class).
   * @param {string} id
   * @param {object} hooks - { connect, refresh, disconnect, status, validate }
   * @param {string} [baseType='custom'] - underlying base adapter type
   */
  registerCustom(id, hooks, baseType = 'custom') {
    const key = String(id).toLowerCase();
    this._customHooks.set(key, { hooks, baseType });
    const Cls = BUILTIN[this.normalize(baseType)] || CustomAdapter;
    this._registry.set(key, (opts) => new Cls({ type: key, hooks }));
    return this;
  }

  /**
   * Instantiate an adapter for a given auth type / provider id.
   * @param {string} [id] - provider id for provider-specific adapters
   * @param {string} [type] - auth type (falls back to provider-specific)
   * @returns {AuthAdapter}
   */
  create(id, type) {
    const key = String(id || '').toLowerCase();
    const specific = this._registry.get(key);
    if (specific) return specific({});
    const norm = this.normalize(type);
    const ctor = this._registry.get(norm);
    if (!ctor) return new CustomAdapter({});
    return ctor({});
  }

  /**
   * Return the metadata descriptors available for the Connect Account UI.
   * @returns {Array<object>}
   */
  listTypes() {
    const seen = new Set();
    const out = [];
    for (const [key] of this._registry) {
      const norm = this.normalize(key);
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({ id: norm, label: this._label(norm) });
    }
    return out;
  }

  _label(type) {
    const map = {
      'api-key': 'API Key',
      'oauth': 'OAuth 2.0',
      'device-code': 'Device Code',
      'browser-login': 'Browser Login',
      'session': 'Session / Cookie',
      'custom': 'Custom',
    };
    return map[type] || type;
  }
}

module.exports = AuthAdapterFactory;
