# Architecture

This document explains how LocalForge is structured and why. It's aimed at
contributors and reviewers who need to understand the design before making
non-trivial changes. For end-user configuration, see
[CONFIGURATION.md](./CONFIGURATION.md).

## High-level shape

```
dsh runtime
└── llm registry
    ├── provider: localforge              # OpenAI-compatible chat completions
    │   └── ChatCompletionsAdapter
    │       ├── ListingCache (TTL)        # /api/v0/models + /v1/models fallback
    │       ├── AutoLoader                # POST /api/v0/models/{id}/load + poll
    │       ├── Tokenizer (gpt-tokenizer) # real token counting
    │       ├── TokenEstimator            # pre-flight OVERFLOW guard
    │       ├── Semaphore (per model)     # concurrency limiter
    │       ├── FallbackChain             # recoverable-error retry
    │       ├── ReasoningBudget           # reasoning_effort or system reminder
    │       ├── SamplingPresets           # code/chat/creative/precise
    │       ├── ChatCompletionsSerializer # harness messages → OpenAI wire
    │       ├── SseStreamer → Translator  # wire → harness StreamChunks
    │       └── Observability (Prometheus, health, log)
    ├── provider: localforge-anthropic    # Anthropic-compatible messages
    │   └── AnthropicMessagesAdapter
    │       ├── ListingCache (TTL)
    │       ├── AutoLoader
    │       ├── Tokenizer (gpt-tokenizer)
    │       ├── TokenEstimator
    │       ├── Semaphore (per model)
    │       ├── FallbackChain
    │       ├── ThinkingBudget            # thinking: { type: 'enabled', budget_tokens }
    │       ├── AnthropicSerializer       # harness messages → Anthropic wire
    │       ├── AnthropicSseStreamer      # event: ... /data: ... framing
    │       ├── AnthropicTranslator       # events → harness StreamChunks
    │       └── Observability
    └── observability
        ├── /metrics (Prometheus)
        ├── HealthCheck
        └── Pino logger (redacted)
```

## The per-request resolver trick

dsh plugins usually capture connection facts at registration: `baseURL`,
`apiKey`, the entire settings section. That means a config change needs
a full unregister + re-register dance, during which the provider is
invisible in the UI.

LocalForge inverts this. The plugin entry point holds a `current`
function that points to the active settings snapshot; every adapter
method reads through that function. The settings section calls
`setSource` to swap the active snapshot, and the next request
immediately uses the new values. No re-registration.

The exception is `retryPolicy`: the harness's llm registry captures the
retry policy at registration, so we re-register the route in place via
`registration.replace([PROVIDER])` whenever the policy changes. Doing
this in a single registry section avoids a window during which the
provider disappears from observers.

A `lastGood` memo survives a transient bad settings snapshot: the user's
typo in the UI doesn't break the live request stream.

## Discovery

`ListingCache` is a TTL-bounded (default 30s) cache wrapping a
dual-endpoint fetcher:

1. **Native probe** — `GET {root}/api/v0/models`. LM Studio's richer
   endpoint, disclosing `state` (loaded/not-loaded),
   `loaded_context_length`, `max_context_length`, and `type` (`vlm` for
   vision-language, `llm` for text-only).
2. **Compat fallback** — `GET {baseURL}/v1/models`. The OpenAI spec
   endpoint; discloses only `id`. Used when the native endpoint is
   unavailable (older LM Studio, custom gateways, alternative servers
   like Ollama that don't implement `/api/v0/models`).

Listing replies are bounded at 4 MB to refuse a runaway server before
parsing. A 4xx or transport failure on the native probe routes to the
compat probe, not to an error — the compat probe's failure is the
reported one because that's the documented address.

The cache invalidates on:
- TTL expiry (default 30s)
- An explicit `cache.invalidate()` call (the auto-load path uses it
  after a successful load)
- A settings-section swap

## Auto-load

If the requested model isn't `state: 'loaded'` in the listing, the
adapter issues `POST {root}/api/v0/models/{id}/load` and polls the
listing every 500ms until the model reports `loaded` or a 30s deadline
expires. Best-effort: failures (old LM Studio that doesn't accept the
POST, server already loaded) are silently swallowed because the chat
endpoint can still serve a model that's loading.

## Token counting (real, not heuristic)

The previous "production" v0.1 used a `chars / 3.5` heuristic because a
portable tokenizer that worked across model families didn't exist. That
shipped in this release via [`gpt-tokenizer`](https://github.com/mishushakov/gpt-tokenizer)
(MIT, pure JS, no native bindings):

- `o200k_base` — GPT-4o, o1, o3, GPT-5
- `cl100k_base` — GPT-4, GPT-3.5, modern open-source (Qwen, Llama-3,
  Mistral, DeepSeek)
- `p50k_base`, `p50k_edit`, `r50k_base` — older models

A static pattern table picks the encoding from the model id; users can
override with `tokenizer.encoding`. The counter is bound once per
request and reused for every text block of the conversation.

Image blocks have a fixed token cost (the OpenAI low-res vision cost
of 765 tokens). Tool definitions are encoded as JSON via the same
counter.

## Token pre-flight

Before issuing a request, the adapter estimates the input token count
with the real tokenizer and rejects with `LlmError` `OVERFLOW` if the
estimate plus the requested `maxTokens` exceeds the model's
`contextWindow` (from override or the listing's `loaded_context_length`
/ `max_context_length`).

The estimate is intentionally accurate now that the tokenizer is real.
A 400 from LM Studio mid-stream is still possible if the estimate is
optimistic, but the gross miscalculations (a 200 KB tool definition
against a 4 KB window) are caught up front.

## Concurrency limiting

LM Studio's backend serializes streams internally; queuing N concurrent
streams on the same model just moves the contention to the backend, and
small quantized models collapse. LocalForge keeps a `Semaphore` per
model id, defaulting to capacity 1. Bump `maxConcurrentPerModel` if you
have a beefy GPU and verified backend behavior.

The semaphore honors `AbortSignal` for cancellation: aborting a request
removes the waiter and rejects with `DOMException('AbortError')`. The
adapter maps that to `LlmError` `ABORTED`.

## Fallback chain

A model's `fallback: [a, b, c]` lists alternative model ids to try if
the primary one returns a recoverable error: `TRANSPORT`, `TIMEOUT`,
`SERVER`, `RATE_LIMIT`. The chain is processed in order, FIFO. Once a
model succeeds, the chain is done.

Non-recoverable errors (`AUTH`, `INVALID_REQUEST`, `UNSUPPORTED_CONTENT`,
`OVERFLOW`) propagate immediately — the user's request is broken,
retrying with another model doesn't help.

## Reasoning budget

Two paths per adapter:

**OpenAI route:**
1. If the model supports `reasoning_effort` (Qwen3, GPT-OSS,
   DeepSeek-R1), map the numeric budget to `low`/`medium`/`high`.
2. Otherwise, append a system reminder that asks the model to stop
   reasoning after the budget.

**Anthropic route:**
1. Set `thinking: { type: 'enabled', budget_tokens: N }` on the
   request body, clamped at Anthropic's 64 000-token cap.
2. The Anthropic API returns `thinking_delta` SSE events that we surface as
   `reasoning-delta` chunks.

The model-id pattern match is a static lookup, no network call.

## Sampling presets

Four built-in presets apply sensible defaults for common task shapes:

| Preset | Temperature | top_p | top_k | Frequency penalty | Presence penalty |
|--------|-------------|-------|-------|-------------------|------------------|
| `code` | 0.2 | 0.95 | 40 | 0 | 0 |
| `chat` | 0.7 | 0.9 | 50 | 0 | 0 |
| `creative` | 1.0 | 0.95 | 80 | 0.1 | 0.1 |
| `precise` | 0.1 | 0.8 | 20 | 0 | 0 |

The preset is applied as a base layer; any field the caller specifies on
the request wins.

## SSE translation

### OpenAI route

`parseSse` wraps `eventsource-parser` for framing and yields `[DONE]`
as the final value. EOF before `[DONE]` raises `LlmError` `STREAM_CLOSED`
— a truncated response cannot be trusted.

`translate` maintains a stateful block per content index, three block
kinds (`text`, `reasoning`, `tool-call`). Reasoning and text deltas
trigger `block-start` lazily on the first non-empty delta, so an empty
initial reasoning chunk from the model doesn't open a phantom block.
`finish` and `usage` are deferred until `[DONE]`, handling both
"usage attached to finish chunk" and "trailing usage-only chunk"
shapes. Chunks with a missing or non-array `choices` field are treated
as provider keepalive pings and skipped silently. A `stop` finish with
zero open blocks is mapped to `EMPTY_RESPONSE`.

### Anthropic route

`parseAnthropicSse` parses the **named** SSE events Anthropic uses:
`message_start`, `content_block_start`, `content_block_delta`,
`content_block_stop`, `message_delta`, `message_stop`, `ping`, `error`.
`error` events are surfaced as `LlmError`; `ping` is dropped; EOF
before `message_stop` raises `STREAM_CLOSED`.

`translateAnthropic` maintains a stateful block per content-block index,
four kinds (`text`, `thinking`, `redacted_thinking`, `tool_use` with
partial-JSON accumulation). `tool_use` input deltas are accumulated
into a partial JSON string that the harness parses on `block-end`.
Finish reason and the latest usage are deferred until `message_stop`.

## Observability

### Metrics

Prometheus, exposed at `/metrics` when the harness mounts the http
service:

- `dsh_localforge_ttft_seconds{model}` — time to first token histogram
- `dsh_localforge_tokens_total{model, kind}` — counter for
  input/output/reasoning
- `dsh_localforge_queue_depth{model}` — gauge of in-flight requests
- `dsh_localforge_errors_total{model, code}` — counter by error code
- `dsh_localforge_listing_cache_total{outcome}` — `hit` / `miss`
  counter
- `dsh_localforge_fallback_total{from, to, reason}` — counter

The metric prefix is configurable (`metrics.prefix`), default
`dsh_localforge`. Cardinality is bounded by `model` (from your config)
and `code` (from the upstream `LlmError` vocabulary), so storage stays
predictable.

### Health check

A `HealthCheck` instance probes `GET {baseURL}/models` every 15s
(default). A successful probe flips an internal `healthy` flag; a
transition fires the `onChange` callback (logged at `info`).

### Logging

Pino with credential redaction. The redact list covers
`req.headers.authorization`, `req.headers['x-api-key']`, `apiKey`,
`apiKeyEnv`. Logs are safe to ship to Loki / ELK / CloudWatch without
scrubbing.

## Testing

Three layers:

- **Unit (Vitest, no network)** — pure-function modules:
  `Semaphore`, `applyPreset`, `applyReasoningBudget`,
  `ListingCache`, `TokenEstimator`, `Tokenizer`,
  `ChatCompletionsAdapter.translate`, `AnthropicSerializer`,
  `AnthropicTranslator`, `FallbackChain`.
- **Integration (Vitest + hand-rolled mock HTTP server)** — end-to-end
  through each adapter against a node `http.createServer` mock that
  implements `/v1/models`, `/api/v0/models`, `/v1/chat/completions`,
  and `/v1/messages` with the right SSE shapes. No real LM Studio
  required.
- **Contract (snapshot tests)** — planned for v0.2 (post-launch). The
  serializer outputs are stable enough today that unit assertions
  suffice.

CI runs unit + integration on every push and PR. Coverage via `v8`.

## File map

```
src/
├── index.ts                       # plugin entry (apply, register)
├── config/
│   ├── schema.ts                  # Schemastery config schema
│   ├── resolve.ts                 # per-request connection resolver
│   └── presets.ts                 # sampling presets
├── discovery/
│   ├── cache.ts                   # TTL-bounded listing cache
│   ├── fetcher.ts                 # dual-endpoint listing probe
│   └── autoload.ts                # POST /load + polling
├── streaming/
│   ├── serialize.ts               # OpenAI request body
│   ├── sse.ts                     # OpenAI SSE framing
│   ├── translate.ts               # OpenAI SSE → StreamChunks
│   ├── anthropic-serialize.ts     # Anthropic request body
│   ├── anthropic-sse.ts           # Anthropic SSE framing
│   └── anthropic-translate.ts     # Anthropic events → StreamChunks
├── adapter/
│   ├── chat-completions.ts        # main OpenAI adapter
│   └── anthropic-messages.ts      # main Anthropic adapter
├── lifecycle/
│   ├── semaphore.ts               # counting semaphore
│   ├── fallback.ts                # model fallback chain
│   ├── reasoning.ts               # reasoning budget (OpenAI route)
│   ├── token-estimator.ts         # pre-flight token estimate
│   └── tokenizer.ts               # gpt-tokenizer binding
├── observability/
│   ├── metrics.ts                 # Prometheus
│   ├── health.ts                  # periodic health probe
│   └── log.ts                     # Pino with redaction
└── types/
    └── wire.ts                    # OpenAI + Anthropic wire types
```

## Design decisions on record

- **Native probe first, then compat.** Native discloses load state and
  context sizes the rest of the plugin needs. The compat fallback is the
  documented address; its failure is the reported one.
- **One listing cache per baseURL, not per provider route.** Today the
  OpenAI and Anthropic routes have separate caches (one for each
  baseURL). When they point at the same server, this is wasteful; v0.2
  can deduplicate by baseURL.
- **Anthropic `thinking` clamp at 64 000.** The Anthropic API rejects
  larger budgets; we clamp rather than fail so a user-set value of e.g.
  100 000 still works.
- **Tokenizer is real, not heuristic.** Production accuracy on token
  counts is more valuable than saving 50 KB of bundle size.
- **`gpt-tokenizer` over `tiktoken-node` and `js-tiktoken`.** Pure JS,
  no native bindings, no WASM init. ~10× faster than the others.
  MIT-licensed. Compiled BPE tables in the bundle.
- **`eventsource-parser` for both routes.** The OpenAI route uses the
  stream wrapper (drops event names); the Anthropic route uses the
  lower-level parser to keep event names. Both are MIT.