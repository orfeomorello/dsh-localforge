/**
 * Bounded, dual-endpoint listing probe.
 *
 * Tries LM Studio's native `/api/v0/models` first because it discloses load
 * state, per-model context, and vision capability. Falls back to the
 * OpenAI-compat `/v1/models` listing when the native endpoint is unavailable
 * (older LM Studio, custom gateway). Both replies share the `{ data: [...] }`
 * envelope, so a 4xx on native routes to compat, not abort.
 *
 * Listing body is bounded at 4 MB to refuse a runaway server before parsing.
 */

import type { LmStudioLoadedModel } from './cache.ts'

const MAX_LISTING_BYTES = 4 * 1024 * 1024

export async function fetchListing(
  baseURL: string,
  apiKey: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LmStudioLoadedModel[]> {
  const root = baseURL.replace(/\/v1\/?$/, '')
  const timer = AbortSignal.timeout(timeoutMs)
  const fused = signal === undefined ? timer : AbortSignal.any([signal, timer])
  try {
    return await probeNative(root, apiKey, fused)
  } catch (err) {
    if (fused.aborted) throw err
    // native is best-effort; the compat listing is the documented address
  }
  return probeCompat(baseURL, apiKey, fused)
}

async function probeNative(
  root: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<LmStudioLoadedModel[]> {
  const r = await fetch(`${root}/api/v0/models`, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
    signal,
  })
  if (!r.ok) throw new Error(`native listing ${r.status}`)
  const text = await readBounded(r, `${root}/api/v0/models`, signal)
  const body = JSON.parse(text) as { data: unknown }
  if (!Array.isArray(body.data)) throw new Error('native listing: no data array')
  return readNativeRows(body.data)
}

async function probeCompat(
  baseURL: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<LmStudioLoadedModel[]> {
  const url = `${baseURL.replace(/\/+$/, '')}/models`
  const r = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
    signal,
  })
  if (!r.ok) throw new Error(`compat listing ${r.status}`)
  const text = await readBounded(r, url, signal)
  const body = JSON.parse(text) as { data: unknown }
  if (!Array.isArray(body.data)) throw new Error('compat listing: no data array')
  return readCompatRows(body.data)
}

async function readBounded(r: Response, url: string, signal: AbortSignal): Promise<string> {
  if (r.body === null) return ''
  const declared = Number(r.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_LISTING_BYTES) {
    await r.body.cancel()
    throw new Error(`${url}: response larger than ${MAX_LISTING_BYTES} bytes`)
  }
  const reader = r.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_LISTING_BYTES) throw new Error(`${url}: body too large`)
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const buf = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { buf.set(c, offset); offset += c.byteLength }
  return new TextDecoder().decode(buf)
}

function readNativeRows(rows: readonly unknown[]): LmStudioLoadedModel[] {
  const out: LmStudioLoadedModel[] = []
  for (const raw of rows) {
    const e = raw as { id?: unknown; state?: unknown; loaded_context_length?: unknown; max_context_length?: unknown; type?: unknown } | null
    if (typeof e?.id !== 'string' || e.id.length === 0) continue
    const loaded = e.state === 'loaded' ? positiveInt(e.loaded_context_length) : undefined
    const max = positiveInt(e.max_context_length)
    const contextWindow = loaded ?? max
    const vision = e.type === 'vlm' ? true : e.type === 'llm' ? false : undefined
    out.push({
      id: e.id,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...e.state === 'loaded' || e.state === 'not-loaded' ? { state: e.state } : {},
      ...vision === undefined ? {} : { vision },
    })
  }
  return out
}

function readCompatRows(rows: readonly unknown[]): LmStudioLoadedModel[] {
  const out: LmStudioLoadedModel[] = []
  for (const raw of rows) {
    const e = raw as { id?: unknown } | null
    if (typeof e?.id !== 'string' || e.id.length === 0) continue
    out.push({ id: e.id })
  }
  return out
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined
}