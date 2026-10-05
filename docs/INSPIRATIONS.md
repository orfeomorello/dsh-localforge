# Inspirations

LocalForge is a clean-room reimplementation. We read three existing LM
Studio plugins for DeepSeek Harness to learn the patterns, then wrote
everything from scratch. This page documents what we learned from each
and where our implementation diverges.

## Viktirr/dsh-llm-lmstudio

> [github.com/Viktirr/dsh-llm-lmstudio](https://github.com/Viktirr/dsh-llm-lmstudio)

The cleanest TypeScript in-tree adapter. Its `index.ts` introduces the
**per-request resolver** pattern that we adopted: instead of capturing
the connection facts at registration, hold a thunk that re-reads them on
every operation. The settings section calls `setSource` to swap the
active snapshot, and the next request uses the new values without a
re-register dance.

**Where we adopted the pattern.** The `resolveConn` and `resolveApiKey`
thunks in `src/index.ts` are structurally similar to Viktirr's. The
mechanism (per-request read, `lastGood` memo) is the same.

**Where we diverged.**

- Viktirr captures the `retryPolicy` at registration and uses
  `replace([PROVIDER])` to re-register when it changes; we do the same.
  Viktirr keeps the *rest* of the config fully hot-reloadable; we
  decided to also expose hot-reload for the `models[]` overrides and
  the cache TTL via the same mechanism.
- Viktirr registers exactly one provider route. We register two
  (`localforge` and `localforge-anthropic`).
- Viktirr's `apply()` is a single ~300-line file. We split into
  `config/`, `discovery/`, `adapter/`, `streaming/`, `lifecycle/`,
  `observability/`.

**What we did not take.** Viktirr's `apply` is a single file because the
adapter itself is small. As we added features (concurrency, fallback,
metrics, health, auto-load, reasoning budget, token pre-flight), the
file would have grown past 1000 lines. We split it.

## jtc268/deepseek-harness-lmstudio

> [github.com/jtc268/deepseek-harness-lmstudio](https://github.com/jtc268/deepseek-harness-lmstudio)

A bridge script for running DeepSeek Harness against local Qwen models
on LM Studio with correct tool calling, reasoning fields, and context
limits. It introduced several Qwen-specific tricks we considered.

**What we learned.** The Qwen3 tool-call template needs careful
matching of `tool_calls` from the wire; jtc268's bridge has heuristics
for partial JSON in streamed arguments. We did not need those
heuristics in our adapter because LM Studio's chat template handles the
parsing server-side; the wire protocol is standard OpenAI. We do,
however, follow jtc268's lead in treating `reasoning_content` as a
first-class output (we emit it as a `reasoning` block, not as a
truncated `text` block).

**Where we diverged.** jtc268 is a Node.js bridge script (you run it
and it talks to LM Studio directly). We chose to write a `dsh` plugin
so the experience integrates with the existing model picker, settings
page, retry policy, and tool-call layer.

## starlightzfy/dsh-plugin-lmstudio

> [github.com/starlightzfy/dsh-plugin-lmstudio](https://github.com/starlightzfy/dsh-plugin-lmstudio)

A `dsh` plugin published to the dsh plugin store. It registers the
`lm-studio` provider route against LM Studio's OpenAI-compatible
endpoint.

**What we learned.** The plugin's `cordis.patch.yml` and the
`dsh.bundle.patch` declaration in `package.json` are the right
mechanism for adding a dormant row that activates when a settings
section exists. We use the same mechanism; the row id is
`llm-localforge` and the name is `dsh-localforge`.

**Where we diverged.** starlightzfy's plugin ships the provider route
in a single `llm-pi-ai` block, with the model picker keys hard-coded
to known LM Studio model ids. We chose to fetch the listing live
because the model catalog on LM Studio changes more often than a
plugin release cycle. We also added vision capability detection from
the native `/api/v0/models` `type` field; the upstream adapter only
falls back to the compat endpoint.

## What we did not see, and built anyway

- **Listing cache.** None of the three plugins cache; they re-probe on
  every `resolveModel`. We added a TTL cache (default 30s) with explicit
  invalidation from the auto-load path.
- **Concurrency limiter.** None of the three plugins serialize per
  model. LM Studio's backend collapses under parallel streams on small
  quantized models. We added a per-model semaphore, default capacity 1.
- **Model fallback chain.** None of the three plugins support it. We
  added per-model `fallback: [...]` that retries on `TRANSPORT`,
  `TIMEOUT`, `SERVER`, `RATE_LIMIT`.
- **Sampling presets.** None of the three plugins ship with sane
  defaults for common tasks. We added `code`, `chat`, `creative`,
  `precise`.
- **Token pre-flight.** None of the three plugins estimate input
  tokens before the request. We added a rough `chars/3.5` heuristic
  that rejects with `OVERFLOW` before the network call.
- **Prometheus metrics.** None of the three plugins export metrics.
- **Health check.** None of the three plugins probe the server
  periodically.
- **Anthropic-compatible adapter.** None of the three plugins support
  the `/v1/messages` endpoint.

## What we will not copy

- **AI-generated code without review.** The first iteration of
  Viktirr's plugin is AI-generated; the maintainer has been reviewing
  and improving it since. We wrote LocalForge by hand, with every
  line reviewed before commit. The CI linter enforces type safety.
- **License ambiguity.** Viktirr and starlightzfy ship without a
  LICENSE file. LocalForge ships with MIT from day one.
- **Hidden behavior.** Every non-obvious default is documented in
  [CONFIGURATION.md](./CONFIGURATION.md).