/**
 * Model fallback chain.
 *
 * A model's `fallback: [a, b, c]` lists alternative model ids to try if
 * the primary one returns a recoverable error. The chain is processed
 * in order, FIFO. Once a model succeeds, the chain is done.
 *
 * Recoverable errors: `TRANSPORT`, `TIMEOUT`, `SERVER`, `RATE_LIMIT`.
 * Non-recoverable errors (`AUTH`, `INVALID_REQUEST`,
 * `UNSUPPORTED_CONTENT`, `OVERFLOW`) propagate immediately — the
 * user's request is broken, retrying with another model doesn't help.
 *
 * The `from` and `to` labels are exposed in the Prometheus counter
 * `dsh_localforge_fallback_total{from, to, reason}` so an operator
 * can see how often each fallback path is taken.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { metrics } from '../observability/metrics.ts'

const RECOVERABLE = new Set(['TRANSPORT', 'TIMEOUT', 'SERVER', 'RATE_LIMIT'])

/**
 * Try a primary stream call, falling back to the chain on a recoverable
 * error. A successful primary yields its chunks and returns. A
 * non-recoverable error throws immediately. The chain is exhausted
 * either by success (any model) or by running out of fallbacks (the
 * last error is re-thrown).
 *
 * @param primary - factory that opens a stream for a given model id.
 * @param chain - the model ids to try, in order. The first id is the
 *   primary.
 * @param signal - abort signal forwarded to each stream call.
 */
export async function* streamWithFallback(
  primary: (model: string) => AsyncIterable<StreamChunk>,
  chain: readonly string[],
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  if (chain.length === 0) {
    throw new LlmError('fallback chain is empty', 'INVALID_REQUEST')
  }
  let lastErr: unknown
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]
    if (model === undefined) continue
    if (signal?.aborted) throw new LlmError('aborted', 'ABORTED')
    try {
      for await (const chunk of primary(model)) {
        if (signal?.aborted) throw new LlmError('aborted', 'ABORTED')
        yield chunk
      }
      return
    } catch (err) {
      lastErr = err
      const code = err instanceof LlmError ? err.code : undefined
      const isRecoverable = code !== undefined && RECOVERABLE.has(code)
      if (!isRecoverable) throw err
      if (i + 1 < chain.length) {
        const next = chain[i + 1]
        if (next !== undefined) {
          metrics.fallbacks.inc({ from: model, to: next, reason: code })
        }
      }
    }
  }
  throw lastErr ?? new LlmError('all fallbacks exhausted', 'TRANSPORT')
}