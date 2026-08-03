/**
 * ProviderCatalog
 *
 * Metadata + configuration templates for known AI providers. Every provider
 * describes:
 *   - auth type (one of: api-key, oauth, device-code, browser-login, session)
 *   - default adapter
 *   - OAuth endpoints (authorize, token, refresh, revoke, device)
 *   - Required credential fields
 *   - Default scopes
 *   - Empty template for the Connect Account UI
 *
 * This is a **static catalog** — no HTTP calls. A provider's adapter and
 * actual OAuth flow are implemented by an adapter in src/auth/adapters/.
 * The catalog is purely for the dashboard UI and auto-configuration.
 *
 * Adding a new provider:
 *   1. Create an adapter in src/auth/adapters/ (or use a built-in type)
 *   2. Add an entry here with the provider's endpoints + metadata
 *   3. Register it with the AuthAdapterFactory (server startup)
 *   No core gateway changes required.
 */
const CATALOG = {
  grok: {
    id: 'grok',
    name: 'Grok (xAI)',
    website: 'https://console.x.ai',
    authType: 'api-key',
    adapter: 'generic-openai',
    endpoints: {
      baseURL: 'https://api.x.ai/v1',
    },
    requiredFields: ['apiKey'],
    scopeHint: null,
    templates: {
      apiKey: 'xai-...',
    },
  },

  openai: {
    id: 'openai',
    name: 'OpenAI',
    website: 'https://platform.openai.com',
    authType: 'api-key',
    adapter: 'openai',
    endpoints: {
      baseURL: 'https://api.openai.com/v1',
      oauthAuthorize: 'https://auth.openai.com/authorize',
      oauthToken: 'https://auth.openai.com/token',
      oauthRevoke: 'https://auth.openai.com/revoke',
      deviceAuth: 'https://auth.openai.com/device',
    },
    requiredFields: ['apiKey'],
    scopeHint: 'openai-api',
    templates: {
      apiKey: 'sk-...',
      oauth: { clientId: '', clientSecret: '', redirectUri: 'https://localhost:3000/oauth/callback' },
      deviceCode: { clientId: '', clientSecret: '' },
    },
  },

  claude: {
    id: 'claude',
    name: 'Anthropic Claude',
    website: 'https://console.anthropic.com',
    authType: 'api-key',
    adapter: 'anthropic',
    endpoints: {
      baseURL: 'https://api.anthropic.com/v1',
    },
    requiredFields: ['apiKey'],
    scopeHint: null,
    templates: {
      apiKey: 'sk-ant-...',
    },
  },

  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    website: 'https://makersuite.google.com/app/apikey',
    authType: 'api-key',
    adapter: 'gemini',
    endpoints: {
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    },
    requiredFields: ['apiKey'],
    scopeHint: null,
    templates: {
      apiKey: 'AIza...',
    },
  },

  copilot: {
    id: 'copilot',
    name: 'GitHub Copilot',
    website: 'https://github.com/settings/copilot',
    authType: 'device-code',
    adapter: 'generic-openai',
    endpoints: {
      baseURL: 'https://api.githubcopilot.com',
      deviceAuth: 'https://github.com/login/device/code',
      oauthToken: 'https://github.com/login/oauth/access_token',
      oauthAuthorize: 'https://github.com/login/oauth/authorize',
    },
    requiredFields: ['clientId'],
    scopeHint: 'read:user,repo',
    templates: {
      deviceCode: { clientId: 'Iv23liLP1UserAgent' },
      oauth: { clientId: '', clientSecret: '', redirectUri: 'https://localhost:3000/oauth/callback' },
    },
  },

  cursor: {
    id: 'cursor',
    name: 'Cursor',
    website: 'https://cursor.sh',
    authType: 'browser-login',
    adapter: 'generic-openai',
    endpoints: {
      baseURL: 'https://api2.cursor.sh/ai',
    },
    requiredFields: [],
    scopeHint: null,
    templates: {
      browserLogin: { sessionToken: '...' },
    },
  },

  windsurf: {
    id: 'windsurf',
    name: 'Windsurf (Codeium)',
    website: 'https://codeium.com',
    authType: 'browser-login',
    adapter: 'generic-openai',
    endpoints: {
      baseURL: 'https://api.codeium.com',
    },
    requiredFields: [],
    scopeHint: null,
    templates: {
      browserLogin: { sessionToken: '...' },
    },
  },

  kimi: {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    website: 'https://kimi.moonshot.cn',
    authType: 'api-key',
    adapter: 'generic-openai',
    endpoints: {
      baseURL: 'https://api.moonshot.cn/v1',
    },
    requiredFields: ['apiKey'],
    scopeHint: null,
    templates: {
      apiKey: 'sk-...',
    },
  },

  qwen: {
    id: 'qwen',
    name: 'Qwen (Alibaba Cloud)',
    website: 'https://dashscope.aliyun.com',
    authType: 'api-key',
    adapter: 'generic-openai',
    endpoints: {
      baseURL: 'https://dashscope.aliyun.com/compatible-mode/v1',
    },
    requiredFields: ['apiKey'],
    scopeHint: null,
    templates: {
      apiKey: 'sk-...',
    },
  },

  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    website: 'https://platform.deepseek.com',
    authType: 'api-key',
    adapter: 'deepseek',
    endpoints: {
      baseURL: 'https://api.deepseek.com/v1',
    },
    requiredFields: ['apiKey'],
    scopeHint: null,
    templates: {
      apiKey: 'sk-...',
    },
  },

  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    website: 'https://openrouter.ai',
    authType: 'api-key',
    adapter: 'openrouter',
    endpoints: {
      baseURL: 'https://openrouter.ai/api/v1',
    },
    requiredFields: ['apiKey'],
    scopeHint: null,
    templates: {
      apiKey: 'sk-or-...',
    },
  },

  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    website: 'https://build.nvidia.com',
    authType: 'api-key',
    adapter: 'nvidia',
    endpoints: {
      baseURL: 'https://integrate.api.nvidia.com/v1',
    },
    requiredFields: ['apiKey'],
    scopeHint: null,
    templates: {
      apiKey: 'nvapi-...',
    },
  },

  databricks: {
    id: 'databricks',
    name: 'Databricks Model Serving',
    website: 'https://www.databricks.com',
    authType: 'api-key',
    adapter: 'databricks',
    endpoints: {
      baseURL: 'https://<workspace>.cloud.databricks.com/serving-endpoints/<endpoint-name>',
    },
    requiredFields: ['apiKey', 'baseURL'],
    scopeHint: null,
    templates: {
      apiKey: 'dapi-...',
    },
  },
};

class ProviderCatalog {
  constructor() {
    this._entries = new Map(Object.entries(CATALOG));
  }

  /** Get metadata for a provider by id. */
  get(providerId) {
    return this._entries.get(providerId) || null;
  }

  /** List all known provider ids. */
  list() {
    return [...this._entries.values()];
  }

  /** List provider ids that match a given auth type. */
  listByAuthType(authType) {
    return this.list().filter((p) => p.authType === authType).map((p) => p.id);
  }

  /** Register or override a provider in the catalog. */
  register(id, entry) {
    this._entries.set(id, { id, ...entry });
    return this;
  }

  /** Number of providers in the catalog. */
  get size() { return this._entries.size; }
}

module.exports = ProviderCatalog;
