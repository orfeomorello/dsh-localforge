# Changelog

All notable changes to LocalForge are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-XX-XX

### Added
- **OpenAI-compatible chat completions adapter** (`localforge` provider route)
  with full SSE streaming, tool calling, vision, and reasoning content
- **Anthropic-compatible messages adapter** (`localforge-anthropic`
  provider route) with full event-based SSE translation (text, thinking,
  tool_use, redacted_thinking), tool calling, vision, and extended
  thinking
- **Live model discovery** with TTL cache and `/api/v0/models` ↔
  `/v1/models` fallback, bounded 4 MB read, 4xx-routes-to-fallback
- **Auto-load** of the requested model via LM Studio's native REST API
  (`POST /api/v0/models/{id}/load`) with polling
- **Real token counting** via `gpt-tokenizer` (MIT, pure JS, no native
  bindings): `o200k_base`, `cl100k_base`, `p50k_base`, `p50k_edit`,
  `r50k_base`. Model-id heuristic picks the encoding by default; the
  user can override with `tokenizer.encoding`
- **Real token pre-flight** that rejects with `OVERFLOW` before the
  network call when input + max_tokens exceeds the context window
- **Per-model concurrency limiter** (semaphore) to prevent backend
  saturation on small quantized models
- **Model fallback chain** (`fallback: [...]`) for `TRANSPORT`,
  `TIMEOUT`, `SERVER`, `RATE_LIMIT` errors
- **Reasoning budget** control:
  - OpenAI route: `reasoning_effort` for Qwen3 / GPT-OSS / DeepSeek-R1;
    system-reminder fallback otherwise
  - Anthropic route: `thinking: { type: 'enabled', budget_tokens }`
- **Sampling presets**: `code`, `chat`, `creative`, `precise`
- **Prometheus metrics** at `/metrics` (when `ctx.http` is mounted):
  TTFT, tokens (input/output/reasoning), queue depth, errors by code,
  listing cache hits/misses, fallback activations
- **Structured logging** via `pino` with credential redaction
  (authorization, x-api-key, apiKey, apiKeyEnv paths)
- **Periodic health check** with auto-reconnect, structured-log
  transitions
- **Per-model overrides**: `name`, `description`, `contextWindow`,
  `maxTokens`, `vision`, `preset`, `reasoningBudget`, `fallback`
- **Strict TypeScript**: `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes`
- **Full test coverage**:
  - unit tests for every module (semaphore, presets, token-estimator,
    tokenizer, translate, anthropic-serialize, anthropic-translate,
    fallback, reasoning)
  - integration tests against a hand-rolled mock LM Studio / Anthropic
    server (no real LM Studio required)
- **GitHub Actions CI**: typecheck, lint, test on every push and PR

### Defaults
- `defaultContextWindow`: 32768
- `defaultMaxTokens`: 4096
- `streamIdleTimeoutMs`: 300000 (5 min)
- `discoveryTimeoutMs`: 10000 (10 s)
- `listingCacheMs`: 30000 (30 s)
- `maxConcurrentPerModel`: 1
- `anthropicConnection.baseURL`: `http://localhost:1234` (no `/v1`)
- `anthropic-version`: `2023-06-01`
- `MAX_THINKING_BUDGET`: 64000 (Anthropic's hard cap)

[Unreleased]: https://github.com/orfeomorello/dsh-localforge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/orfeomorello/dsh-localforge/releases/tag/v0.1.0