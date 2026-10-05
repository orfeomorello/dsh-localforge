/**
 * AnthropicMessagesAdapter: full-featured Anthropic-compatible
 * adapter for LM Studio's `/v1/messages` endpoint.
 *
 * Production scope:
 *  - Live listing (same ListingCache as the OpenAI route)
 *  - Auto-load via the same REST native API
 *  - Token pre-flight via the real `gpt-tokenizer`
 *  - Per-model concurrency limit
 *  - Sampling presets
 *  - Reasoning budget (translated to Anthropic's
 *    `thinking: { type: 'enabled', budget_tokens }`)
 *  - Full SSE translation including thinking, text, and tool_use blocks
 *  - Tool calling with partial-JSON delta accumulation
 *  - Vision via base64 image blocks
 *  - Fallback chain on recoverable errors
 *  - Idle watchdog + abort propagation
 *  - Prometheus metrics
 *
 * Auth uses `x-api-key` (Anthropic protocol). The `anthropic-version`
 * header is required; we send `2023-06-01` (LM Studio accepts it).
 */

import {
  LlmAdapter,
  LlmError,
  ToolCallId,
  attributionHeaders,
} from '@deepseek-ai/dsh-llm'
import type {
  AttachmentStore,
} from '@deepseek-ai/dsh-attachment'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ListingCache, LmStudioLoadedModel } from '../discovery/cache.ts'
import { ensureLoaded } from '../discovery/autoload.ts'
import { Semaphore } from '../lifecycle/semaphore.ts'
import { streamWithFallback } from '../lifecycle/fallback.ts'
import { fitsContext } from '../lifecycle/token-estimator.ts'
import { counterFor } from '../lifecycle/tokenizer.ts'
import { applyPreset, type PresetName } from '../config/presets.ts'
import type { ResolvedConnection } from '../config/resolve.ts'
import { serializeAnthropicRequest } from '../streaming/anthropic-serialize.ts'
import { parseAnthropicSse } from '../streaming/anthropic-sse.ts'
import { translateAnthropic } from '../streaming/anthropic-translate.ts'
import { metrics } from '../observability/metrics.ts'
import type { AnthropicRequest } from '../types/wire.ts'

/** The Anthropic protocol version LM Studio accepts. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Anthropic's `thinking` budget can be at most 64000 tokens. */
const MAX_THINKING_BUDGET = 64_000

export interface AnthropicMessagesAdapterOptions {
  resolveConn: () => ResolvedConnection
  resolveApiKey: (c: ResolvedConnection) => Promise<string>
  cache: ListingCache
  modelOverrides?: ReadonlyArray<{
    id: string
    name?: string
    description?: string
    contextWindow?: number
    maxTokens?: number
    vision?: boolean
    preset?: PresetName
    reasoningBudget?: number
    fallback?: readonly string[]
  }>
  resolveAttachments?: () => AttachmentStore | undefined
}

interface EffectiveConnection extends ResolvedConnection {
  baseURLNoV1: string
}

/**
 * One AnthropicMessagesAdapter instance serves the single
 * `localforge-anthropic` provider route.
 */
export class AnthropicMessagesAdapter extends LlmAdapter {
  private readonly semaphores = new Map<string, Semaphore>()

  constructor(private readonly opts: AnthropicMessagesAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'LocalForge (Anthropic)' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.opts.resolveConn().retryPolicy as ResolvedRetryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.opts.cache.get()
    const overrides = this.opts.modelOverrides ?? []
    const byId = new Map(overrides.map(o => [o.id, o]))
    return models.map((m: LmStudioLoadedModel) => {
      const o = byId.get(m.id)
      return {
        provider,
        id: m.id,
        name: o?.name ?? m.id,
        ...o?.description !== undefined ? { description: o.description } : {},
        inputModalities: (o?.vision ?? m.vision) === false
          ? (['text'] as const)
          : (['text', 'image'] as const),
      }
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const conn = this.normalizeConn(this.opts.resolveConn())
    const key = await this.opts.resolveApiKey(conn)
    const overrides = this.opts.modelOverrides ?? []
    const override = overrides.find(o => o.id === options.model)

    // -- 1. resolve context window and output cap
    const contextWindow = override?.contextWindow ?? conn.defaultContextWindow
    const outputCap = options.maxTokens ?? override?.maxTokens ?? conn.defaultMaxTokens

    // -- 2. token pre-flight (real tokenizer)
    const counter = counterFor('cl100k_base')
    const preflight = fitsContext(options, counter, contextWindow, outputCap)
    if (!preflight.fits) {
      metrics.errors.inc({ model: options.model, code: 'OVERFLOW' })
      throw new LlmError(
        `request exceeds context window: ~${preflight.inputTokens} in + ${outputCap} out > ${contextWindow}`,
        'OVERFLOW',
      )
    }

    // -- 3. per-model concurrency limit
    const sem = this.semaphores.get(options.model) ??
      (() => {
        const s = new Semaphore(conn.maxConcurrentPerModel)
        this.semaphores.set(options.model, s)
        return s
      })()
    await sem.acquire(options.signal)
    metrics.queueDepth.inc({ model: options.model })

    try {
      // -- 4. best-effort auto-load
      try {
        await ensureLoaded(
          conn.baseURL, options.model, key, Math.min(conn.requestTimeoutMs, 30_000),
          options.signal,
          () => this.opts.cache.get(),
        )
      } catch { /* best-effort */ }

      // -- 5. build the wire request
      let body = await serializeAnthropicRequest(
        options,
        this.opts.resolveAttachments?.(),
        outputCap,
      )
      body = this.applyReasoning(body, override?.reasoningBudget)
      body = this.applyPresetFields(body, override?.preset)

      // -- 6. fallback chain
      const chain: readonly string[] = override?.fallback !== undefined && override.fallback.length > 0
        ? [options.model, ...override.fallback]
        : [options.model]

      yield* streamWithFallback(
        (model) => this.runStream(model, body, conn, key, options),
        chain,
        options.signal,
      )
    } finally {
      sem.release()
      metrics.queueDepth.dec({ model: options.model })
    }
  }

  /** Apply the model's sampling preset to the Anthropic request body. */
  private applyPresetFields(body: AnthropicRequest, preset: PresetName | undefined): AnthropicRequest {
    if (preset === undefined) return body
    const p = applyPreset({}, preset)
    return {
      ...body,
      ...p.temperature !== undefined ? { temperature: body.temperature ?? p.temperature } : {},
      ...p.top_p !== undefined ? { top_p: body.top_p ?? p.top_p } : {},
    }
  }

  /**
   * Apply the reasoning budget as Anthropic's `thinking` block. If the
   * budget exceeds `MAX_THINKING_BUDGET`, clamp it. If the model has
   * not opted into thinking, the field is omitted.
   */
  private applyReasoning(body: AnthropicRequest, budget: number | undefined): AnthropicRequest {
    if (budget === undefined || budget <= 0) return body
    const clamped = Math.min(budget, MAX_THINKING_BUDGET)
    return { ...body, thinking: { type: 'enabled', budget_tokens: clamped } }
  }

  /** Strip a trailing `/v1` from a baseURL when present (Anthropic appends `/v1/messages`). */
  private normalizeConn(conn: ResolvedConnection): EffectiveConnection {
    const baseURLNoV1 = conn.baseURL.replace(/\/v1\/?$/, '')
    return { ...conn, baseURLNoV1 }
  }

  private async * runStream(
    model: string,
    body: AnthropicRequest,
    conn: EffectiveConnection,
    key: string,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    const controller = new AbortController()
    const upstream = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal])
    using watchdog = idleWatchdog(upstream, conn.streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    const startedAt = performance.now()
    let firstTokenAt: number | undefined

    let response: Response
    try {
      response = await fetch(`${conn.baseURLNoV1}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...attributionHeaders(),
        },
        body: JSON.stringify({ ...body, model }),
        signal: watchdog.signal,
      })
    } catch (err) {
      metrics.errors.inc({ model, code: 'TRANSPORT' })
      if (options.signal?.aborted) {
        throw new LlmError('caller aborted', 'ABORTED', { cause: err })
      }
      throw new LlmError(`transport error: ${(err as Error).message}`, 'TRANSPORT', { cause: err })
    }

    if (!response.ok) {
      const errBody = await response.json().catch(() => null)
      const msg = (errBody as { error?: { message?: string } } | null)?.error?.message
        ?? (errBody as { type?: string; message?: string } | null)?.message
        ?? `HTTP ${response.status}`
      const code = response.status === 401 || response.status === 403 ? 'AUTH'
        : response.status === 429 ? 'RATE_LIMIT'
        : response.status === 400 ? 'INVALID_REQUEST'
        : response.status >= 500 ? 'SERVER'
        : `HTTP_${response.status}` as const
      metrics.errors.inc({ model, code })
      throw new LlmError(msg, code, { status: response.status })
    }
    if (!response.body) {
      metrics.errors.inc({ model, code: 'EMPTY_RESPONSE' })
      throw new LlmError('empty response body', 'EMPTY_RESPONSE')
    }

    try {
      for await (const chunk of translateAnthropic(parseAnthropicSse(response.body))) {
        if (firstTokenAt === undefined && chunk.type !== 'finish' && chunk.type !== 'usage') {
          firstTokenAt = performance.now()
          metrics.ttft.observe({ model }, (firstTokenAt - startedAt) / 1000)
        }
        if (chunk.type === 'usage') {
          metrics.tokens.inc({ model, kind: 'input' }, chunk.usage.inputTokens)
          metrics.tokens.inc({ model, kind: 'output' }, chunk.usage.outputTokens)
        }
        yield chunk
      }
    } catch (err) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        metrics.errors.inc({ model, code: 'TIMEOUT' })
        throw new LlmError(`stream idle ${conn.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: err })
      }
      if (options.signal?.aborted) {
        throw new LlmError('caller aborted', 'ABORTED', { cause: err })
      }
      if (err instanceof LlmError) throw err
      metrics.errors.inc({ model, code: 'TRANSPORT' })
      throw new LlmError(`transport error: ${(err as Error).message}`, 'TRANSPORT', { cause: err })
    } finally {
      controller.abort()
    }
  }
}

// Re-export ToolCallId so consumers don't need a deep import
export { ToolCallId }