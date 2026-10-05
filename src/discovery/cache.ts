/**
 * TTL-bounded cache for one LM Studio listing probe.
 *
 * The native `/api/v0/models` endpoint discloses load state and per-model
 * context, but is not part of LM Studio's OpenAI-compat contract: probes
 * fail on a custom gateway or a future breaking change. The OpenAI-compat
 * `/v1/models` listing is always there but discloses only ids. The fetcher
 * tries native first, falls back to compat.
 *
 * Caching the listing shortens resolveModel latency and saves the LM
 * Studio backend from a probe per request. The TTL is short (default 30s)
 * so a model load or unload in the LM Studio UI surfaces in seconds, not
 * minutes. `invalidate()` is exposed for callers that know the listing
 * changed (e.g. after a `load` POST).
 */

export interface LmStudioLoadedModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  state?: 'loaded' | 'not-loaded'
  vision?: boolean
}

export class ListingCache {
  private entry: { expiresAt: number; listing: LmStudioLoadedModel[] } | undefined
  private hits = 0
  private misses = 0

  constructor(
    private readonly fetcher: () => Promise<LmStudioLoadedModel[]>,
    private readonly ttlMs: () => number,
  ) {}

  async get(): Promise<LmStudioLoadedModel[]> {
    const now = Date.now()
    if (this.entry !== undefined && this.entry.expiresAt > now) {
      this.hits++
      return this.entry.listing
    }
    this.misses++
    const fresh = await this.fetcher()
    const ttl = this.ttlMs()
    this.entry = {
      expiresAt: ttl > 0 ? now + ttl : Number.POSITIVE_INFINITY,
      listing: fresh,
    }
    return fresh
  }

  invalidate(): void {
    this.entry = undefined
  }

  stats(): { hits: number; misses: number; cached: boolean } {
    return { hits: this.hits, misses: this.misses, cached: this.entry !== undefined }
  }
}