# LocalForge for DeepSeek Harness

> A high-performance, MIT-licensed adapter that connects DeepSeek Harness
> (`dsh`) to local LLM servers — primarily LM Studio, but also any other
> OpenAI-compatible or Anthropic-compatible endpoint (Ollama, vLLM,
> llama.cpp's HTTP server, text-generation-inference, etc.).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node ≥ 22.19](https://img.shields.io/badge/node-%E2%89%A522.19-blue)](https://nodejs.org)
[![Topic: dsh-plugin](https://img.shields.io/github/topics/dsh-plugin)](https://github.com/topics/dsh-plugin)
[![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088ff)](./.github/workflows/ci.yml)

---

## Why LocalForge?

Three other LM Studio plugins for `dsh` exist (and we read all of them
carefully — see [Inspirations](./docs/INSPIRATIONS.md) and the
[Comparison](./docs/COMPARISON.md)). LocalForge is the one that adds the
things missing from every other adapter:

- **Live discovery cache** — `/v1/models` + native `/api/v0/models` fallback,
  with TTL and explicit invalidation. The other plugins re-probe the server
  on every `resolveModel`.
- **Auto-load** — if the requested model isn't resident on LM Studio, ask
  the server to load it (`POST /api/v0/models/{id}/load`) and poll until
  ready.
- **Per-model concurrency limiter** — LM Studio saturates under parallel
  streams on quantized models; LocalForge serializes them per model id.
- **Model fallback chain** — `fallback: [primary, secondary]`. If the primary
  model returns a recoverable error, the next one is tried automatically.
- **Reasoning budget** — caps how much internal "thinking" the model is
  allowed to do before producing the final answer.
- **Sampling presets** — `code`, `chat`, `creative`, `precise` for sane
  defaults that you can override per request.
- **Token pre-flight** — reject requests that would overflow the context
  window before paying for a round-trip.
- **Prometheus metrics** — `/metrics` with TTFT, TPS, queue depth, error
  rates, and cache hits.
- **Optional health check** — periodic probe with auto-reconnect when enabled;
  the `/metrics` `up` gauge surfaces the state.
- **Anthropic-compatible adapter** — second provider route using
  `/v1/messages`, useful for Claude-style system prompts and tool calls.
- **Structured logging with credential redaction** — every log line is
  safe to ship to Loki / ELK without scrubbing.
- **Strict TypeScript** — `strict` + `noUncheckedIndexedAccess`, full
  test coverage, GitHub Actions CI.

## Install

### Prerequisites

- DeepSeek Harness (`dsh`) with the **web** profile enabled.
- A local LLM server. LM Studio 0.4.8+ with **Developer → Start Server**
  on (default port `1234`) is the most-tested target; any OpenAI- or
  Anthropic-compatible server works.
- Node.js ≥ 22.19 and pnpm ≥ 9.

### From the DSH Plugins page

1. Open **Settings → Plugins → Repository source → Add**.
2. Enter `github:orfeomorello/dsh-localforge#main` and install it.
3. Enable **LocalForge** in the plugin list; if prompted, restart `dsh web`.

The repository installer mounts community plugins immediately. This
repository also includes the compiled `lib/` runtime because the repository
plugin manager imports that entrypoint directly; GitHub's installer does not
build TypeScript source for it. For a bundle-style installation from a
terminal instead, use:

```sh
dsh plugin --profile web add github:orfeomorello/dsh-localforge#main
dsh web --dump-config # verify the dsh-localforge bundle layer
# Restart dsh web after installing the bundle
```

In the model picker at the top of the page you'll now see
**LocalForge** as a provider; pick any model LM Studio has loaded. If the
UI still reports `failed to import`, capture the complete browser console
error or the `dsh web` terminal diagnostic: the short UI message does not
expose the underlying module-resolution error.

## Quick start

Minimal `~/.dsh/settings.yaml` section:

```yaml
llm-localforge:
  defaultConnection:
    baseURL: http://localhost:1234/v1
  models:
    - id: qwen/qwen3-8b
      preset: code
      fallback:
        - qwen/qwen3-4b
        - llama-3.1-8b
```

That's it. Point dsh at any conversation, select "LocalForge" as the
provider, and traffic flows to LM Studio. Your DeepSeek API balance is
untouched.

## Configuration

See [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) for the full reference
(every section, every field, every default).

## Architecture

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the design notes —
the per-request resolver trick, the dual-endpoint discovery, the SSE
parsing, the Prometheus metric set, and the testing strategy.

## Inspirations

LocalForge is a clean-room reimplementation. We read three existing plugins
to learn the patterns, then wrote everything from scratch with our own
license. The inspirations are:

- [Viktirr/dsh-llm-lmstudio](https://github.com/Viktirr/dsh-llm-lmstudio) —
  the cleanest TypeScript in-tree adapter, the source of the per-request
  resolver pattern.
- [jtc268/deepseek-harness-lmstudio](https://github.com/jtc268/deepseek-harness-lmstudio) —
  the inspiration for Qwen-specific tool-calling robustness.
- [starlightzfy/dsh-plugin-lmstudio](https://github.com/starlightzfy/dsh-plugin-lmstudio) —
  the inspiration for the plugin-bundle discovery UX.

No code was copied. See [docs/COMPARISON.md](./docs/COMPARISON.md) for the
full feature-by-feature matrix.

## License

[MIT](./LICENSE) © 2026 The LocalForge authors.
