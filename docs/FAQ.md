# FAQ

## General

### Why a new plugin when three exist already?

Because the three existing plugins miss features that an experienced
dsh user needs on a daily basis: listing cache, auto-load, concurrency
limiter, model fallback, sampling presets, reasoning budget, token
pre-flight, Prometheus metrics, health check, and Anthropic-compat. See
[COMPARISON.md](./COMPARISON.md) for the full matrix.

### Why "LocalForge"?

It captures the dual nature of the plugin: *local* (privacy, no cloud
quota, your GPU) and *forge* (the plugin forges the connection between
dsh and your local LLM server). It's also short and brandable.

### Is it really MIT-licensed?

Yes. See [LICENSE](../LICENSE). The full MIT text is there.

### Does it work with Ollama / vLLM / llama.cpp / etc.?

The OpenAI-compatible provider route works with any server that
implements `POST /v1/chat/completions` and `GET /v1/models`. That
includes Ollama, vLLM, llama.cpp's HTTP server, and TGI. Set the
server's OpenAI-compatible base URL in `defaultConnection.baseURL` and
go. The native `/api/v0/models` probe is best-effort; the
OpenAI-compat fallback covers the rest.

The Anthropic-compatible provider route needs the server to implement
`POST /v1/messages` with `x-api-key`. LM Studio 0.4+ does. We are
unaware of any other local server that does at the time of writing.

## Configuration

### Where do I put the settings?

Either:
- `~/.dsh/settings.yaml`, under the `llm-localforge:` key
- The web UI's **Settings → Models** page, in the LocalForge section

The two are equivalent; the web UI writes the YAML.

### My LM Studio has a different port. How do I change it?

```yaml
llm-localforge:
  defaultConnection:
    baseURL: http://localhost:YOUR_PORT/v1
```

Or, for the Anthropic-compatible adapter:
```yaml
llm-localforge:
  anthropicConnection:
    baseURL: http://localhost:YOUR_PORT
```

### Do I need to set an API key?

No. LM Studio's local server accepts any non-empty bearer token. If
you've enabled API key authentication in LM Studio, set `apiKeyEnv` to
the name of an environment variable that holds the key:

```yaml
llm-localforge:
  defaultConnection:
    apiKeyEnv: LMSTUDIO_API_KEY
```

```sh
export LMSTUDIO_API_KEY=sk-...
```

The plugin will resolve the key on every request through the dsh
credentials service, falling back to the ambient environment if the
service is not mounted.

### How do I set a default model for new sessions?

```yaml
agent-default-model:
  provider: localforge
  model: qwen/qwen3-8b
```

This applies to new sessions only; existing sessions keep the model
they started with.

## Features

### How does the listing cache work?

A TTL of 30s by default. The cache is invalidated whenever a model is
loaded via the auto-load path. To disable caching, set
`listingCacheMs: 0`. To force a refresh, restart the dsh process.

### How do I make my model auto-load on first use?

Nothing to configure; the auto-load path is on by default. The adapter
issues `POST /api/v0/models/{id}/load` if the requested model isn't
`state: 'loaded'`. If your LM Studio build doesn't accept the POST
(older versions), the chat request still goes through; LM Studio
auto-loads on first chat if needed.

### Why is the default `maxConcurrentPerModel: 1`?

LM Studio's backend serializes streams internally under heavy load.
Queuing N concurrent streams at the dsh layer just moves the
contention to the backend, where small quantized models can collapse.
If you have a beefy GPU and have observed that 2-3 concurrent streams
work, bump the value. Don't bump it blindly.

### What's a "reasoning budget"?

Thinking-capable models (Qwen3, DeepSeek-R1, GPT-OSS) burn tokens on
internal reasoning before producing the final answer. A reasoning
budget of 4096 means the model is asked to use at most 4096 tokens on
thinking. Models that support `reasoning_effort` (Qwen3, GPT-OSS) get
the parameter directly; other models get a system reminder that asks
them to stop reasoning after the budget.

### What are the sampling presets?

Four named bundles of temperature / top_p / top_k / penalties tuned
for common task shapes: `code`, `chat`, `creative`, `precise`. The
preset is applied as a base layer; any field the caller specifies per
request wins. See [CONFIGURATION.md](./CONFIGURATION.md#sampling-presets).

### How do I expose Prometheus metrics?

The harness mounts an HTTP server when the `http` service is present.
LocalForge's `/metrics` route is added when `metrics.enabled: true`
(the default). Point Prometheus at
`http://localhost:3080/metrics` (the harness's default port; check
your profile's `--port`).

## Troubleshooting

### The Plugins page reports `failed to import` when enabling LocalForge

The repository plugin manager imports the package entrypoint directly and
does not build TypeScript source. The repository therefore needs to include
its compiled `lib/` runtime; it now does. The bundle path additionally runs a
build during installation, and its package archive includes `lib/`.

For a bundle install, run `dsh plugin --profile web add
github:orfeomorello/dsh-localforge#main`, then check the exact loader error
with `dsh web --dump-config` and a restart. If the repository plugin panel
still fails, copy the full error from the browser developer console (F12 →
Console); `failed to import` alone does not distinguish a missing entrypoint
from a missing dependency or an incompatible DSH version.

### My model shows up in the picker but the chat fails with 404

The model id in your settings doesn't match what LM Studio reports.
Run:
```sh
curl http://localhost:1234/v1/models
```
and copy the exact `id` value into your config.

### The /metrics route returns 404

The dsh profile doesn't have the `http` service mounted. Either:
- Use a profile that has it (the `web` profile does)
- Disable metrics: `metrics.enabled: false`

### My fallback chain isn't firing

The chain only fires on recoverable errors: `TRANSPORT`, `TIMEOUT`,
`SERVER`, `RATE_LIMIT`. Other errors (like `AUTH` or
`INVALID_REQUEST`) propagate immediately. Check the dsh logs for the
error code.

### How do I run the tests?

```sh
pnpm install --ignore-workspace
npm run test
```

The unit tests run with no network. The integration tests use a mock
LM Studio server (hand-rolled in `test/integration/mock-lmstudio.ts`);
no real LM Studio is required.