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
import { LlmError } from '@deepseek-ai/dsh-llm';
import { ConfigSchema } from "./config/schema.js";
import { ListingCache } from "./discovery/cache.js";
import { fetchListing } from "./discovery/fetcher.js";
import { ChatCompletionsAdapter } from "./adapter/chat-completions.js";
import { AnthropicMessagesAdapter } from "./adapter/anthropic-messages.js";
import { logger } from "./observability/log.js";
import { metrics, registry, setMetricsPrefix } from "./observability/metrics.js";
import { HealthCheck } from "./observability/health.js";
import { buildReadDocumentTool, READ_DOCUMENT_TOOL_NAME, } from "./document/tool.js";
/** The plugin's Cordis row id (must match `cordis.patch.yml`). */
export const name = 'llm-localforge';
/** Services the plugin needs injected. */
export const inject = ['llm', 'settings', 'credentials'];
/**
 * Apply the plugin to a Cordis context.
 *
 * @param ctx - the Cordis context.
 * @param rawConfig - the plugin config (from `cordis.yml` and the
 *   `llm-localforge` settings section).
 */
export function apply(ctx, rawConfig) {
    // 1. validate and snapshot the initial config
    const initial = ConfigSchema(rawConfig);
    setMetricsPrefix(initial.metrics.prefix);
    // 2. per-request config resolvers (swap function for hot-reload)
    let current = () => initial;
    // per-protocol resolver: callers pass a hint for which connection to read
    const resolveConnFor = (protocol) => {
        const cfg = current();
        const c = protocol === 'anthropic' ? cfg.anthropicConnection : cfg.defaultConnection;
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
        };
    };
    // 3. per-request credential resolver
    const resolveApiKey = async (c) => {
        if (c.apiKeyEnv === undefined)
            return 'lm-studio'; // dummy bearer
        const credentials = ctx.get('credentials');
        const hit = await credentials?.resolve(c.apiKeyEnv);
        if (hit !== undefined) {
            const value = hit.value;
            if (typeof value === 'string' && value.length > 0)
                return value;
        }
        throw new LlmError(`no API key for ${String(c.apiKeyEnv)}; configure credentials or unset apiKeyEnv`, 'MISSING_CREDENTIAL');
    };
    // 4. discovery cache (one cache per protocol, resolving current config per probe)
    const openaiCache = new ListingCache(async () => {
        const conn = resolveConnFor('openai');
        const key = await resolveApiKey(conn).catch(() => 'lm-studio');
        return fetchListing(conn.baseURL, key, conn.discoveryTimeoutMs);
    }, () => resolveConnFor('openai').listingCacheMs);
    const anthropicCache = new ListingCache(async () => {
        const conn = resolveConnFor('anthropic');
        const key = await resolveApiKey(conn).catch(() => 'lm-studio');
        return fetchListing(conn.baseURL, key, conn.discoveryTimeoutMs);
    }, () => resolveConnFor('anthropic').listingCacheMs);
    // 5. model overrides (shared between adapters)
    const modelOverrides = initial.models;
    // 6. adapters
    const ccAdapter = new ChatCompletionsAdapter({
        resolveConn: () => resolveConnFor('openai'),
        resolveApiKey,
        cache: openaiCache,
        modelOverrides,
        resolveAttachments: () => ctx.get('attachments'),
    });
    const anthAdapter = new AnthropicMessagesAdapter({
        resolveConn: () => resolveConnFor('anthropic'),
        resolveApiKey,
        cache: anthropicCache,
        modelOverrides,
        resolveAttachments: () => ctx.get('attachments'),
    });
    // 7. registrations on the llm registry
    let currentError;
    const buildDirEntries = (error) => [
        {
            provider: 'localforge',
            displayName: 'LocalForge',
            settingsNs: 'llm-localforge',
            settingsPath: [],
            ...error === undefined ? {} : { error },
        },
        {
            provider: 'localforge-anthropic',
            displayName: 'LocalForge (Anthropic)',
            settingsNs: 'llm-localforge',
            settingsPath: [],
            ...error === undefined ? {} : { error },
        },
    ];
    const dirHandle = ctx.llm.registerConfigurableProviders(buildDirEntries());
    const updateProviderError = (error) => {
        if (error === currentError)
            return;
        currentError = error;
        try {
            dirHandle.replace(buildDirEntries(error));
        }
        catch { /* registration may already be disposed */ }
    };
    ctx.llm.registerAdapter(['localforge'], ccAdapter);
    ctx.llm.registerAdapter(['localforge-anthropic'], anthAdapter);
    ctx.llm.registerModelDiscovery('llm-localforge', async (req, sig) => {
        const conn = resolveConnFor('openai');
        const baseURL = req.baseURL ?? conn.baseURL;
        const key = req.apiKey ?? await resolveApiKey(conn).catch(() => 'lm-studio');
        try {
            const models = await fetchListing(baseURL, key, conn.discoveryTimeoutMs, sig);
            updateProviderError(undefined);
            return models.map(m => ({
                id: m.id,
                ...m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow },
            }));
        }
        catch (err) {
            updateProviderError(err instanceof Error ? err.message : String(err));
            throw err;
        }
    });
    ctx.llm.registerModelDiscovery('llm-localforge-anthropic', async (req, sig) => {
        const conn = resolveConnFor('anthropic');
        const baseURL = req.baseURL ?? conn.baseURL;
        const key = req.apiKey ?? await resolveApiKey(conn).catch(() => 'lm-studio');
        try {
            const models = await fetchListing(baseURL, key, conn.discoveryTimeoutMs, sig);
            updateProviderError(undefined);
            return models.map(m => ({
                id: m.id,
                ...m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow },
            }));
        }
        catch (err) {
            updateProviderError(err instanceof Error ? err.message : String(err));
            throw err;
        }
    });
    // 8. health check (auto-reconnect, live provider status & structured-log transitions)
    let hc;
    if (initial.healthCheck.enabled) {
        hc = new HealthCheck(() => resolveConnFor('openai').baseURL, () => resolveApiKey(resolveConnFor('openai')).catch(() => 'lm-studio'), initial.healthCheck.intervalMs, (healthy, errMsg) => {
            updateProviderError(healthy ? undefined : errMsg);
            logger.info({ healthy }, 'localforge health changed');
        });
        hc.start();
        ctx.effect(() => () => {
            hc?.stop();
            metrics.queueDepth.reset();
        });
    }
    // 9. install the settings section so the UI can edit it
    ctx.inject(['settings'], (scUnknown) => {
        const sc = scUnknown;
        sc.settings.installSection(ctx, 'llm-localforge', ConfigSchema, initial, {
            setSource: (s) => {
                current = s;
                openaiCache.invalidate();
                anthropicCache.invalidate();
                hc?.probeNow();
            },
            onChange: () => {
                openaiCache.invalidate();
                anthropicCache.invalidate();
                hc?.probeNow();
            },
        });
    });
    // 10. localforge_read_document tool (only when the tools service is mounted)
    if (initial.documents.enabled) {
        ctx.inject(['tools'], (tcUnknown) => {
            const tc = tcUnknown;
            if (tc.tools === undefined)
                return;
            tc.tools.register(buildReadDocumentTool(() => current().documents));
            logger.info({ tool: READ_DOCUMENT_TOOL_NAME }, 'localforge document tool registered');
        });
    }
    // 11. metrics route
    if (initial.metrics.enabled) {
        ctx.inject(['http'], (hcHttp) => {
            const http = hcHttp;
            http.http.use('/metrics', async (_req, res) => {
                res.setHeader('Content-Type', registry.contentType);
                res.end(await registry.metrics());
            });
        });
    }
    logger.info({ openai: initial.defaultConnection.baseURL, anthropic: initial.anthropicConnection.baseURL }, 'localforge plugin applied');
}
// Public re-exports for tests and consumers
export { ChatCompletionsAdapter } from "./adapter/chat-completions.js";
export { AnthropicMessagesAdapter } from "./adapter/anthropic-messages.js";
export { ListingCache } from "./discovery/cache.js";
export { fetchListing } from "./discovery/fetcher.js";
export { ensureLoaded } from "./discovery/autoload.js";
export { Semaphore } from "./lifecycle/semaphore.js";
export { streamWithFallback } from "./lifecycle/fallback.js";
export { applyReasoningBudget, supportsReasoningEffort } from "./lifecycle/reasoning.js";
export { estimateInputTokens, fitsContext, } from "./lifecycle/token-estimator.js";
export { createTokenizer, counterFor, } from "./lifecycle/tokenizer.js";
export { applyPreset, SamplingPresets } from "./config/presets.js";
export { translate, mapFinishReason, mapUsage } from "./streaming/translate.js";
export { translateAnthropic } from "./streaming/anthropic-translate.js";
export { parseSse, DONE } from "./streaming/sse.js";
export { parseAnthropicSse } from "./streaming/anthropic-sse.js";
export { serializeRequest, serializeMessages, } from "./streaming/serialize.js";
export { serializeAnthropicRequest } from "./streaming/anthropic-serialize.js";
export { classifyDocumentPath, detectImageMediaType, extractPdfPureJs, extractPdfFile, extractImageFile, expandDocumentOrImagePath, expandTextWithLocalDocuments, inspectLocalPathOrDirectory, } from "./document/pdf-and-image.js";
export { buildReadDocumentTool, readDocumentForTool, visionAttachMarker, READ_DOCUMENT_TOOL_NAME, } from "./document/tool.js";
export { registry as metricsRegistry } from "./observability/metrics.js";
export { logger } from "./observability/log.js";
