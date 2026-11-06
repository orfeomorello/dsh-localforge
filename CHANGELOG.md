# Changelog

All notable changes to LocalForge are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-11-06

### Fixed
- **Vision gating now follows the model's real capabilities** (`src/config/model-capabilities.ts`): images are only attached when the model actually accepts them. The precedence is per-model `vision` override → discovered capability → permissive default, applied identically in `listModels()`, `resolveModel()` and `stream()` of both `ChatCompletionsAdapter` and `AnthropicMessagesAdapter`, so a text-only model is no longer advertised as `inputModalities: ['text']` while its requests still carried `image_url` / `image` blocks

## [0.1.3] - 2026-11-06

### Added
- **`localforge_read_document` tool** (`src/document/tool.ts`): registered on `ctx.tools` when the tools service is mounted (raw JSON Schema, no extra dependency). The model can pass a PDF/image path or a folder (up to 20 files) and gets the extracted text plus Vision-attached pixels, instead of trying to install Python packages. Controlled by `documents.enabled`
- `[LocalForge Vision Attach: "<path>"]` marker: the serializers attach the images of tool results carrying it, without duplicating the extracted text

### Fixed
- dsh file handles are now decoded as JSON string literals, matching how `dsh-llm` quotes names and paths (escaped backslashes, quotes)

## [0.1.2] - 2026-11-05

### Added
- **Native PDF, OCR & Local Image Vision expansion** (`src/document/pdf-and-image.ts`): automatically intercepts `dsh` file handles (`[File "..." saved at "..."]`), `FileBlock` attachments, and local `.pdf`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` file or directory paths, extracting PDF text and embedded/scanned page images and forwarding them as `image_url` (OpenAI) or base64 `image` (Anthropic) Vision blocks
- **Adapter `resolveModel()` implementation** in `ChatCompletionsAdapter` and `AnthropicMessagesAdapter` so `@deepseek-ai/dsh-llm` receives `inputModalities: ['text', 'image']`, `context: { contextWindow }`, and `defaultMaxTokens` during `prepareCall()`
- **`documents` configuration section** (`enabled`, `maxFileBytes`, `maxPdfImages`, `maxPdfTextChars`) to customize automatic PDF and Vision expansion

### Fixed
- Propagated `defaultContextWindow` and `defaultMaxTokens` through `ResolvedConnection` so context-window pre-flight checks always have valid limits
- Preserved `message_start` baseline `input_tokens` across `message_delta` events in `translateAnthropic`

## [0.1.1] - 2026-11-03

### Added
- **Live LM Studio connection diagnostics**: actionable error messages when LM Studio's Local Server is unreachable instead of generic `fetch failed` errors
- **Real-time provider health status** in DSH Settings → Models via `registerConfigurableProviders` and `HealthCheck` (now enabled by default)

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

[Unreleased]: https://github.com/orfeomorello/dsh-localforge/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/orfeomorello/dsh-localforge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/orfeomorello/dsh-localforge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/orfeomorello/dsh-localforge/releases/tag/v0.1.0