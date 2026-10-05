/**
 * ChatCompletionsAdapter: the `localforge` provider route's transport.
 *
 * Pulls together:
 *  - listing cache + autoload (the model might not be in memory)
 *  - real token pre-flight via `gpt-tokenizer` (no more heuristic)
 *  - per-model concurrency limit (LM Studio serializes better than it
 *    parallelizes on quantized models)
 *  - SSE parsing + translate (eventsource-parser → StreamChunks)
 *  - reasoning budget (as `reasoning_effort` or system reminder)
 *  - sampling preset application (per-model base, per-request override)
 *  - Prometheus metrics (TTFT, tokens, queue depth, errors)
 *  - model fallback chain on recoverable errors
 *
 * One adapter instance serves the single `localforge` provider route.
 */

import {
  LlmAdapter,
  LlmError,
  ToolCallId,
  attributionHeaders,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ListingCache, LmStudioLoadedModel } from '../discovery/cache.ts'
import { ensureLoaded } from '../discovery/autoload.ts'
import { Semaphore } from '../lifecycle/semaphore.ts'
import { streamWithFallback } from '../lifecycle/fallback.ts'
import { applyReasoningBudget } from '../lifecycle/reasoning.ts'
import { fitsContext } from '../lifecycle/token-estimator.ts'
import { counterFor, createTokenizer } from '../lifecycle/tokenizer.ts'
import { applyPreset, type PresetName } from '../config/presets.ts'
import type { ResolvedConnection } from '../config/resolve.ts'
import { serializeRequest } from '../streaming/serialize.ts'
import { parseSse } from '../streaming/sse.ts'
import { translate } from '../streaming/translate.ts'
import { metrics } from '../observability/metrics.ts'
import type { WireRequest } from '../types/wire.ts'

export interface ChatCompletionsAdapterOptions {
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

/**
 * One ChatCompletionsAdapter instance serves the single `localforge`
 * provider route. The instance is held for the lifetime of the plugin
 * (cheap — just a per-model semaphore map).
 */
export class ChatCompletionsAdapter extends LlmAdapter {
  private readonly semaphores = new Map<string, Semaphore>()

  constructor(private readonly opts: ChatCompletionsAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'LocalForge' }
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
    const conn = this.opts.resolveConn()
    const key = await this.opts.resolveApiKey(conn)
    const overrides = this.opts.modelOverrides ?? []
    const override = overrides.find(o => o.id === options.model)

    // -- 1. resolve context window and output cap
    const contextWindow = override?.contextWindow ?? conn.defaultContextWindow
    const outputCap = options.maxTokens ?? override?.maxTokens ?? conn.defaultMaxTokens

    // -- 2. real token pre-flight (gpt-tokenizer)
    const counter = createTokenizer(options.model).count
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
      } catch { /* server may be old or already loaded */ }

      // -- 5. build the wire request, applying preset and reasoning budget
      const baseBody = await serializeRequest(
        options,
        this.opts.resolveAttachments?.(),
      )
      let body: WireRequest = baseBody
      body = applyPreset(body, override?.preset)
      body = applyReasoningBudget(body, override?.reasoningBudget)

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

  private async * runStream(
    model: string,
    body: WireRequest,
    conn: ResolvedConnection,
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
      response = await fetch(`${conn.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
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
      const msg = (errBody as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${response.status}`
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
      for await (const chunk of translate(parseSse(response.body))) {
        if (firstTokenAt === undefined && chunk.type !== 'finish' && chunk.type !== 'usage') {
          firstTokenAt = performance.now()
          metrics.ttft.observe({ model }, (firstTokenAt - startedAt) / 1000)
        }
        if (chunk.type === 'usage') {
          const u = chunk.usage
          metrics.tokens.inc({ model, kind: 'input' }, u.inputTokens)
          metrics.tokens.inc({ model, kind: 'output' }, u.outputTokens)
          if (u.reasoningTokens !== undefined) {
            metrics.tokens.inc({ model, kind: 'reasoning' }, u.reasoningTokens)
          }
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

// Re-export for the test suite's convenience
export { ToolCallId, counterFor }