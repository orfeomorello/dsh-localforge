/**
 * Prometheus metrics for the plugin.
 *
 * Exposed via `/metrics` HTTP route when the harness mounts the http
 * service (see apply()). All metrics share the `dsh_lmstudio` prefix by
 * default. Cardinality is bounded — labels are `model` and `kind`/`code`,
 * never free-form strings — so Prometheus storage stays predictable.
 */

import { Counter, Gauge, Histogram, Registry } from 'prom-client'

export const registry = new Registry()

let prefix = 'dsh_lmstudio'

export function setMetricsPrefix(p: string): void {
  prefix = p.replace(/[^a-zA-Z0-9_]/g, '_')
}

export const metrics = {
  ttft: new Histogram({
    name: `${prefix}_ttft_seconds`,
    help: 'Time to first token, in seconds',
    labelNames: ['model'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [registry],
  }),

  tokens: new Counter({
    name: `${prefix}_tokens_total`,
    help: 'Tokens processed by kind',
    labelNames: ['model', 'kind'] as const,
    registers: [registry],
  }),

  queueDepth: new Gauge({
    name: `${prefix}_queue_depth`,
    help: 'Currently pending stream requests per model',
    labelNames: ['model'] as const,
    registers: [registry],
  }),

  errors: new Counter({
    name: `${prefix}_errors_total`,
    help: 'Errors by model and code',
    labelNames: ['model', 'code'] as const,
    registers: [registry],
  }),

  cacheHits: new Counter({
    name: `${prefix}_listing_cache_total`,
    help: 'Listing cache hits vs misses',
    labelNames: ['outcome'] as const,
    registers: [registry],
  }),

  fallbacks: new Counter({
    name: `${prefix}_fallback_total`,
    help: 'Model fallback activations',
    labelNames: ['from', 'to', 'reason'] as const,
    registers: [registry],
  }),
}