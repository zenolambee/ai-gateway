# AI Gateway

A professional API Gateway for AI services built with Node.js, Express, and vanilla JavaScript. Provides a unified endpoint to interact with multiple AI models, with built‑in security, logging, and graceful shutdown handling.

## Features

- **Root API Info** – GET `/` returns service name, version, description, default model, and available endpoints.
- **Health Check** – GET `/health` returns status, server uptime, version, and timestamp.
- **Model Listing** – GET `/v1/models` and GET `/v1/models/:id` are OpenAI-compatible endpoints backed by a `ModelRegistry` that aggregates the model catalogues of every enabled provider, deduplicates identical model ids, tracks per-model capabilities internally, and caches the result with a configurable TTL + manual refresh. If one provider fails, the remaining providers are still collected.
- **Application Info** – GET `/v1/info` returns current app configuration (name, version, description, default model).
- **AI Generation** – POST `/api/v1/generate` accepts a prompt (and optional model) and returns a generated text from the configured AI provider (currently integrated with DeepSeek via OpenAI‑compatible API).
- **Chat Completions** – POST `/v1/chat/completions` is an OpenAI-compatible endpoint. Requests are routed to the matching provider via `ModelRouter` + `ProviderManager`, sent through the shared `HttpClient`, and returned in OpenAI format.
- **Tool Calling / Function Calling** – Full OpenAI-compatible tool calling on `/v1/chat/completions`: `tools`, `tool_choice`, `parallel_tool_calls`, assistant `tool_calls`, `tool` role result messages, and incremental streaming tool-call deltas. Provider-specific formats (e.g. Anthropic `tool_use`) are mapped transparently by the adapter; the gateway contract stays OpenAI-shaped. Providers without `supportsTools` are filtered out when tools are requested.
- **Responses API** – POST `/v1/responses` is an OpenAI-compatible endpoint implemented as an adapter on top of the same `RequestExecutor` pipeline as Chat Completions — no transport code is duplicated.
- **Embeddings API** – POST `/v1/embeddings` is an OpenAI-compatible endpoint. The gateway routes the request to a provider whose adapter declares `supportsEmbeddings`, maps the request/response through the shared `RequestExecutor` (with retry + fallback), and returns the OpenAI `list` shape. Embeddings never stream.
- **Images API** – POST `/v1/images/generations`, `/v1/images/edits`, `/v1/images/variations` are OpenAI-compatible endpoints. Generations use a JSON body; edits and variations accept `multipart/form-data` file uploads. The gateway routes to a provider whose adapter declares `supportsImages`, maps the request/response through the shared `RequestExecutor`, and returns the OpenAI `images` shape (`url` or `b64_json`). Images never stream.
- **Audio API** – POST `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/audio/translations` are OpenAI-compatible endpoints. Speech (text-to-speech) uses a JSON body and returns **raw audio bytes** (or JSON when `response_format` is `json`/`verbose_json`). Transcriptions and translations accept `multipart/form-data` audio file uploads and return `{ text }`. The gateway routes to a provider whose adapter declares `supportsAudio`, with retry + fallback. Audio never streams.
- **Retry + Fallback** – `RequestExecutor` retries transient failures (per provider) and falls back to the next provider for the same model when one provider is exhausted.
- **Streaming** – Both Chat Completions and Responses support OpenAI-compatible SSE streaming (`"stream": true`). A shared `StreamParser` → `StreamingResponseAdapter` → `SSEWriter` pipeline forwards provider events to the client, with retry/fallback for the pre-stream phase.
- **API Key Management** – `ApiKeyManager` loads multiple keys per provider, rotates them round-robin, cools-down keys on transient failures, permanently disables bad keys, and tracks per-key statistics — all in-memory.
- **Security** – Uses `helmet` for HTTP headers, `cors` for cross‑origin support, and input validation.
- **Authentication & Authorization** – Middleware-based Bearer API key authentication with multiple keys, key metadata (name, status, expiration), optional per-key provider/model restrictions, and per-key usage tracking (requests, tokens, provider usage, model usage, last used). Protects every endpoint except `/`, `/health`, `/ready`, `/metrics`, `/stats`, `/health/providers`. Open-gateway mode when no keys are configured.
- **Metrics & Monitoring** – `GET /metrics`, `GET /stats`, `GET /health/providers` expose global and per-provider counters (requests, successes, failures, retries, fallbacks), latency percentiles (p50/p95/p99), token usage, active API keys/providers, and per-provider circuit-breaker health (online/offline, consecutive failures, success rate, last success/failure). Metrics collection is centralized and non-blocking. Providers that recover automatically become available again via a circuit-breaker state machine (closed → open → half-open → closed).
- **Rate Limiting & Quota Management** – Centralized `RateLimiter` with three algorithms (fixed window, sliding window, token bucket) across four scopes (global, per-API-key, per-provider, per-model). Supports burst limits, concurrent request limits, daily request quotas, and daily/monthly token quotas. Returns OpenAI-compatible `X-RateLimit-*` headers and `Retry-After` on `429`. Configurable from `.env` or `config/rateLimit.json`.
- **Provider Hot Reload** – The `ProviderConfigManager` watches `config/providers/*.json` for changes and atomically reloads the provider configuration without restarting the gateway. Validation failures roll back to the previous config. The reload cascade resets the adapter cache, API keys, model registry, and health monitor. In-flight requests continue normally; new requests use the updated config. Reload metrics (count + failures) are exposed via `GET /metrics`.
- **Admin Dashboard** – A built-in web UI at `GET /admin` with an authenticated admin API at `/admin/api/*`. Provides overview cards (requests, tokens, cost, providers, health, API keys, rate limits, latency), provider management (enable/disable, priority, timeout, test connectivity, manual reload), API key management (create/delete/enable/disable/expire/restrict), model registry, monitoring charts, real-time request logs with filtering, circuit-breaker health, and live configuration editing via hot reload. Admin access requires an API key with `role: "admin"`.
- **Logging** – Uses `morgan` with a format that adapts to the environment (`combined` for production, `dev` for development). Structured JSON logs for provider requests/responses/errors (model, provider, duration, status code, request id).
- **Request ID** – Every request gets an `X-Request-Id` (generated or forwarded from the client header) for end-to-end correlation.
- **Error Handling** – Custom `AppError` class for operational errors; all errors normalized to the OpenAI-compatible envelope; uncaught exceptions and unhandled rejections are logged and shut down gracefully.
- **Graceful Shutdown** – Listens for `SIGTERM` and `SIGINT` signals, closes the server cleanly.
- **Configuration** – All settings (port, environment, version, AI API URL, API key, default model, models list) are externalized to a `.env` file.
- **Environment Validation** – The server aborts at startup if `AI_API_KEY` is not set.
- **Async Error Handling** – Route handlers are wrapped with `asyncHandler` to forward errors to the global handler automatically.

## Prerequisites

- [Node.js](https://nodejs.org) v14 or later
- npm (comes with Node.js)
- An API key for a DeepSeek‑compatible AI provider (or OpenAI‑style provider).

## Installation

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd ai-gateway
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy the example environment file and adjust as needed:
   ```bash
   cp .env.example .env
   ```

## Configuration

Edit the `.env` file with your preferred settings:

- `PORT` – The port the server will listen on (default `3000`).
- `NODE_ENV` – Environment (`development`, `production`, or `test`). Affects morgan log format and other behaviors.
- `VERSION` – Version string returned in the health‑check response.
- `GATEWAY_SECRET_KEY` – **(Recommended for production, optional)** Gateway master secret used by the `EncryptionService` to encrypt provider credentials at rest. This is a *Gateway* secret, **not** a provider API key. When unset, a process-local key is generated (credentials will not survive a restart).
- `PROVIDERS_CONFIG_DIR` – Directory containing provider JSON config files (defaults to `config/providers`).

**Provider credentials are optional at startup.** The Gateway starts with **zero** provider API keys configured. Provider credentials (NVIDIA/OpenAI/Anthropic/… API keys, OAuth tokens, etc.) are configured through the Dashboard / ConnectionManager and are encrypted at rest, or supplied optionally via `${VAR}` placeholders in provider config files. If a credential is missing, that provider is auto-disabled at startup and requests routed to it return a clean `provider_not_configured` error — the process never aborts.

### Legacy `/api/v1/generate` (optional, deprecated)

The following variables only affect the legacy single-provider demo endpoint `POST /api/v1/generate`. They are **optional** and are **not required for startup**:

- `MODELS_LIST` – A JSON array of model objects returned by `/v1/models`.
- `AI_API_URL` – URL of a single OpenAI‑compatible chat completions endpoint.
- `AI_API_KEY` – API key for that single legacy endpoint. When unset, `/api/v1/generate` returns `provider_not_configured`; all other (OpenAI-compatible) endpoints are unaffected.
- `AI_MODEL` – Default model for the legacy endpoint.

Prefer the OpenAI-compatible endpoints (`/v1/chat/completions`, etc.), which route through the Provider Registry + ConnectionManager.

## Provider Management

AI providers are configured entirely through JSON files in `config/providers/`. Each file represents one provider and supports the following fields:

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique provider identifier |
| `name` | string | Human-readable provider name |
| `enabled` | boolean | Whether the provider is active |
| `baseURL` | string | Base URL of the provider API (http/https) |
| `apiKeys` | string[] | List of API keys (supports `${VAR}` env-var placeholders) |
| `supportedModels` | string[] | Models this provider can serve |
| `priority` | number | Routing priority (lower = higher priority) |
| `timeout` | number | Request timeout in milliseconds |
| `weight` | number | Optional load-balancing weight (non-negative) |
| `retryPolicy` | object | Optional `{ maxRetries, backoffMs }` override |
| `fallbackPolicy` | boolean\|object | Optional fallback behaviour override |
| `headers` | object | Optional custom headers sent to the provider |
| `adapter` | string | Adapter id (e.g. `openai`, `anthropic`, `deepseek`) |

To add a new provider, simply drop a new `.json` file into `config/providers/` — no source code changes are required. The `ProviderManager` loads and validates all providers at startup.

### Hot Reload

The gateway watches `config/providers/` for file changes and automatically
reloads the provider configuration **without restarting the process**. This
is handled by the `ProviderConfigManager`
(`src/services/providerConfigManager.js`).

**What happens on a reload:**

1. All `.json` files in `config/providers/` are re-read and env-expanded.
2. The new config is validated (duplicate ids, invalid URLs, duplicate
   models, missing required fields). **If validation fails, the previous
   configuration is kept** and the errors are logged — no service
   disruption.
3. On success, the `ProviderManager` atomically swaps in the new config.
4. The **reload cascade** runs: adapter cache is reset, API keys are
   reloaded, the model registry cache is invalidated, and the health
   monitor is reset.
5. The metrics collector records the reload (`configReloadCount`).

**In-flight requests** continue with the provider objects they already
resolved. **New requests** use the updated configuration immediately.

File-change events are debounced (100ms) so an editor that writes
multiple files at once triggers a single reload.

### Configuration Validation

The validator checks:

| Check | Level | Description |
|---|---|---|
| Required fields | Error | `id`, `name`, `baseURL`, `supportedModels` must be present |
| Duplicate provider ids | Error | Two providers with the same `id` |
| Invalid baseURL | Error | Must be a valid `http://` or `https://` URL |
| Duplicate models | Error | Same model id listed twice in one provider's `supportedModels` |
| Duplicate priorities | Warning | Two providers sharing the same priority (order is undefined) |
| Missing API keys | Warning | Enabled provider with no API keys configured |
| Invalid field types | Error | `enabled` must be boolean, `priority` must be number, etc. |

### Reload Metrics

Reload statistics are exposed via `GET /metrics`:

```json
{
  "configReloadCount": 5,
  "configReloadFailures": 1,
  "activeProviders": 3,
  "disabledProviders": 1
}
```

## Authentication & Authorization

The gateway supports middleware-based Bearer API key authentication. When
API keys are configured, every endpoint except `/`, `/health`, and `/ready`
requires a valid `Authorization: Bearer <key>` header. When no keys are
configured, the gateway runs in **open-gateway mode** (no auth required).

### Configuration

API keys are loaded from `config/apiKeys.json` and/or the
`GATEWAY_API_KEYS` environment variable (JSON array or comma-separated).

```bash
# Copy the example and edit:
cp config/apiKeys.example.json config/apiKeys.json
```

Each key entry supports:

| Field | Type | Required | Notes |
|---|---|---|---|
| `key` | string | yes | The Bearer token value (supports `${VAR}` env expansion) |
| `id` | string | no | Key identifier (defaults to the key value); used for usage tracking |
| `name` | string | no | Human-readable label |
| `status` | string | no | `"active"` (default) or `"inactive"` |
| `expiresAt` | number | no | Unix timestamp; key rejected after this time |
| `allowedProviders` | string[] | no | Restrict to specific provider ids; omit for all |
| `allowedModels` | string[] | no | Restrict to specific model ids; omit for all |
| `createdAt` | number | no | Unix timestamp (defaults to now) |

Example `config/apiKeys.json`:

```json
[
  {
    "id": "default-key",
    "key": "sk-gateway-default-key",
    "name": "Default key",
    "status": "active"
  },
  {
    "id": "readonly-key",
    "key": "sk-gateway-readonly",
    "name": "Read-only (models only)",
    "status": "active",
    "allowedModels": ["gpt-4o", "gpt-4o-mini"]
  },
  {
    "id": "limited-key",
    "key": "sk-gateway-limited",
    "name": "Provider-limited",
    "status": "active",
    "allowedProviders": ["openai", "deepseek"]
  },
  {
    "id": "expired-key",
    "key": "sk-gateway-expired",
    "status": "active",
    "expiresAt": 1000000000
  },
  {
    "id": "disabled-key",
    "key": "sk-gateway-disabled",
    "status": "inactive"
  }
]
```

Alternatively, set keys via the environment:

```bash
# JSON array:
GATEWAY_API_KEYS='[{"key":"sk-key-1","name":"Key 1"},{"key":"sk-key-2","name":"Key 2"}]'

# Or comma-separated bare keys:
GATEWAY_API_KEYS=sk-key-1,sk-key-2
```

### Protected Endpoints

| Endpoint | Auth Required |
|---|---|
| `GET /` | No |
| `GET /health` | No |
| `GET /ready` | No |
| All others (`/v1/*`, `/api/*`) | Yes |

### Usage Tracking

For every authenticated request, the `UsageTracker` records per-key:

- `totalRequests` — request count
- `totalTokens` — total tokens (prompt + completion) from provider responses
- `providerUsage` — per-provider request counts
- `modelUsage` — per-model request counts
- `lastUsed` — last request timestamp
- `createdAt` — first-seen timestamp

All stats are in-memory for the lifetime of the process.

### Key Rotation

Multiple active keys can be configured simultaneously. Rotate keys by
adding new entries to `config/apiKeys.json` and setting old keys to
`status: "inactive"` (or removing them). The `UsageTracker` keys stats by
the key `id` (not the raw key value), so usage data survives value
rotation when the `id` is kept stable.

### Error Responses

Auth errors use the OpenAI-compatible error envelope:

| HTTP | `code` | Trigger |
|---|---|---|
| 401 | `missing_api_key` | No `Authorization` header |
| 401 | `invalid_api_key` | Key not found in the store |
| 401 | `disabled_api_key` | Key `status` is `"inactive"` |
| 401 | `expired_api_key` | `expiresAt` has passed |
| 403 | `model_forbidden` | Key's `allowedModels` doesn't include the model |
| 403 | `provider_forbidden` | Key's `allowedProviders` doesn't include any serving provider |

See `examples/auth.integration.js` for the full test suite.

## Metrics & Monitoring

The gateway exposes three monitoring endpoints (public — no auth required):

### `GET /metrics`

Returns the full metrics snapshot: global counters, per-provider counters,
latency percentiles, token usage, and derived counts.

```json
{
  "uptimeMs": 3600000,
  "global": {
    "totalRequests": 1000,
    "successfulRequests": 950,
    "failedRequests": 50,
    "retryCount": 30,
    "fallbackCount": 5,
    "averageLatencyMs": 120,
    "p50LatencyMs": 95,
    "p95LatencyMs": 280,
    "p99LatencyMs": 450,
    "promptTokens": 50000,
    "completionTokens": 20000,
    "totalTokens": 70000,
    "totalCost": 0,
    "sampleCount": 1000
  },
  "providers": {
    "openai": {
      "totalRequests": 600,
      "successfulRequests": 580,
      "failedRequests": 20,
      "retryCount": 15,
      "fallbackCount": 3,
      "averageLatencyMs": 110,
      "p50LatencyMs": 90,
      "p95LatencyMs": 250,
      "p99LatencyMs": 400,
      "promptTokens": 30000,
      "completionTokens": 12000,
      "totalTokens": 42000,
      "totalCost": 0,
      "sampleCount": 600
    }
  },
  "activeApiKeys": 3,
  "activeProviders": 2
}
```

### `GET /stats`

Returns a lightweight stats summary (no latency histograms):

```json
{
  "uptimeMs": 3600000,
  "global": {
    "totalRequests": 1000,
    "successfulRequests": 950,
    "failedRequests": 50,
    "retryCount": 30,
    "fallbackCount": 5,
    "averageLatencyMs": 120,
    "p50LatencyMs": 95,
    "p95LatencyMs": 280,
    "p99LatencyMs": 450,
    "promptTokens": 50000,
    "completionTokens": 20000,
    "totalTokens": 70000,
    "totalCost": 0
  },
  "providers": {
    "openai": {
      "totalRequests": 600,
      "successfulRequests": 580,
      "failedRequests": 20,
      "retryCount": 15,
      "fallbackCount": 3,
      "averageLatencyMs": 110,
      "successRate": 96.67
    }
  },
  "activeApiKeys": 3,
  "activeProviders": 2
}
```

### `GET /health/providers`

Returns per-provider health with circuit-breaker state:

```json
{
  "providers": {
    "openai": {
      "providerId": "openai",
      "online": true,
      "circuitState": "closed",
      "consecutiveFailures": 0,
      "consecutiveSuccesses": 150,
      "lastSuccess": "2024-01-01T12:00:00.000Z",
      "lastFailure": "2024-01-01T11:45:00.000Z",
      "averageLatencyMs": 110,
      "successRate": 96.67,
      "totalSuccess": 580,
      "totalFailure": 20
    }
  }
}
```

### Circuit Breaker

Each provider has a circuit breaker with three states:

| State | Behaviour |
|---|---|
| `closed` | All requests allowed. After `failureThreshold` (default 5) consecutive failures, the circuit opens. |
| `open` | Requests blocked (provider skipped). After `resetTimeoutMs` (default 30s), the circuit transitions to half-open. |
| `half-open` | A limited number of probe requests (default 1) are allowed. A success closes the circuit; a failure re-opens it. |

Providers that recover automatically become available again — no manual
intervention required. The `RequestExecutor` checks `isAvailable(providerId)`
before routing a request to a provider; providers with an open circuit are
skipped (treated as a fallback candidate).

### Automatic Health Checks

The `ProviderHealthMonitor` can run a periodic health-check timer
(`startHealthChecks()`) that issues a lightweight `GET /models` probe to each
provider whose circuit is not closed-and-healthy. A successful probe records
a success (recovering an open circuit); a failed probe records a failure.
The timer is `unref`ed so it never keeps the process alive.

### Architecture

- `MetricsCollector` (`src/services/metricsCollector.js`) — central,
  non-blocking aggregation. Hooks into the `RequestExecutor` at four points
  (request start, attempt success, attempt failure, fallback). All updates
  are O(1) synchronous operations. Latency percentiles are computed on demand
  from a bounded sample buffer.
- `ProviderHealthMonitor` (`src/services/providerHealthMonitor.js`) —
  per-provider circuit-breaker state machine with automatic recovery.

See `examples/metrics.integration.js` for the full test suite.

## Rate Limiting & Quota Management

The gateway includes a centralized `RateLimiter`
(`src/services/rateLimiter.js`) that enforces rate limits, burst limits,
concurrency limits, and quotas across four scopes. When disabled (the
default), the middleware passes through with zero overhead.

### Scopes

| Scope | Description |
|---|---|
| Global | Applies to all requests across all keys/providers/models |
| Per API Key | Each gateway API key has its own limit |
| Per Provider | Each provider id has its own limit |
| Per Model | Each model id has its own limit |

### Algorithms

| Algorithm | Description |
|---|---|
| `token_bucket` (default) | Refills at `requestsPerMinute`; burst capacity up to `burst` tokens. Supports short bursts. |
| `fixed_window` | Counter resets at the start of each 1-minute window. |
| `sliding_window` | Rolling 1-minute window of timestamps. Most accurate, slight overhead. |

### Limits & Quotas

| Limit | Scope | Description |
|---|---|---|
| `requestsPerMinute` | all | Rate limit (RPM) |
| `burst` | all | Max burst capacity (token bucket only) |
| `concurrent` | global/key/provider | Max in-flight requests |
| `dailyRequestQuota` | per-key | Max requests per calendar day |
| `dailyTokenQuota` | per-key | Max tokens per calendar day |
| `monthlyTokenQuota` | per-key | Max tokens per 30-day month |

### Configuration

Copy the example and edit:

```bash
cp config/rateLimit.example.json config/rateLimit.json
```

Or configure via environment variables (override file values):

```bash
RATE_LIMIT_ENABLED=true
RATE_LIMIT_ALGORITHM=token_bucket
RATE_LIMIT_GLOBAL_RPM=1000
RATE_LIMIT_GLOBAL_BURST=100
RATE_LIMIT_GLOBAL_CONCURRENT=50
RATE_LIMIT_PER_KEY_RPM=100
RATE_LIMIT_PER_KEY_BURST=20
RATE_LIMIT_PER_KEY_CONCURRENT=10
RATE_LIMIT_PER_KEY_DAILY_REQUESTS=10000
RATE_LIMIT_PER_KEY_DAILY_TOKENS=1000000
RATE_LIMIT_PER_KEY_MONTHLY_TOKENS=30000000
RATE_LIMIT_PER_PROVIDER_RPM=500
RATE_LIMIT_PER_PROVIDER_CONCURRENT=20
RATE_LIMIT_PER_MODEL_RPM=200
RATE_LIMIT_PER_MODEL_BURST=20
```

### Response Headers

Successful responses include OpenAI-compatible rate-limit headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1700000060
```

When a limit is exceeded, the response is `429` with `Retry-After`:

```
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1700000060
Retry-After: 45

{
  "error": {
    "message": "Rate limit exceeded. Retry after 45000ms.",
    "type": "rate_limit_exceeded",
    "param": null,
    "code": "rate_limit_exceeded",
    "request_id": "..."
  }
}
```

### Metrics Integration

Rate-limit rejections are counted by the `MetricsCollector` as
`rateLimitRejections` (global + per-provider). Visible in `GET /metrics` and
`GET /stats`.

### Architecture

- `RateLimiter` — in-memory state machine; three algorithm implementations
  (`FixedWindow`, `SlidingWindow`, `TokenBucket`); `QuotaTracker` for
  daily/monthly quotas; `ConcurrencyTracker` for in-flight limits.
- `createRateLimitMiddleware` — runs after auth, before routes; extracts
  scope keys, calls `rateLimiter.check()`, sets headers, returns `429` on
  rejection, releases concurrency on response finish.
- `MetricsCollector` — `recordRateLimitRejection()` for rejected-request counts.

See `examples/rateLimit.integration.js` for the full test suite.

## Admin Dashboard

The gateway includes a built-in admin dashboard — a single-page web UI at
`GET /admin` backed by an authenticated admin API at `/admin/api/*`.

### Accessing the Dashboard

Open `http://127.0.0.1:3000/admin` in a browser. The admin API requires an
API key with `role: "admin"` (see `config/apiKeys.example.json`):

```json
{
  "id": "admin-key",
  "key": "sk-gateway-admin-change-me",
  "role": "admin",
  "status": "active"
}
```

When no API keys are configured (open-gateway mode), the admin API is also
accessible without auth. Non-admin keys receive `403 admin_forbidden`.

### Dashboard Tabs

| Tab | Description |
|---|---|
| **Overview** | Cards: requests, tokens, cost, active/healthy providers, active API keys, rate-limit rejections, average/p50/p95/p99 latency, retries, fallbacks, uptime, config reloads |
| **Providers** | List all providers with enable/disable, priority, health status, test connectivity, manual reload |
| **API Keys** | List all keys with role, status, usage stats; create/delete/enable/disable keys |
| **Models** | Model registry with providers, capabilities, health |
| **Logs** | Real-time request log with filtering by provider, status, model |
| **Health** | Per-provider circuit breaker state, consecutive failures, success rate, average latency, last success/failure |
| **Config** | Current configuration view with reload-from-disk button |

### Admin API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/admin/api/overview` | Dashboard overview cards |
| GET | `/admin/api/providers` | List all providers |
| PUT | `/admin/api/providers/:id` | Update provider config (live edit) |
| POST | `/admin/api/providers/:id/test` | Test provider connectivity |
| POST | `/admin/api/reload` | Manual config reload |
| GET | `/admin/api/keys` | List API keys with usage |
| POST | `/admin/api/keys` | Create API key |
| DELETE | `/admin/api/keys/:id` | Delete API key |
| PUT | `/admin/api/keys/:id` | Update key (enable/disable/expire/restrict) |
| GET | `/admin/api/keys/:id/usage` | Per-key usage stats |
| GET | `/admin/api/models` | Model registry |
| GET | `/admin/api/monitoring` | Full metrics snapshot |
| GET | `/admin/api/logs` | Request log (filterable: `?providerId=&apiKeyId=&model=&status=&limit=`) |
| GET | `/admin/api/health` | Provider health overview |
| GET | `/admin/api/routing` | Current routing strategies (provider/connection/key) + available options + descriptions |
| PUT | `/admin/api/routing` | Update routing strategies (validated, hot-applied, persisted to `config/routing.json`) |
| GET | `/admin/api/routing/status` | Aggregated routing status (providers/connections/health counts) |
| GET | `/admin/api/routing/activity` | Recent routing decisions (time/model/provider/connection/strategy/latency/status — no secrets) |
| GET | `/admin/api/routing/rules` | List model-based routing rules |
| POST | `/admin/api/routing/rules` | Create a model-based routing rule (`{id?, model, strategy?, providerOrder?, connectionIds?, enabled?}`) |
| PUT | `/admin/api/routing/rules/:id` | Update a model-based routing rule |
| DELETE | `/admin/api/routing/rules/:id` | Delete a model-based routing rule |
| GET | `/admin/api/config` | Current configuration |
| PUT | `/admin/api/config` | Live edit + write to disk + reload |

### Routing Management

The gateway chooses a provider (and a connection within it) per request using
the existing `ModelRouter` + `RoutingStrategy` + `AccountManager` pipeline —
no separate router. Supported strategies:

| Strategy | Behaviour |
|---|---|
| `priority` (default) | Highest-priority eligible candidate first |
| `round-robin` | Stateful sequential rotation (identity-anchored cursor; concurrency-safe) |
| `least-used` | Lowest current usage first |
| `weighted` | Weighted random (long-run distribution ≈ weights) |
| `random` | Uniform random |
| `fastest-response` / `lowest-latency` | Lowest historical latency (falls back to priority with no data) |

Configuration scopes (all hot-reloadable, persisted to `config/routing.json`):

- `strategy` — global provider routing
- `connectionStrategy` — global connection (account) routing
- `keySelectionStrategy` — per-provider API key selection
- `providerStrategies` — per-provider connection strategy overrides

Model-based routing rules (`config/routingRules.json` → `modelRules`) bind a
model to a strategy, an explicit provider order, and an optional connection
allow-list. API key provider/model permissions are always enforced before
routing; disabled providers/connections and open-circuit providers are never
selected. Failover honours 401 (auth-marked, no blind retry), 429, 5xx, and
timeouts — bounded by the per-provider retry budget, never infinite.

Changes via `PUT /admin/api/routing` or the Dashboard → Routing page apply to
the next request without restarting the gateway and without dropping
in-flight requests. Invalid strategies are rejected with `400` and the
running configuration is left untouched; a missing/invalid config file falls
back to the safe `priority` default.

### Security

- The admin HTML page is served without API auth (the UI loads data via the
  admin API, which requires the `admin` role).
- Admin API endpoints require `role: "admin"` on the Bearer token.
- Non-admin keys receive `403 admin_forbidden`.
- In open-gateway mode (no keys configured), admin access is unrestricted.

See `examples/admin.integration.js` for the full test suite.

## Dashboard Console (Next.js)

In addition to the built-in single-page `/admin` UI, a full management console
lives in `dashboard/` — a Next.js 14 + TypeScript + Tailwind CSS app using
Recharts and Lucide icons. It talks **only** to the existing backend admin API
(`/admin/api/*`); it does not introduce any second registry, router, auth, key,
quota, usage, or backup system.

### Stack

- Next.js 14 (App Router), TypeScript (strict), Tailwind CSS
- Recharts (charts), Lucide (icons)
- Dependency-free data layer (`useQuery` hook) and a single centralized API
  client in `dashboard/src/lib/api/`

### Setup

```bash
cd dashboard
npm install
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_BACKEND_URL` | `http://127.0.0.1:3000` | Backend the dashboard proxies `/api/gateway/*` to (see `dashboard/next.config.js`) |
| `NEXT_PUBLIC_ENV` | `development` | Environment badge shown in the header |

The dashboard proxies all backend calls same-origin through
`/api/gateway/*`, so the admin Bearer token stays same-origin and is held only
in memory + `sessionStorage` (never `localStorage`, never in a URL, never
logged).

### Development

```bash
# terminal 1 — backend
npm start                    # or: npm run dev

# terminal 2 — dashboard
cd dashboard && npm run dev  # http://127.0.0.1:3100
```

### Production build & run

```bash
cd dashboard
npm run build
npm start                    # serves on port 3100
```

### Validation commands

```bash
cd dashboard
npm test        # component/logic smoke tests
npm run typecheck
npm run lint
npm run build
```

### Sign-in

Open `http://127.0.0.1:3100`, then sign in with an API key that has
`role: "admin"`. The key is validated server-side against
`GET /admin/api/system`; authorization always remains server-side.

### Routes

`/dashboard`, `/api-keys`, `/api-keys/new`, `/api-keys/[id]`, `/providers`,
`/providers/[id]`, `/models`, `/connections`, `/usage`, `/quota`, `/backups`,
`/settings`, `/logs`, `/system-health`, plus `/login`, `/forbidden`, and 404 /
error pages.

### Security notes

- Never displays `keyHash`, provider credentials, or OAuth tokens.
- A newly created (or rotated) API key plaintext is shown exactly once and is
  never persisted to `localStorage` or logged.
- All numbers come from real backend analytics — no hardcoded/demo data.

## Running

### Development (with auto‑restart via nodemon)

```bash
npm run dev
```

### Production

```bash
npm start
```

The server will start and log a message like:

```
AI Gateway running on port 3000
```

If `AI_API_KEY` is missing, the server will exit immediately with:

```
FATAL: AI_API_KEY environment variable is not set. Aborting.
```

## API Endpoints

### `GET /`
Returns basic information about the service and lists available endpoints.

**Response (200):**

### `GET /health`
Returns the service status, server uptime, version, and timestamp.

**Response (200):**

### `GET /v1/models`
### `GET /v1/models/:id`

OpenAI-compatible Models endpoints backed by the `ModelRegistry`
(`src/services/modelRegistry.js`). The registry aggregates the model
catalogues of every enabled provider (via each adapter's `listModels()`
method), deduplicates identical model ids across providers, tracks
per-model capabilities and serving providers internally, and caches the
result with a configurable TTL. If one provider fails during aggregation,
the remaining providers are still collected.

Only the OpenAI-compatible `{ id, object, created, owned_by }` shape is
exposed to the client; internal metadata (providers, capabilities) is
tracked but not returned in the API response.

**List all models:**

```bash
curl http://127.0.0.1:3000/v1/models
```

**Response (200):**

```json
{
  "object": "list",
  "data": [
    { "id": "deepseek-chat", "object": "model", "created": 1700000000, "owned_by": "deepseek" },
    { "id": "gpt-4o", "object": "model", "created": 1700000000, "owned_by": "openai" },
    { "id": "gpt-4o-mini", "object": "model", "created": 1700000000, "owned_by": "openai" }
  ]
}
```

**Retrieve a single model:**

```bash
curl http://127.0.0.1:3000/v1/models/gpt-4o
```

**Response (200):**

```json
{
  "id": "gpt-4o",
  "object": "model",
  "created": 1700000000,
  "owned_by": "openai"
}
```

A request for an unknown model id returns `404` with `code: model_not_found`.

#### Caching

The aggregated model list is cached for 60 seconds (default). The first
request after the cache expires triggers a transparent refresh. The cache
can be manually invalidated via `modelRegistry.invalidate()` (e.g. from an
admin endpoint or after adding a new provider config).

#### Provider Discovery

Each `ProviderAdapter` exposes:

- `listModels(provider)` — returns the model ids the provider serves (reads
  `provider.supportedModels` from config by default)
- `supportsModel(provider, modelId)` — whether the provider serves a model
- `capabilities()` / `capabilityInfo()` — the provider's capability set

The `ModelRegistry` calls `listModels()` on every enabled provider's adapter
and merges the results into a single deduplicated registry. Disabled
providers are excluded. A provider whose adapter throws during `listModels()`
is logged and skipped — the remaining providers are still collected.

### `GET /v1/info`
Returns current app configuration (name, version, description, default model).

### `POST /api/v1/generate`
Accepts a prompt (and optional model) and returns generated text from the configured AI provider.

### `POST /v1/chat/completions`

OpenAI-compatible Chat Completions endpoint. The gateway routes the request to
the provider that supports the requested model (selected via the `ModelRouter`
and `ProviderManager`), forwards it through the shared `HttpClient`, and
returns the provider's response in OpenAI format.

**Request body** (JSON):

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | string | yes | A model id that exists in some `config/providers/*.json` |
| `messages` | array | yes | At least one message object `{ role, content }` |
| `temperature`, `max_tokens`, `top_p`, `n`, `stop`, `stream`, ... | any | no | Forwarded to the provider (stream is forced to `false` until streaming lands) |

**Example:**

```bash
curl -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Say hello in one sentence." }
    ]
  }'
```

**Response (200):** an OpenAI-compatible `chat.completion` object:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hello! How can I help you?" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20 }
}
```

The response includes an `X-Request-Id` header (echoed if the client sends one
via the `X-Request-Id` request header, otherwise generated). See
`examples/chatCompletions.curl.sh` for more examples.

### `POST /v1/responses`

OpenAI-compatible Responses API endpoint. This is a thin **adapter** on top of
the same `RequestExecutor` / `HttpClient` / `ApiKeyManager` / `ModelRouter`
pipeline used by Chat Completions — no transport code is duplicated. The
adapter translates the Responses request into a Chat Completions provider
payload and normalizes the provider response back into the Responses format.

**Request body** (JSON):

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | string | yes | A model id that exists in some `config/providers/*.json` |
| `input` | string \| array | yes | A prompt string, or an array of input items (`string` or `{ role, content }`) |
| `instructions` | string | no | Prepended as a system message |
| `temperature` | number | no | Forwarded as `temperature` |
| `max_output_tokens` | number | no | Forwarded as `max_tokens` |
| `metadata` | object | no | Optional metadata (not forwarded) |

**Example:**

```bash
curl -X POST http://127.0.0.1:3000/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": "Say hello in one sentence.",
    "instructions": "Be concise."
  }'
```

**Response (200):** an OpenAI-compatible `response` object:

```json
{
  "id": "resp_...",
  "object": "response",
  "created_at": 1700000000,
  "model": "deepseek-chat",
  "status": "completed",
  "output": [
    {
      "type": "message",
      "id": "msg_...",
      "status": "completed",
      "role": "assistant",
      "content": [ { "type": "output_text", "text": "Hello! How can I help you?" } ]
    }
  ],
  "usage": { "input_tokens": 12, "output_tokens": 8, "total_tokens": 20 }
}
```

See `examples/responses.curl.sh` for more examples.

### `POST /v1/embeddings`

OpenAI-compatible Embeddings endpoint. The gateway routes the request to a
provider that supports the requested model **and** declares the
`supportsEmbeddings` capability (see the Provider Support table below). The
provider's response is normalized into the OpenAI `list` shape. Retry and
fallback are inherited from the shared `RequestExecutor`.

Embeddings are **strictly non-streaming** — a request with `"stream": true`
is rejected with `400`.

**Request body** (JSON):

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | string | yes | A model id that exists in some `config/providers/*.json` and whose provider supports embeddings |
| `input` | string \| string[] | yes | A single string or an array of strings |
| `encoding_format` | string | no | `"float"` (default) or `"base64"` |
| `dimensions` | number | no | Positive integer; forwarded when the provider supports it |

**Example (single input):**

```bash
curl -X POST http://127.0.0.1:3000/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-3-small",
    "input": "The quick brown fox"
  }'
```

**Example (multiple inputs):**

```bash
curl -X POST http://127.0.0.1:3000/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-3-small",
    "input": ["first text", "second text", "third text"],
    "encoding_format": "float",
    "dimensions": 256
  }'
```

**Response (200):** an OpenAI-compatible `list` object:

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "embedding": [0.0123, -0.0456, 0.0789, "..."],
      "index": 0
    },
    {
      "object": "embedding",
      "embedding": [0.0234, -0.0567, 0.0890, "..."],
      "index": 1
    }
  ],
  "model": "text-embedding-3-small",
  "usage": {
    "prompt_tokens": 8,
    "total_tokens": 8
  }
}
```

#### Provider Embeddings Support

| Provider | `supportsEmbeddings` | Notes |
|---|---|---|
| OpenAI | ✅ | Canonical `/v1/embeddings` |
| OpenRouter | ✅ | OpenAI-compatible |
| DeepSeek | ✅ | OpenAI-compatible |
| NVIDIA (NIM) | ✅ | OpenAI-compatible |
| Google Gemini (OpenAI-compat) | ✅ | OpenAI-compatible route |
| Databricks | ✅ | Foundation Model endpoints |
| TokenFaucet | ✅ | OpenAI-compatible |
| Anthropic | ❌ | Returns `400 embeddings_not_supported` |

A request against a model served only by a provider whose adapter declares
`supportsEmbeddings: false` (e.g. Anthropic) is rejected with:

```json
{
  "error": {
    "message": "Operation \"embeddings\" is not supported for model \"claude-3-5-sonnet\"",
    "type": "invalid_request_error",
    "param": null,
    "code": "embeddings_not_supported",
    "request_id": "..."
  }
}
```

See `examples/embeddings.integration.js` for the full test suite.

### `POST /v1/images/generations`
### `POST /v1/images/edits`
### `POST /v1/images/variations`

OpenAI-compatible Images API endpoints. The gateway routes each request to a
provider that supports the requested model **and** declares the
`supportsImages` capability (see the Provider Support table below). The
provider's response is normalized into the OpenAI `images` shape. Retry and
fallback are inherited from the shared `RequestExecutor`.

- **Generations** (`/v1/images/generations`) accepts a **JSON** body.
- **Edits** (`/v1/images/edits`) and **Variations** (`/v1/images/variations`)
  accept **`multipart/form-data`** (file uploads). The gateway uses `multer`
  to receive the `image` (and optional `mask`) files, then forwards them to
  the provider as a `multipart/form-data` request.

Images are **strictly non-streaming** — a request with `"stream": true` is
rejected with `400`.

#### Request fields

| Field | Type | Generations | Edits | Variations | Notes |
|---|---|---|---|---|---|
| `model` | string | required | required | required | Routes to a provider in `config/providers/*.json` |
| `prompt` | string | required | required | — | Not accepted for variations |
| `image` | file | — | required | required | PNG, up to 25MB (multipart) |
| `mask` | file | — | optional | — | Optional transparent PNG; not accepted for variations |
| `n` | int | optional | optional | optional | 1–10 (default 1) |
| `size` | string | optional | optional | optional | `256x256`, `512x512`, `1024x1024`, `1792x1024`, `1024x1792` |
| `quality` | string | optional | — | — | `standard` \| `hd` |
| `style` | string | optional | — | — | `vivid` \| `natural` |
| `response_format` | string | optional | optional | optional | `url` \| `b64_json` (default `url`) |
| `user` | string | optional | optional | optional | End-user identifier |

#### Examples

**Generations (JSON):**

```bash
curl -X POST http://127.0.0.1:3000/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dall-e-3",
    "prompt": "A siamese cat in a sunlit room",
    "n": 1,
    "size": "1024x1024",
    "quality": "hd",
    "style": "natural",
    "response_format": "url"
  }'
```

**Edits (multipart/form-data):**

```bash
curl -X POST http://127.0.0.1:3000/v1/images/edits \
  -H "Authorization: Bearer $KEY" \
  -F model=dall-e-3 \
  -F prompt="Remove the background" \
  -F size=512x512 \
  -F image=@cat.png \
  -F mask=@mask.png
```

**Variations (multipart/form-data):**

```bash
curl -X POST http://127.0.0.1:3000/v1/images/variations \
  -H "Authorization: Bearer $KEY" \
  -F model=dall-e-3 \
  -F n=2 \
  -F size=256x256 \
  -F image=@cat.png
```

#### Response (200)

OpenAI-compatible `images` object (returned for all three endpoints):

```json
{
  "created": 1700000000,
  "data": [
    { "url": "https://.../image1.png" },
    { "url": "https://.../image2.png" }
  ]
}
```

When `response_format` is `"b64_json"`, each item carries `b64_json` instead:

```json
{
  "created": 1700000000,
  "data": [
    { "b64_json": "iVBORw0KGgo..." }
  ]
}
```

The gateway normalizes provider responses that use alternative keys (e.g.
`b64` or a bare array of URLs) into this canonical OpenAI shape.

#### Provider Images Support

| Provider | `supportsImages` | Notes |
|---|---|---|
| OpenAI | ✅ | Canonical `/v1/images/*` (DALL·E) |
| OpenRouter | ✅ | OpenAI-compatible |
| Google Gemini (OpenAI-compat) | ✅ | OpenAI-compatible route |
| NVIDIA (NIM) | ✅ | OpenAI-compatible |
| Databricks | ✅ | Foundation Model endpoints |
| TokenFaucet | ✅ | OpenAI-compatible |
| DeepSeek | ❌ | Text/embeddings only |
| Anthropic | ❌ | Vision input only, no image generation |

A request against a model served only by a provider whose adapter declares
`supportsImages: false` (e.g. Anthropic or DeepSeek) is rejected with:

```json
{
  "error": {
    "message": "Operation \"images.generations\" is not supported for model \"claude-3-5-sonnet\"",
    "type": "invalid_request_error",
    "param": null,
    "code": "images_not_supported",
    "request_id": "..."
  }
}
```

#### Limitations

- Image edits and variations require the provider to accept
  `multipart/form-data`; the gateway forwards the uploaded `image`/`mask`
  files verbatim. Providers that only accept base64-encoded image bodies are
  not currently supported through this endpoint (override
  `buildImagesPayload` in the provider's adapter).
- The 25MB per-file upload limit matches OpenAI's documented maximum.
- `quality` and `style` are forwarded as-is; providers that do not support
  them may ignore or reject the request.

See `examples/images.integration.js` for the full test suite.

### `POST /v1/audio/speech`
### `POST /v1/audio/transcriptions`
### `POST /v1/audio/translations`

OpenAI-compatible Audio API endpoints. The gateway routes each request to a
provider that supports the requested model **and** declares the
`supportsAudio` capability (see the Provider Support table below). Retry and
fallback are inherited from the shared `RequestExecutor`.

- **Speech** (`/v1/audio/speech`) accepts a **JSON** body and returns **raw
  audio bytes** (binary) for audio formats, or a JSON body when
  `response_format` is `json`/`verbose_json`. The response `Content-Type` is
  set to the matching audio format (`audio/mpeg` for `mp3`, etc.).
- **Transcriptions** (`/v1/audio/transcriptions`) and **Translations**
  (`/v1/audio/translations`) accept **`multipart/form-data`** (audio file
  upload). Transcriptions preserve the source language; translations always
  translate to English (following OpenAI behaviour — `language` is not
  accepted for translations).

Audio is **strictly non-streaming** — a request with `"stream": true` is
rejected with `400`.

#### Request fields

##### Speech (JSON body)

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | string | yes | Routes to a provider in `config/providers/*.json` (e.g. `tts-1`) |
| `input` | string | yes | The text to synthesize (max 4096 chars on OpenAI) |
| `voice` | string | yes | Voice id (e.g. `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`) |
| `response_format` | string | no | `mp3` (default), `opus`, `aac`, `flac`, `wav`, `pcm`, `json`, `verbose_json` |
| `speed` | number | no | 0.25–4.0 (default 1.0) |

##### Transcriptions / Translations (multipart/form-data)

| Field | Type | Transcriptions | Translations | Notes |
|---|---|---|---|---|
| `model` | string | required | required | e.g. `whisper-1` |
| `file` | file | required | required | Audio file (mp3, wav, m4a, webm, etc., up to 25MB) |
| `language` | string | optional | — | ISO-639-1 two-letter code; NOT accepted for translations |
| `prompt` | string | optional | optional | Context to guide the transcription |
| `response_format` | string | optional | optional | `json` (default), `text`, `srt`, `verbose_json`, `vtt` |
| `temperature` | number | optional | optional | 0–1 (default 0) |

#### Examples

**Speech (JSON → binary audio):**

```bash
curl -X POST http://127.0.0.1:3000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tts-1",
    "input": "The quick brown fox jumps over the lazy dog.",
    "voice": "alloy",
    "response_format": "mp3",
    "speed": 1.0
  }' --output speech.mp3
```

**Transcription (multipart/form-data):**

```bash
curl -X POST http://127.0.0.1:3000/v1/audio/transcriptions \
  -H "Authorization: Bearer $KEY" \
  -F model=whisper-1 \
  -F language=en \
  -F response_format=json \
  -F file=@audio.mp3
```

**Translation (multipart/form-data — always to English):**

```bash
curl -X POST http://127.0.0.1:3000/v1/audio/translations \
  -H "Authorization: Bearer $KEY" \
  -F model=whisper-1 \
  -F file=@french-audio.mp3
```

#### Responses

**Speech** — raw audio bytes (binary). The `Content-Type` header reflects the
requested format (`audio/mpeg` for `mp3`, `audio/ogg` for `opus`, etc.). When
`response_format` is `json` or `verbose_json`, a JSON body is returned instead:

```json
{ "text": "..." }
```

**Transcriptions / Translations** — JSON (or text/srt/vtt depending on
`response_format`). Default JSON shape:

```json
{
  "text": "The quick brown fox jumps over the lazy dog."
}
```

The gateway normalizes provider responses that use alternative shapes (e.g. a
bare string transcript) into the canonical `{ text }` form.

#### Provider Audio Support

| Provider | `supportsAudio` | Notes |
|---|---|---|
| OpenAI | ✅ | Canonical `/v1/audio/*` (TTS + Whisper) |
| OpenRouter | ✅ | OpenAI-compatible (routes to audio-capable models) |
| NVIDIA (NIM) | ✅ | OpenAI-compatible audio endpoints |
| Databricks | ✅ | Foundation Model audio endpoints |
| Google Gemini (OpenAI-compat) | ❌ | No `/audio/*` on the OpenAI-compat route |
| DeepSeek | ❌ | Text/embeddings only |
| Anthropic | ❌ | No audio API |
| TokenFaucet | ❌ | No audio API |

A request against a model served only by a provider whose adapter declares
`supportsAudio: false` is rejected with:

```json
{
  "error": {
    "message": "Operation \"audio.speech\" is not supported for model \"claude-3-5-sonnet\"",
    "type": "invalid_request_error",
    "param": null,
    "code": "audio_not_supported",
    "request_id": "..."
  }
}
```

#### Limitations

- Speech returns the provider's raw audio bytes verbatim. The gateway does not
  transcode between audio formats — if the provider does not support the
  requested `response_format`, it may reject the request.
- Transcription/translation forward the uploaded audio file to the provider as
  `multipart/form-data` using the `form-data` library (same mechanism as the
  Images API). The 25MB per-file limit matches OpenAI's documented maximum.
- `language` is only accepted for transcriptions; translations always target
  English (OpenAI behaviour).

See `examples/audio.integration.js` for the full test suite.

### Tool Calling / Function Calling

`POST /v1/chat/completions` supports the full OpenAI tool-calling surface:

- `tools` — array of function definitions
- `tool_choice` — `"auto"`, `"none"`, `"required"`, or `{ type:"function", function:{ name } }`
- `parallel_tool_calls` — boolean (allow the model to call multiple tools in one response)
- assistant `tool_calls` — `finish_reason: "tool_calls"` with `message.tool_calls[]`
- `tool` role messages — return tool results back to the model (`{ role:"tool", tool_call_id, content }`)
- streaming — incremental `tool_call` argument deltas (exactly like OpenAI)

The gateway routes tool-calling requests only to providers whose adapter
declares `supportsTools`. Provider-specific tool formats (e.g. Anthropic
`tool_use` content blocks, `input_schema`, `tool_result`) are mapped
transparently by the provider's adapter — the gateway's external contract stays
OpenAI-shaped. No provider-specific tool logic lives outside the adapter.

#### Request fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `tools` | array | no | Each item `{ type:"function", function:{ name, description, parameters } }` |
| `tool_choice` | string \| object | no | `"auto"` (default), `"none"`, `"required"`, or `{ type:"function", function:{ name } }` |
| `parallel_tool_calls` | boolean | no | Allow multiple tool calls in one response |

Tool definitions use the OpenAI format:

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get the weather for a location",
    "parameters": {
      "type": "object",
      "properties": { "location": { "type": "string" } },
      "required": ["location"]
    }
  }
}
```

#### Example: single tool call

```bash
curl -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{ "role": "user", "content": "What is the weather in Paris?" }],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the weather for a location",
        "parameters": {
          "type": "object",
          "properties": { "location": { "type": "string" } },
          "required": ["location"]
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

**Response (200):**

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "gpt-4o",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_abc",
        "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"location\":\"Paris\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }],
  "usage": { "prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70 }
}
```

#### Example: returning a tool result (multi-turn)

Send the assistant's `tool_calls` back with the tool's output in a `tool`
role message, then let the model produce a final answer:

```bash
curl -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      { "role": "user", "content": "What is the weather in Paris?" },
      { "role": "assistant", "content": null, "tool_calls": [{ "id": "call_abc", "type": "function", "function": { "name": "get_weather", "arguments": "{\"location\":\"Paris\"}" } }] },
      { "role": "tool", "tool_call_id": "call_abc", "content": "{\"temperature\":22}" }
    ],
    "tools": [{ "type": "function", "function": { "name": "get_weather", "parameters": { "type": "object", "properties": { "location": { "type": "string" } } } } }]
  }'
```

#### Example: parallel tool calls

```bash
curl -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{ "role": "user", "content": "Weather in Paris and calculate 2+2" }],
    "tools": [
      { "type": "function", "function": { "name": "get_weather", "parameters": { "type": "object", "properties": { "location": { "type": "string" } } } } },
      { "type": "function", "function": { "name": "calculator", "parameters": { "type": "object", "properties": { "expr": { "type": "string" } } } } }
    ],
    "parallel_tool_calls": true
  }'
```

#### Example: streaming tool calls

```bash
curl -N -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{ "role": "user", "content": "Weather in Paris?" }],
    "tools": [{ "type": "function", "function": { "name": "get_weather", "parameters": { "type": "object", "properties": { "location": { "type": "string" } } } } }],
    "stream": true
  }'
```

The SSE stream emits incremental `tool_call` deltas exactly like OpenAI: the
first delta carries `tool_calls[].id` + `function.name`, subsequent deltas
carry `function.arguments` fragments, and the final chunk has
`finish_reason: "tool_calls"`:

```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"loc"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\":\"Paris\"}"}}]}}]}
data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
data: [DONE]
```

#### Provider Tool Support

| Provider | `supportsTools` | Notes |
|---|---|---|
| OpenAI | ✅ | Canonical OpenAI tool calling (pass-through) |
| OpenRouter | ✅ | OpenAI-compatible (pass-through) |
| Google Gemini (OpenAI-compat) | ✅ | OpenAI-compatible route |
| DeepSeek | ✅ | OpenAI-compatible (pass-through) |
| NVIDIA (NIM) | ✅ | OpenAI-compatible |
| Databricks | ✅ | OpenAI-compatible |
| Anthropic | ✅ | Mapped: OpenAI tools ↔ Anthropic `tool_use` / `input_schema` |
| TokenFaucet | ❌ | No tool calling |

A request that carries `tools` (or `tool_choice`) against a model served only
by a provider whose adapter declares `supportsTools: false` is rejected with:

```json
{
  "error": {
    "message": "Operation \"chat\" is not supported for model \"tf-llama-3-70b\"",
    "type": "invalid_request_error",
    "param": null,
    "code": "tools_not_supported",
    "request_id": "..."
  }
}
```

Requests **without** tools are never gated — they route normally to any
chat-capable provider regardless of `supportsTools`.

#### Limitations

- Tool argument fragments are forwarded as raw strings (matching OpenAI
  streaming). The gateway does not parse or validate accumulated JSON
  arguments mid-stream — clients are expected to buffer and parse the
  fragments, exactly as with the OpenAI API.
- The Anthropic adapter maps `tool_choice: "none"` to `{ type: "auto" }`
  (Anthropic has no "disable tools" option — to disable tools, simply omit the
  `tools` field from the request).

See `examples/toolCalling.integration.js` for the full test suite.

## Error Handling

All errors are returned in the OpenAI-compatible error envelope:

```json
{
  "error": {
    "message": "No provider supports model \"unknown-model\"",
    "type": "invalid_request_error",
    "param": null,
    "code": "model_not_found",
    "request_id": "71d5b55abf9d3949f54cc8730f9e6dda"
  }
}
```

| `type` | `code` | Trigger |
|---||---|
| `invalid_request_error` | (null) | Validation failure (missing `model` / `messages`) |
| `invalid_request_error` | `embeddings_not_supported` | No candidate provider for the model declares `supportsEmbeddings` |
| `invalid_request_error` | `images_not_supported` | No candidate provider for the model declares `supportsImages` |
| `invalid_request_error` | `audio_not_supported` | No candidate provider for the model declares `supportsAudio` |
| `invalid_request_error` | `tools_not_supported` | Request carries `tools` but no candidate provider declares `supportsTools` |
| `invalid_request_error` | `missing_api_key` | No `Authorization: Bearer` header provided |
| `invalid_request_error` | `invalid_api_key` | API key not found in the store |
| `invalid_request_error` | `disabled_api_key` | API key `status` is `"inactive"` |
| `invalid_request_error` | `expired_api_key` | API key `expiresAt` has passed |
| `invalid_request_error` | `model_forbidden` | API key's `allowedModels` does not include the requested model |
| `invalid_request_error` | `provider_forbidden` | API key's `allowedProviders` does not include any serving provider |
| `rate_limit_exceeded` | `rate_limit_exceeded` | Gateway rate limit, burst, concurrency, or quota exceeded |
| `invalid_request_error` | `model_not_found` | No provider supports the requested model |
| `invalid_request_error` | `no_api_keys` | Provider has no ACTIVE API keys (all disabled/cooled-down) |
| `invalid_request_error` | `invalid_api_key` | Provider returned 401 |
| `rate_limit_exceeded` | `provider_rate_limited` | Provider returned 429 |
| `api_error` | `provider_unavailable` | Provider returned 503 / all providers disabled |
| `timeout` | `provider_timeout` | Provider request timed out |
| `api_error` | `provider_unreachable` | Connection refused / DNS / network error |
| `api_error` | `invalid_provider_response` | Provider returned malformed JSON |

## HTTP Client

`HttpClient` (`src/services/httpClient.js`) is the single reusable communication
layer between the gateway and any AI provider. Every provider reuses the same
client so that timeout handling, header construction, logging, and error
normalization are applied consistently.

### Usage

```js
const { httpClient } = require('./src/services');

const res = await httpClient.sendRequest(provider, '/chat/completions', {
  method: 'POST',
  body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] },
});
// res => { status, headers, data }
```

### Features

- Built on **axios**.
- **Timeout** taken from the provider config (`provider.timeout`); overridable
  per-request via `payload.timeout`.
- **Headers** built automatically:
  - `Content-Type: application/json` and `Accept: application/json`
  - `Authorization: Bearer <key>` from the first available `provider.apiKeys` entry
  - Custom headers from `provider.headers`
  - Per-request extra headers via `payload.headers`
- Supports **POST** and **GET** (`payload.method`).
- Supports **query parameters** (`payload.query`).
- Supports **JSON request body** (`payload.body`).
- **Streaming** is prepared via `streamRequest()` (returns an axios response
  stream) but is NOT implemented yet — intentionally deferred.

### Logging

Each request emits three structured log lines via the shared `logger`:

1. **Request Logger** — `HTTP request` with provider, method, URL, timeout.
2. **Response Logger** — `HTTP response` with status and duration.
3. **Error Logger** — `HTTP request failed` with normalized error code, status,
   duration, and message.

### Error Normalization

All errors — whether from axios, the network, or the provider HTTP response —
are normalized into a consistent internal `AppError`. The original error metadata
is attached to `err.info`:

| `err.info.code` | Trigger | `statusCode` |
|---|---|---|
| `PROVIDER_TIMEOUT` | ETIMEDOUT / ECONNABORTED | 504 |
| `PROVIDER_UNAUTHORIZED` | 401 | 401 |
| `PROVIDER_FORBIDDEN` | 403 | 403 |
| `PROVIDER_NOT_FOUND` | 404 | 404 |
| `PROVIDER_RATE_LIMITED` | 429 | 429 |
| `PROVIDER_SERVER_ERROR` | 500 (and any 5xx not listed) | 5xx |
| `PROVIDER_BAD_GATEWAY` | 502 | 502 |
| `PROVIDER_UNAVAILABLE` | 503 | 503 |
| `PROVIDER_CONNECTION_REFUSED` | ECONNREFUSED | 502 |
| `PROVIDER_DNS_ERROR` | ENOTFOUND / EAI_AGAIN | 502 |
| `PROVIDER_INVALID_JSON` | malformed JSON body | 502 |
| `PROVIDER_NETWORK_ERROR` | request sent, no response | 502 |
| `PROVIDER_UNKNOWN_ERROR` | anything else | 502 |

### Example / Smoke Test

A self-contained example that exercises every feature against a local mock
HTTP server (no real network calls to AI providers):

```bash
node examples/httpClient.example.js
```

## API Key Management

`ApiKeyManager` (`src/services/apiKeyManager.js`) owns the lifecycle of every
API key for every provider. Keys are loaded from `provider.apiKeys` (see
`config/providers/*.json`) and the manager handles rotation, cooldown, and
statistics in-memory.

A single provider can hold multiple keys:

```json
{
  "id": "openrouter",
  "apiKeys": ["or-key-1", "or-key-2", "or-key-3", "or-key-4"],
  ...
}
```

### Key status

| Status | Meaning |
|---|---|
| `ACTIVE` | Eligible for selection |
| `COOLDOWN` | Temporary disabled after a transient failure; auto re-enabled when `cooldownUntil` expires |
| `RATE_LIMITED` | Provider returned 429 (cooled down) |
| `UNAUTHORIZED` | Provider returned 401/403 — permanent until `enableKey()` |
| `QUOTA_EXCEEDED` | Quota exhausted — permanent until `enableKey()` |
| `DISABLED` | Manually disabled via `disableKey()` |

### Service surface

| Method | Description |
|---|---|
| `getNextKey(providerId)` | Round-robin select the next ACTIVE key; auto-clears expired cooldowns; throws 503 when none available |
| `reportSuccess(providerId, key)` | Mark a request as successful; clears transient cooldown |
| `reportFailure(providerId, key, error)` | Categorize the error and cool-down / disable the key accordingly |
| `disableKey(providerId, key)` | Manually disable a key |
| `enableKey(providerId, key)` | Manually re-enable a key |
| `getKeyStatus(providerId)` | Per-key snapshot (masked key, status, stats, cooldownUntil) |
| `getAllStatus()` | Snapshot for every provider |

### Statistics tracked per key

`totalRequests`, `successCount`, `failureCount`, `lastUsed`, `lastError` (message, code, timestamp), `cooldownUntil`.

### Integration with HttpClient

`HttpClient` is constructed with the `apiKeyManager` instance (dependency
injection). On every `sendRequest`:

1. `httpClient._resolveApiKey(provider)` calls `apiKeyManager.getNextKey(provider.id)` (round-robin ACTIVE key)
2. The key is used for `Authorization: Bearer <key>`
3. On success → `reportSuccess`
4. On failure → `reportFailure` with the normalized error (the manager decides cooldown duration / permanent disable)

If no ACTIVE key is available, `getNextKey` throws → the request fails fast with `503 no_api_keys` (no provider call is made).

### Tests

```bash
node examples/apiKeyManager.unit.js         # 34 unit tests
node examples/apiKeyManager.integration.js  # 9 integration tests (rotation + cooldown via mock provider)
```

## Request Executor (Retry + Fallback)

`RequestExecutor` (`src/services/requestExecutor.js`) is the shared resilience
layer between the endpoint services (Chat Completions, Responses) and the
HttpClient. It owns the retry and fallback policy so that every endpoint gets
the same behaviour without duplicating orchestration code.

### Retry policy

A request is retried when the normalized error is "retryable": timeouts, 5xx,
rate-limits, network issues. Auth and validation errors are never retried.
Default: **2 retries per provider** with exponential backoff (200ms, 400ms).

### Fallback policy

When all retries against a provider are exhausted (or when the provider has no
active API keys), the executor falls back to the next candidate provider for
the same model (ordered by priority via `ModelRouter.getCandidateProviders`).
Fallback is triggered for retryable errors and for "no API keys" errors.

### Shared pipeline

Both `ChatCompletionsService` and `ResponsesService` are thin adapters over
the executor. They supply two pure functions:

- `buildPayload(provider, input, ctx)` — translate the endpoint request into a
  Chat Completions provider body
- `normalizeResponse(providerResponse, input, ctx)` — translate the provider
  response back into the endpoint's response shape

The executor handles routing, retry, fallback, latency / retry / fallback
counters, and structured logging — once. Adding a third OpenAI-compatible
endpoint only requires a new adapter + the same two functions.

### Logging

Every attempt logs `requestId`, `providerId`, `model`, `attempt`,
`retryCount`, `fallbackCount`. On completion: `latencyMs`, `retryCount`,
`fallbackCount`, `statusCode`.

## Streaming (Server-Sent Events)

Both `POST /v1/chat/completions` and `POST /v1/responses` support OpenAI-compatible
streaming. When the request body contains `"stream": true`, the gateway pipes
Server-Sent Events from the provider to the client through a shared streaming
pipeline. No new endpoints were added — the existing routes detect `stream:true`
and delegate to the streaming path.

### Pipeline

```
client request (stream:true)
  -> route
  -> service.stream(body, res, ctx)
  -> RequestExecutor.executeStream()
       retry/fallback (pre-stream phase only)
       HttpClient.streamRequest() (axios responseType:"stream")
       provider SSE stream
  -> StreamParser   (raw bytes -> parsed SSE events)
  -> StreamingResponseAdapter (translate provider events -> endpoint events)
  -> SSEWriter  (write SSE events to Express res)
  -> client
```

Three reusable components keep streaming code decoupled from endpoint logic:

- **`StreamParser`** (`src/services/streamParser.js`) — a Node Transform stream
  that buffers raw provider bytes and emits parsed SSE events. Handles partial
  events spanning multiple chunks and both `\n\n` / `\r\n\r\n` separators.
- **`SSEWriter`** (`src/services/sseWriter.js`) — writes SSE wire-format events
  to an Express `res` (headers, `data:`, optional `event:`/`id:`, flushing). Also
  writes the OpenAI `[DONE]` terminator and error events.
- **`StreamingResponseAdapter`** (`src/services/streamingResponseAdapter.js`) —
  translates provider Chat Completions streaming chunks into the endpoint's
  SSE format:
  - Chat Completions: pass-through (chunks forwarded as-is, model normalized)
  - Responses: translates `chat.completion.chunk` events into Responses API
    streaming events (`response.created`, `response.output_text.delta`,
    `response.output_text.done`, `response.completed`)

### Retry / Fallback

Retry and fallback apply only to the **pre-stream phase** (until SSE headers are
sent). Once the first event is flowing to the client, retry is no longer
possible — a mid-stream provider error is surfaced to the client as an SSE
error event followed by `[DONE]` and a closed connection.

### Error handling

| When the error occurs | Response |
|---|---|
| Before stream starts (validation, 401, no provider) | JSON error in the OpenAI envelope (status 4xx/5xx) |
| Mid-stream (provider drops connection, parse error) | `data: {"error":{...}}\n\n` + `data: [DONE]\n\n` then close |

### Logging

Every stream logs: `requestId`, `providerId`, `model`, `stream started`,
`stream ended`, `latencyMs`, `bytesSent`, `retryCount`, `fallbackCount`.

### Example

```bash
curl -N -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [ { "role": "user", "content": "Count from 1 to 5." } ],
    "stream": true
  }'
```

The `-N` (no-buffer) flag ensures curl prints each SSE event as it arrives.
See `examples/streaming.curl.sh` for more examples.

### Tests

```bash
node examples/streaming.integration.js  # 16 integration tests (mock SSE provider)
```

## Configuration Files

- **`.env.example`** – Template for environment variables.
- **`src/config.js`** – Reads and exports configuration from environment variables.
- **`src/config/appConfig.js`** – Static application‑wide configuration (name, version, default model, etc.).

## Project Structure

```
ai-gateway/
├── src/
│   ├── config.js              # Loads settings from environment variables
│   ├── config/
│   │   ├── appConfig.js        # Static application-wide configuration
│   │   ├── index.js            # Config barrel export
│   │   ├── providersConfig.js # Loads provider JSON configs + env expansion
│   │   └── apiKeysConfig.js   # Loads gateway API keys (file + env)
│   │   └── rateLimitConfig.js # Loads rate-limit config (file + env)
│   ├── middleware/
│   │   ├── asyncHandler.js    # Wraps async route handlers
│   │   ├── auth.js            # Bearer API key authentication middleware
│   │   ├── adminAuth.js        # Admin role authorization middleware
│   │   ├── rateLimit.js        # Rate limiting middleware
│   │   ├── errorHandler.js     # Global error handler (OpenAI envelope)
│   │   ├── notFound.js         # 404 handler
│   │   ├── requestId.js        # X-Request-Id middleware
│   │   └── index.js            # Barrel export
│   ├── routes/
│   │   ├── root.js             # GET /
│   │   ├── health.js           # GET /health
│   │   ├── ready.js            # GET /ready (readiness probe, unauthenticated)
│   │   ├── metrics.js          # GET /metrics, /stats, /health/providers
│   │   ├── admin.js            # Admin API routes (/admin/api/*)
│   │   ├── models.js           # GET /v1/models, GET /v1/models/:id
│   │   ├── info.js             # GET /v1/info
│   │   ├── generate.js         # POST /api/v1/generate (legacy)
│   │   ├── chatCompletions.js  # POST /v1/chat/completions
│   │   ├── responses.js        # POST /v1/responses
│   │   ├── embeddings.js       # POST /v1/embeddings
│   │   ├── images.js           # POST /v1/images/{generations,edits,variations}
│   │   ├── audio.js            # POST /v1/audio/{speech,transcriptions,translations}
│   │   └── index.js            # Route aggregator
│   ├── services/
│   │   ├── providerManager.js       # Provider config manager
│   │   ├── modelRouter.js          # Model -> provider routing
│   │   ├── modelRegistry.js        # Aggregated model registry (cache + dedup)
│   │   ├── httpClient.js          # Reusable HTTP client (axios)
│   │   ├── httpClientError.js     # HTTP error normalizer
│   │   ├── apiKeyManager.js        # API key rotation + cooldown + stats
│   │   ├── apiKeyStore.js          # Gateway API key store (auth)
│   │   ├── usageTracker.js         # Per-key usage tracking (requests/tokens)
│   │   ├── metricsCollector.js     # Global + per-provider metrics aggregation
│   │   ├── providerHealthMonitor.js # Per-provider circuit breaker + health
│   │   ├── rateLimiter.js         # Central rate limiter (3 algorithms, 4 scopes)
│   │   ├── providerConfigManager.js # Hot reload watcher + reload cascade
│   │   ├── requestLog.js         # Bounded request log buffer for admin
│   │   ├── requestExecutor.js      # Retry + fallback orchestrator (shared)
│   │   ├── chatCompletionsService.js # Chat completions adapter (+ stream)
│   │   ├── responsesService.js     # Responses API adapter (+ stream)
│   │   ├── embeddingsService.js    # Embeddings API adapter (non-streaming)
│   │   ├── imagesService.js        # Images API adapter (generations/edits/variations)
│   │   ├── audioService.js         # Audio API adapter (speech/transcriptions/translations)
│   │   ├── streamParser.js          # SSE parser (bytes -> events)
│   │   ├── sseWriter.js             # SSE writer (events -> Express res)
│   │   ├── streamingResponseAdapter.js # Translate provider SSE -> endpoint SSE
│   │   ├── aiService.js           # Legacy AI provider integration
│   │   └── index.js               # Service barrel export
│   ├── utils/
│   │   ├── AppError.js         # Custom error class
│   │   └── logger.js           # Logging utility
│   ├── app.js                  # Express application setup
│   └── server.js               # Server entry point
├── config/
│   ├── providers/              # Provider JSON configs
│   │   ├── deepseek.json
│   │   ├── openai.json
│   │   └── anthropic.json
│   └── apiKeys.example.json     # Gateway API key config template
│   └── rateLimit.example.json   # Rate limit config template
├── examples/
│   ├── httpClient.example.js          # HttpClient smoke test (15 cases)
│   ├── chatCompletions.integration.js # Chat completions integration test (13 cases)
│   ├── chatCompletions.curl.sh        # Chat completions curl examples
│   ├── apiKeyManager.unit.js          # ApiKeyManager unit tests (34 cases)
│   ├── apiKeyManager.integration.js   # ApiKeyManager integration tests (9 cases)
│   ├── responses.integration.js        # Responses API integration tests (12 cases)
│   ├── responses.curl.sh              # Responses API curl examples
│   ├── embeddings.integration.js       # Embeddings API integration tests (20 cases)
│   ├── images.integration.js           # Images API integration tests (29 cases)
│   ├── audio.integration.js            # Audio API integration tests (28 cases)
│   ├── toolCalling.integration.js       # Tool calling integration tests (32 cases)
│   ├── models.integration.js           # Models API integration tests (14 cases)
│   ├── auth.integration.js             # Authentication integration tests (16 cases)
│   ├── metrics.integration.js           # Metrics & monitoring integration tests (14 cases)
│   ├── rateLimit.integration.js         # Rate limiting integration tests (12 cases)
│   ├── providerConfig.integration.js    # Provider hot reload integration tests (11 cases)
│   ├── admin.integration.js            # Admin dashboard integration tests (20 cases)
│   ├── streaming.integration.js        # SSE streaming integration tests (16 cases)
│   └── streaming.curl.sh              # SSE streaming curl examples
├── logs/                      # Application logs (placeholder)
├── src/public/                 # Static admin dashboard UI
│   └── admin.html             # Single-page admin dashboard
├── .env.example
├── .gitignore
├── package.json
└── README.md
```
