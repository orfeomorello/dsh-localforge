/**
 * Ensure a model is loaded on LM Studio before use.
 *
 * LM Studio 0.4+ exposes `POST {root}/api/v0/models/{id}/load` to ask the
 * server to bring a model into memory. Older builds don't accept the POST
 * and rely on the UI to load models; this function's `POST` will 404 and we
 * then poll the listing until the model shows up (or doesn't).
 *
 * The function is best-effort: it throws only when the model remains
 * `not-loaded` after the deadline. The caller decides whether to fail the
 * request or proceed.
 */

import type { LmStudioLoadedModel } from './cache.ts'

const POLL_INTERVAL_MS = 500

export async function ensureLoaded(
  baseURL: string,
  modelId: string,
  apiKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
  listing: () => Promise<LmStudioLoadedModel[]> = async () => [],
): Promise<void> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

  const root = baseURL.replace(/\/v1\/?$/, '')

  // 1. already loaded? short-circuit
  const initial = await listing()
  if (initial.some(m => m.id === modelId && m.state === 'loaded')) return

  // 2. ask the server to load
  await fetch(`${root}/api/v0/models/${encodeURIComponent(modelId)}/load`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    signal,
  }).catch(() => {/* 404 on old builds, fine */})

  // 3. poll until loaded or deadline
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const current = await listing()
    const hit = current.find(m => m.id === modelId)
    if (hit?.state === 'loaded') return
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(`autoload: ${modelId} not loaded within ${timeoutMs}ms`)
}