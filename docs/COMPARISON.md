# Comparison with other LM Studio plugins for `dsh`

We read the three other LM Studio plugins for DeepSeek Harness before
writing LocalForge. We learned from them; we did not fork or copy any
code. This table is the honest feature-by-feature comparison.

| Feature | [Viktirr/dsh-llm-lmstudio](https://github.com/Viktirr/dsh-llm-lmstudio) | [jtc268/deepseek-harness-lmstudio](https://github.com/jtc268/deepseek-harness-lmstudio) | [starlightzfy/dsh-plugin-lmstudio](https://github.com/starlightzfy/dsh-plugin-lmstudio) | **LocalForge** |
|---|---|---|---|---|
| License | (none) | MIT | (none) | **MIT** |
| Live discovery `/v1/models` | ✅ | ✅ | ✅ | ✅ |
| Native `/api/v0/models` | ✅ fallback | ✅ enriches | ❌ | ✅ prefer + cache |
| Tool calling | ✅ | ✅ | ✅ | ✅ + schema pre-validation |
| Reasoning passback | ✅ | ✅ | ❌ | ✅ + budget |
| Vision (`image_url`) | ✅ | ✅ | ❌ | ✅ |
| Streaming SSE | ✅ | ✅ | ✅ | ✅ + metrics |
| Per-request hot-reload | ✅ | ❌ | ❌ | ✅ |
| Retry policy pluggable | ✅ | ❌ | ❌ | ✅ + exponential jitter |
| Listing cache (TTL) | ❌ | ❌ | ❌ | ✅ |
| Auto-load via REST | ❌ | ❌ | ❌ | ✅ |
| Concurrency limiter | ❌ | ❌ | ❌ | ✅ |
| Model fallback chain | ❌ | ❌ | ❌ | ✅ |
| Sampling presets | ❌ | ❌ | ❌ | ✅ |
| Reasoning budget | ❌ | ❌ | ❌ | ✅ |
| Token pre-flight | ❌ | ❌ | ❌ | ✅ |
| Prometheus metrics | ❌ | ❌ | ❌ | ✅ |
| Structured logging | ❌ | ❌ | ❌ | ✅ Pino, redacted |
| Health check + auto-reconnect | ❌ | ❌ | ❌ | ✅ |
| Anthropic-compatible adapter | ❌ | ❌ | ❌ | ✅ |
| Strict typecheck | ✅ | partial | ✅ | ✅ `noUncheckedIndexedAccess` |
| Test coverage | partial | ❌ | ❌ | ✅ unit + integration |
| CI | ❌ | ❌ | ❌ | ✅ GitHub Actions |
| Bounded listing read | ✅ 4 MB | ❌ | ❌ | ✅ 4 MB + 4xx fallback |

## How we read the field

For each cell:

- **✅** — feature present and correct.
- **partial** — feature present but with known gaps (e.g. typecheck
  errors under `strict`).
- **❌** — feature not present.

A blank means the same as ❌.

## What LocalForge actually adds

Eight things that none of the three existing plugins do:

1. **Listing cache with explicit invalidation.** A 30s TTL by default.
   Bypass with `listingCacheMs: 0`. The auto-load path invalidates the
   cache after a successful load.
2. **Auto-load.** A model that's `not-loaded` on LM Studio gets a
   `POST /api/v0/models/{id}/load` and is polled until ready, up to a
   30s deadline. Best-effort.
3. **Concurrency limiter.** One semaphore per model id, default capacity
   1. LM Studio collapses under parallel streams on small quantized
   models; serializing keeps it alive.
4. **Model fallback chain.** `fallback: [secondary, tertiary]` is
   processed in order on `TRANSPORT`, `TIMEOUT`, `SERVER`,
   `RATE_LIMIT`. Other errors propagate immediately.
5. **Reasoning budget.** Either as `reasoning_effort` (Qwen3, GPT-OSS)
   or as a system reminder that asks the model to stop thinking.
6. **Sampling presets.** `code`, `chat`, `creative`, `precise`. Per-model
   override; per-request override wins per field.
7. **Token pre-flight.** Rough estimate, rejects with `OVERFLOW` before
   the network call.
8. **Prometheus metrics + health check.** TTFT, TPS, queue depth, errors,
   cache hits, fallback activations. `/metrics` route when the harness
   mounts the http service.

And one bonus:

9. **Anthropic-compatible adapter.** A second provider route that talks
   to LM Studio's `/v1/messages` endpoint with `x-api-key`. Useful for
   models fine-tuned on Claude-style data.

## Why this is not a fork

We did not copy any code. The architecture is structurally similar to
Viktirr's because the underlying `dsh` plugin contract dictates the
shape (`apply(ctx, config)`, `ctx.llm.registerAdapter`, `ctx.llm
.registerModelDiscovery`, `ctx.settings.installSection`); any plugin in
this family will look similar at the registration boundary. The
internal modules (semaphore, listing cache, token estimator, fallback
chain, metrics, health check, sampling presets, reasoning budget) are
all our own implementation.

The inspirations are documented in
[INSPIRATIONS.md](./INSPIRATIONS.md).