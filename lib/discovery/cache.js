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
export class ListingCache {
    fetcher;
    ttlMs;
    entry;
    hits = 0;
    misses = 0;
    constructor(fetcher, ttlMs) {
        this.fetcher = fetcher;
        this.ttlMs = ttlMs;
    }
    async get() {
        const now = Date.now();
        if (this.entry !== undefined && this.entry.expiresAt > now) {
            this.hits++;
            return this.entry.listing;
        }
        this.misses++;
        const fresh = await this.fetcher();
        const ttl = this.ttlMs();
        this.entry = {
            expiresAt: ttl > 0 ? now + ttl : Number.POSITIVE_INFINITY,
            listing: fresh,
        };
        return fresh;
    }
    invalidate() {
        this.entry = undefined;
    }
    stats() {
        return { hits: this.hits, misses: this.misses, cached: this.entry !== undefined };
    }
}
