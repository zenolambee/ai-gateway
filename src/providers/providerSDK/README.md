# Provider Adapter SDK

Standard way to add a new AI provider to the gateway **without touching any
core file**. A provider is just **one adapter file + one manifest**.

## How to add a new provider

Create a single file in `src/providers/providerSDK/adapters/`, for example
`MyProviderAdapter.js`:

```js
const { ProviderAdapterSDK, ProviderManifest } = require('../providerSDK');

class MyProviderAdapter extends ProviderAdapterSDK {
  static get MANIFEST() {
    return new ProviderManifest({
      id: 'my-provider',                 // unique id (matches provider.id)
      name: 'My Provider',
      homepage: 'https://example.com',
      supportedAuth: ['api-key', 'oauth', 'device-code', 'browser-login', 'session', 'custom'],
      endpoints: { baseURL: 'https://api.example.com/v1' },
      supportsStreaming: true,
      supportsImages: false,
      supportsAudio: false,
      supportsTools: true,
      supportsEmbeddings: false,
      supportsVision: true,
    });
  }

  // Optional lifecycle customizations:
  // async connect(config) { ... }
  // async refresh(account) { ... }
  // async healthCheck() { ... }
}
```

Then register it **once** in `src/services/index.js` (the built-in list):

```js
providerSDKRegistry.register(require('../providers/providerSDK/adapters/MyProviderAdapter'));
```

That's it. The console, the model registry, the Connect Account UI, and the
dashboard all read the manifest automatically — **no UI changes**.
The provider now appears in `GET /admin/api/providers/sdk/manifests`.

## The Adapter Contract

Every adapter MUST implement:

| Method | Purpose |
|--------|---------|
| `initialize()` | Prepare resources (called at startup / register) |
| `connect(config)` | Establish an authenticated session |
| `disconnect(account)` | Revoke / tear down the session |
| `refresh(account)` | Refresh an expiring credential |
| `validate(account)` | Boolean: is the credential usable? |
| `listModels(provider)` | List served model ids (sync, config-driven) |
| `healthCheck(opts)` | Connectivity probe → `{ healthy, latencyMs, error? }` |
| `sendRequest(req)` | Send a provider-specific request |
| `shutdown()` | Release resources |

Plus all the existing `ProviderAdapter` data-transformation methods
(`buildChatPayload`, `normalizeChatResponse`, `buildHeaders`, ...) that the
`ProviderAdapterSDK` inherits.

## Auth

Each provider declares its supported auth types in the manifest. Out of the
box the SDK supports:
`api-key`, `oauth`, `device-code`, `browser-login`, `session`, `custom`.

OAuth / Device Code adapters perform real HTTP via the shared `httpClient` and
never touch a storage backend (that's owned by the ConnectionRegistry +
EncryptionService).

## Built-in providers

Grok, OpenAI, Claude, Gemini, Copilot, Cursor, Windsurf, Kimi, Qwen —
all shipped as ready adapters with placeholder endpoints you can replace.
