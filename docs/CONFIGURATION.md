# Configuration reference

The full reference for the `llm-localforge` settings section. Every
field is optional; defaults are shown. Place this section in
`~/.dsh/settings.yaml` or write it through the **Settings → Models**
page in the web UI.

## Minimal example

```yaml
llm-localforge:
  defaultConnection:
    baseURL: http://localhost:1234/v1
```

That's enough to talk to LM Studio's default OpenAI-compatible endpoint
with no auth, no model overrides, default timeouts.

## Full example

```yaml
llm-localforge:
  defaultConnection:
    baseURL: http://localhost:1234/v1
    apiKeyEnv: LMSTUDIO_API_KEY
    requestTimeoutMs: 120000
    streamIdleTimeoutMs: 300000
    discoveryTimeoutMs: 10000
    listingCacheMs: 30000
    maxConcurrentPerModel: 1
    retryPolicy:
      maxAttempts: 3
      initialDelayMs: 500
      backoffMultiplier: 2
      maxDelayMs: 5000
      jitterMs: 200
  anthropicConnection:
    baseURL: http://localhost:1234
  tokenizer:
    encoding: cl100k_base
  defaultContextWindow: 32768
  defaultMaxTokens: 4096
  models:
    - id: qwen/qwen3-8b
      name: Qwen3 8B
      contextWindow: 32768
      maxTokens: 8192
      vision: false
      preset: code
      reasoningBudget: 4096
      fallback:
        - qwen/qwen3-4b
        - llama-3.1-8b
    - id: qwen/qwen3-vl-4b
      name: Qwen3 VL 4B
      contextWindow: 16384
      maxTokens: 4096
      vision: true
      preset: chat
  metrics:
    enabled: true
    prefix: dsh_localforge
  healthCheck:
    enabled: false
    intervalMs: 15000
```

## Field reference

### `defaultConnection` and `anthropicConnection`

Both objects share the same shape. The OpenAI route uses
`defaultConnection`; the Anthropic route uses `anthropicConnection`.

| Field | Type | Default (OpenAI) | Default (Anthropic) | Notes |
|-------|------|------------------|---------------------|-------|
| `baseURL` | string | `http://localhost:1234/v1` | `http://localhost:1234` | OpenAI appends `/chat/completions` and `/models`; Anthropic appends `/v1/messages`. |
| `apiKeyEnv` | string | (none) | (none) | Name of an env var that holds the API key. Omit for a keyless local server. |
| `requestTimeoutMs` | int | 120000 | 120000 | Maximum time for one request (autoload + chat). |
| `streamIdleTimeoutMs` | int | 300000 | 300000 | Maximum time between stream chunks before `TIMEOUT`. |
| `discoveryTimeoutMs` | int | 10000 | 10000 | Maximum time for one `GET /v1/models` (or native) probe. |
| `listingCacheMs` | int | 30000 | 30000 | TTL for the listing cache. `0` disables caching. |
| `maxConcurrentPerModel` | int | 1 | 1 | Per-model concurrency. Bump only after observing. |
| `retryPolicy` | object | (upstream defaults) | (upstream defaults) | Standard `dsh` retry policy. |

### `tokenizer`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `encoding` | enum | (heuristic) | One of `o200k_base`, `cl100k_base`, `p50k_base`, `p50k_edit`, `r50k_base`. The default is picked from the model id: GPT-4o / o-series → `o200k_base`; everything else → `cl100k_base`. |

The encoding is bound once per adapter instance via
[`gpt-tokenizer`](https://github.com/mishushakov/gpt-tokenizer) (MIT,
pure JS, no native bindings). It powers the pre-flight context-overflow
guard and the Prometheus token counter.

### `defaultContextWindow`

Default context capacity used when no per-model override states one and
the listing doesn't disclose one. Default `32768`.

### `defaultMaxTokens`

Default per-request output cap when the per-model override doesn't set
one and the request doesn't override it. Default `4096`.

### `models[]`

Optional list of model-specific overrides. The `id` field must match
exactly what LM Studio reports (typically `owner/name`, e.g.
`qwen/qwen3-8b`).

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | **Required.** The wire model id. |
| `name` | string | Display name in the model picker. |
| `description` | string | Optional sub-label. |
| `contextWindow` | int | Override the server-disclosed context. |
| `maxTokens` | int | Default output cap for this model. |
| `vision` | bool | Override the server's vision capability hint. |
| `preset` | enum | `code`, `chat`, `creative`, `precise`. |
| `reasoningBudget` | int | Max reasoning tokens before the final answer. OpenAI route: budget to `reasoning_effort` (Qwen3/GPT-OSS/DeepSeek-R1) or system reminder. Anthropic route: `thinking.budget_tokens`, clamped at 64 000. |
| `fallback` | string[] | Alternative model ids to try on recoverable errors. |

### `metrics`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `enabled` | bool | `true` | Expose `/metrics` on the harness HTTP server. |
| `prefix` | string | `dsh_localforge` | Metric name prefix. Sanitized to `[a-zA-Z0-9_]`. |

### `healthCheck`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `enabled` | bool | `false` | Run the periodic health probe. Enable it when availability monitoring is useful. |
| `intervalMs` | int | 15000 | Probe interval. Min 1000. |

## Provider routes

LocalForge registers two provider routes. Both are visible in the model
picker once the plugin is enabled.

- **`localforge`** — OpenAI-compatible chat completions. Activates as
  soon as the settings section exists.
- **`localforge-anthropic`** — Anthropic-compatible messages.
  Activates when `anthropicConnection` has a base URL.

To use a specific model as the default for new sessions, set
`agent-default-model` in `settings.yaml`:

```yaml
agent-default-model:
  provider: localforge
  model: qwen/qwen3-8b
```

## Per-request overrides

The harness passes `options.temperature`, `options.top_p`,
`options.maxTokens`, `options.stop`, and `options.tools` through to the
adapter. The adapter:

1. Estimates input tokens via the real `gpt-tokenizer` counter.
2. Runs pre-flight; rejects with `OVERFLOW` if input + max_tokens
   exceeds the context window.
3. Tries the auto-load if the model isn't `state: 'loaded'`.
4. Acquires the per-model semaphore (concurrency limit).
5. Applies the model's sampling preset (if any) and the reasoning
   budget (OpenAI: `reasoning_effort` or system reminder; Anthropic:
   `thinking.budget_tokens`).
6. Streams the response.

### OpenAI wire body

```json
{
  "model": "qwen/qwen3-8b",
  "messages": [...],
  "stream": true,
  "stream_options": { "include_usage": true },
  "tools": [...],
  "temperature": 0.2,
  "max_tokens": 8192,
  "reasoning_effort": "medium"
}
```

### Anthropic wire body

```json
{
  "model": "qwen/qwen3-8b",
  "system": "You are helpful.",
  "messages": [...],
  "max_tokens": 8192,
  "stream": true,
  "tools": [...],
  "thinking": { "type": "enabled", "budget_tokens": 4096 }
}
```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `DSH_LOCALFORGE_LOG_LEVEL` | Pino log level. Default `info`. |
| `<apiKeyEnv>` (e.g. `LMSTUDIO_API_KEY`) | API key resolved when `apiKeyEnv: LMSTUDIO_API_KEY` (or any other name you set). |
