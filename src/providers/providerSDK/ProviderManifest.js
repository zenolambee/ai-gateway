/**
 * ProviderManifest
 *
 * Immutable metadata descriptor for a provider in the Provider Adapter SDK.
 * Every registered adapter provides a Manifest that the dashboard reads to
 * render provider-specific configuration UI automatically.
 *
 * Fields:
 *   id              - unique provider identifier (matches adapter id)
 *   name            - human-readable display name
 *   logo            - URL or URI to a logo image
 *   homepage        - provider website URL
 *   supportedAuth   - array of auth types this provider supports
 *                     (api-key, oauth, device-code, browser-login, session, custom)
 *   supportedModels - array of supported model id strings (or [] for config-driven)
 *   supportsStreaming
 *   supportsImages
 *   supportsAudio
 *   supportsTools
 *   supportsEmbeddings
 *   supportsVision
 *   version         - manifest schema version
 *   endpoints       - object with endpoint URLs (baseURL, oauth* , device*)
 *   template        - empty credential template for the Connect Account UI
 *   ConfigSchema    - optional: JSON Schema fields for the provider config editor
 */
class ProviderManifest {
  constructor(def) {
    if (!def || !def.id) throw new Error('ProviderManifest requires an id');
    this.id = def.id;
    this.name = def.name || def.id;
    this.logo = def.logo || null;
    this.homepage = def.homepage || null;
    this.supportedAuth = Array.isArray(def.supportedAuth) ? def.supportedAuth : ['api-key'];
    this.supportedModels = Array.isArray(def.supportedModels) ? def.supportedModels : [];
    this.supportsStreaming = def.supportsStreaming !== false;
    this.supportsImages = !!def.supportsImages;
    this.supportsAudio = !!def.supportsAudio;
    this.supportsTools = def.supportsTools !== false;
    this.supportsEmbeddings = !!def.supportsEmbeddings;
    this.supportsVision = !!def.supportsVision;
    this.version = 1;
    this.endpoints = def.endpoints || {};
    this.template = def.template || {};
    this.ConfigSchema = def.ConfigSchema || null;
    // Preserve extra fields (adapter, auth type hint, etc.)
    for (const k of Object.keys(def)) {
      if (!(k in this)) this[k] = def[k];
    }
    Object.freeze(this);
  }

  /** Plain serializable shape for the API. */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      logo: this.logo,
      homepage: this.homepage,
      supportedAuth: this.supportedAuth,
      supportedModels: this.supportedModels,
      supportsStreaming: this.supportsStreaming,
      supportsImages: this.supportsImages,
      supportsAudio: this.supportsAudio,
      supportsTools: this.supportsTools,
      supportsEmbeddings: this.supportsEmbeddings,
      supportsVision: this.supportsVision,
      version: this.version,
      endpoints: this.endpoints,
      template: this.template,
      ConfigSchema: this.ConfigSchema,
    };
  }
}

module.exports = ProviderManifest;
