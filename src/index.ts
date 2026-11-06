/**
 * Plugin entry point for `dsh-localforge`.
 *
 * The plugin lives inside the dsh checkout at `plugins/dsh-localforge/`
 * and is linked into a profile via
 * `dsh plugin --profile web add link:./plugins/dsh-localforge`. Its
 * `cordis.patch.yml` declares a dormant bundle layer; this `apply`
 * function is what activates it.
 *
 * Responsibilities of this file:
 *  1. validate the user config (Schemastery);
 *  2. build per-request resolvers (config, credentials) for both the
 *     OpenAI route and the Anthropic route;
 *  3. construct the discovery cache, both adapters (OpenAI-compat and
 *     Anthropic-compat), the health check, and the metrics route;
 *  4. register everything on `ctx.llm` so the harness picks the routes
 *     up;
 *  5. install the settings section so the web UI's Models page writes
 *     the configuration the resolvers re-read on every operation.
 *
 * A change in the settings section (user edits `baseURL`, swaps the
 * API key, adds a model override, etc.) reaches the very next request
 * because the resolvers are thunks over a swap function (`setSource`).
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ConfigSchema } from './config/schema.ts'
import type { Config, DocumentsConfig } from './config/schema.ts'
import type { ResolvedConnection } from './config/resolve.ts'
import { ListingCache } from './discovery/cache.ts'
import { fetchListing } from './discovery/fetcher.ts'
import { ChatCompletionsAdapter } from './adapter/chat-completions.ts'
import { AnthropicMessagesAdapter } from './adapter/anthropic-messages.ts'
import { logger } from './observability/log.ts'
import { metrics, registry, setMetricsPrefix } from './observability/metrics.ts'
import { HealthCheck } from './observability/health.ts'
import {
  buildReadDocumentTool,
  READ_DOCUMENT_TOOL_NAME,
  type ToolsRegistryLike,
} from './document/tool.ts'

/** The plugin's Cordis row id (must match `cordis.patch.yml`). */
export const name = 'llm-localforge'

/** Services the plugin needs injected. */
export const inject = ['llm', 'settings', 'credentials'] as const

/** Public shape of the apply-time config. */
export interface ApplyConfig {
  defaultConnection?: Partial<Config['defaultConnection']>
  anthropicConnection?: Partial<Config['anthropicConnection']>
  defaultContextWindow?: number
  defaultMaxTokens?: number
  models?: ReadonlyArray<{
    id: string
    name?: string
    description?: string
    contextWindow?: number
    maxTokens?: number
    vision?: boolean
    preset?: 'code' | 'chat' | 'creative' | 'precise'
    reasoningBudget?: number
    fallback?: readonly string[]
  }>
  tokenizer?: { encoding?: 'o200k_base' | 'cl100k_base' | 'p50k_base' | 'p50k_edit' | 'r50k_base' }
  documents?: Partial<DocumentsConfig>
  metrics?: { enabled?: boolean; prefix?: string }
  healthCheck?: { enabled?: boolean; intervalMs?: number }
}

/**
 * Apply the plugin to a Cordis context.
 *
 * @param ctx - the Cordis context.
 * @param rawConfig - the plugin config (from `cordis.yml` and the
 *   `llm-localforge` settings section).
 */
export function apply(ctx: Context, rawConfig: ApplyConfig): void {
  // 1. validate and snapshot the initial config
  const initial = ConfigSchema(rawConfig as unknown as Config)
  setMetricsPrefix(initial.metrics.prefix)

  // 2. per-request config resolvers (swap function for hot-reload)
  let current: () => Config = () => initial

  // per-protocol resolver: callers pass a hint for which connection to read
  const resolveConnFor = (protocol: 'openai' | 'anthropic'): ResolvedConnection => {
    const cfg = current()
    const c = protocol === 'anthropic' ? cfg.anthropicConnection : cfg.defaultConnection
    return {
      baseURL: c.baseURL,
      ...c.apiKeyEnv !== undefined ? { apiKeyEnv: c.apiKeyEnv } : {},
      requestTimeoutMs: c.requestTimeoutMs,
      streamIdleTimeoutMs: c.streamIdleTimeoutMs,
      discoveryTimeoutMs: c.discoveryTimeoutMs,
      listingCacheMs: c.listingCacheMs,
      maxConcurrentPerModel: c.maxConcurrentPerModel,
      retryPolicy: c.retryPolicy,
      defaultContextWindow: cfg.defaultContextWindow ?? 32_768,
      defaultMaxTokens: cfg.defaultMaxTokens ?? 4_096,
      documents: cfg.documents,
    }
  }

  // 3. per-request credential resolver
  const resolveApiKey = async (c: ResolvedConnection): Promise<string> => {
    if (c.apiKeyEnv === undefined) return 'lm-studio' // dummy bearer
    const credentials = ctx.get('credentials')
    const hit = await credentials?.resolve(c.apiKeyEnv as unknown as never)
    if (hit !== undefined) {
      const value = (hit as { value: string }).value
      if (typeof value === 'string' && value.length > 0) return value
    }
    throw new LlmError(
      `no API key for ${String(c.apiKeyEnv)}; configure credentials or unset apiKeyEnv`,
      'MISSING_CREDENTIAL',
    )
  }

  // 4. discovery cache (one cache per protocol, resolving current config per probe)
  const openaiCache = new ListingCache(
    async () => {
      const conn = resolveConnFor('openai')
      const key = await resolveApiKey(conn).catch(() => 'lm-studio')
      return fetchListing(conn.baseURL, key, conn.discoveryTimeoutMs)
    },
    () => resolveConnFor('openai').listingCacheMs,
  )
  const anthropicCache = new ListingCache(
    async () => {
      const conn = resolveConnFor('anthropic')
      const key = await resolveApiKey(conn).catch(() => 'lm-studio')
      return fetchListing(conn.baseURL, key, conn.discoveryTimeoutMs)
    },
    () => resolveConnFor('anthropic').listingCacheMs,
  )

  // 5. model overrides (shared between adapters)
  const modelOverrides = initial.models

  // 6. adapters
  const ccAdapter = new ChatCompletionsAdapter({
    resolveConn: () => resolveConnFor('openai'),
    resolveApiKey,
    cache: openaiCache,
    modelOverrides,
    resolveAttachments: () => ctx.get('attachments'),
  })
  const anthAdapter = new AnthropicMessagesAdapter({
    resolveConn: () => resolveConnFor('anthropic'),
    resolveApiKey,
    cache: anthropicCache,
    modelOverrides,
    resolveAttachments: () => ctx.get('attachments'),
  })

  // 7. registrations on the llm registry
  let currentError: string | undefined
  const buildDirEntries = (error?: string) => [
    {
      provider: 'localforge',
      displayName: 'LocalForge',
      settingsNs: 'llm-localforge',
      settingsPath: [] as const,
      ...error === undefined ? {} : { error },
    },
    {
      provider: 'localforge-anthropic',
      displayName: 'LocalForge (Anthropic)',
      settingsNs: 'llm-localforge',
      settingsPath: [] as const,
      ...error === undefined ? {} : { error },
    },
  ]
  const dirHandle = ctx.llm.registerConfigurableProviders(buildDirEntries())
  const updateProviderError = (error?: string): void => {
    if (error === currentError) return
    currentError = error
    try {
      dirHandle.replace(buildDirEntries(error))
    } catch { /* registration may already be disposed */ }
  }

  ctx.llm.registerAdapter(['localforge'], ccAdapter)
  ctx.llm.registerAdapter(['localforge-anthropic'], anthAdapter)
  ctx.llm.registerModelDiscovery('llm-localforge', async (req, sig) => {
    const conn = resolveConnFor('openai')
    const baseURL = req.baseURL ?? conn.baseURL
    const key = req.apiKey ?? await resolveApiKey(conn).catch(() => 'lm-studio')
    try {
      const models = await fetchListing(baseURL, key, conn.discoveryTimeoutMs, sig)
      updateProviderError(undefined)
      return models.map(m => ({
        id: m.id,
        ...m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow },
      }))
    } catch (err) {
      updateProviderError(err instanceof Error ? err.message : String(err))
      throw err
    }
  })
  ctx.llm.registerModelDiscovery('llm-localforge-anthropic', async (req, sig) => {
    const conn = resolveConnFor('anthropic')
    const baseURL = req.baseURL ?? conn.baseURL
    const key = req.apiKey ?? await resolveApiKey(conn).catch(() => 'lm-studio')
    try {
      const models = await fetchListing(baseURL, key, conn.discoveryTimeoutMs, sig)
      updateProviderError(undefined)
      return models.map(m => ({
        id: m.id,
        ...m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow },
      }))
    } catch (err) {
      updateProviderError(err instanceof Error ? err.message : String(err))
      throw err
    }
  })

  // 8. health check (auto-reconnect, live provider status & structured-log transitions)
  let hc: HealthCheck | undefined
  if (initial.healthCheck.enabled) {
    hc = new HealthCheck(
      () => resolveConnFor('openai').baseURL,
      () => resolveApiKey(resolveConnFor('openai')).catch(() => 'lm-studio'),
      initial.healthCheck.intervalMs,
      (healthy, errMsg) => {
        updateProviderError(healthy ? undefined : errMsg)
        logger.info({ healthy }, 'localforge health changed')
      },
    )
    hc.start()
    ctx.effect(() => () => {
      hc?.stop()
      metrics.queueDepth.reset()
    })
  }

  // 9. install the settings section so the UI can edit it
  ctx.inject(['settings'] as never, (scUnknown: unknown) => {
    const sc = scUnknown as {
      settings: {
        installSection: (
          ctx: Context,
          ns: string,
          schema: never,
          initial: Config,
          hooks: { setSource: (s: () => Config) => void; onChange: () => void },
        ) => void
      }
    }
    sc.settings.installSection(ctx, 'llm-localforge', ConfigSchema as never, initial, {
      setSource: (s: () => Config) => {
        current = s
        openaiCache.invalidate()
        anthropicCache.invalidate()
        hc?.probeNow()
      },
      onChange: () => {
        openaiCache.invalidate()
        anthropicCache.invalidate()
        hc?.probeNow()
      },
    })
  })

  // 10. localforge_read_document tool (only when the tools service is mounted)
  if (initial.documents.enabled) {
    ctx.inject(['tools'] as never, (tcUnknown: unknown) => {
      const tc = tcUnknown as { tools?: ToolsRegistryLike }
      if (tc.tools === undefined) return
      tc.tools.register(buildReadDocumentTool(() => current().documents))
      logger.info({ tool: READ_DOCUMENT_TOOL_NAME }, 'localforge document tool registered')
    })
  }

  // 11. metrics route
  if (initial.metrics.enabled) {
    ctx.inject(['http'] as never, (hcHttp: unknown) => {
      const http = hcHttp as {
        http: { use: (path: string, handler: (req: unknown, res: { setHeader: (k: string, v: string) => void; end: (b: string) => void }) => void) => void }
      }
      http.http.use('/metrics', async (_req, res) => {
        res.setHeader('Content-Type', registry.contentType)
        res.end(await registry.metrics())
      })
    })
  }

  logger.info(
    { openai: initial.defaultConnection.baseURL, anthropic: initial.anthropicConnection.baseURL },
    'localforge plugin applied',
  )
}

// Public re-exports for tests and consumers
export { ChatCompletionsAdapter } from './adapter/chat-completions.ts'
export { AnthropicMessagesAdapter } from './adapter/anthropic-messages.ts'
export { ListingCache, type LmStudioLoadedModel } from './discovery/cache.ts'
export { fetchListing } from './discovery/fetcher.ts'
export { ensureLoaded } from './discovery/autoload.ts'
export { Semaphore } from './lifecycle/semaphore.ts'
export { streamWithFallback } from './lifecycle/fallback.ts'
export { applyReasoningBudget, supportsReasoningEffort } from './lifecycle/reasoning.ts'
export {
  estimateInputTokens,
  fitsContext,
} from './lifecycle/token-estimator.ts'
export {
  createTokenizer,
  counterFor,
  type SupportedEncoding,
  type Tokenizer,
  type TokenCounter,
} from './lifecycle/tokenizer.ts'
export { applyPreset, SamplingPresets, type PresetName } from './config/presets.ts'
export { translate, mapFinishReason, mapUsage } from './streaming/translate.ts'
export { translateAnthropic } from './streaming/anthropic-translate.ts'
export { parseSse, DONE } from './streaming/sse.ts'
export { parseAnthropicSse } from './streaming/anthropic-sse.ts'
export {
  serializeRequest,
  serializeMessages,
} from './streaming/serialize.ts'
export { serializeAnthropicRequest } from './streaming/anthropic-serialize.ts'
export {
  classifyDocumentPath,
  detectImageMediaType,
  extractPdfPureJs,
  extractPdfFile,
  extractImageFile,
  expandDocumentOrImagePath,
  expandTextWithLocalDocuments,
  inspectLocalPathOrDirectory,
  type VisionMediaType,
  type ExtractedVisionImage,
  type DocumentExpansionResult,
  type DocumentExpandOptions,
} from './document/pdf-and-image.ts'
export {
  buildReadDocumentTool,
  readDocumentForTool,
  visionAttachMarker,
  READ_DOCUMENT_TOOL_NAME,
} from './document/tool.ts'
export { registry as metricsRegistry } from './observability/metrics.ts'
export { logger } from './observability/log.ts'
