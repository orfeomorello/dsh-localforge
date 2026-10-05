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
    const initial = ConfigSchema(rawConfig ?? {});
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
    // 4. discovery cache (one cache per baseURL)
    const openaiBaseURL = initial.defaultConnection.baseURL;
    const anthropicBaseURL = initial.anthropicConnection.baseURL;
    const openaiCache = new ListingCache(() => fetchListing(openaiBaseURL, 'lm-studio', initial.defaultConnection.discoveryTimeoutMs), () => initial.defaultConnection.listingCacheMs);
    const anthropicCache = new ListingCache(() => fetchListing(anthropicBaseURL, 'lm-studio', initial.anthropicConnection.discoveryTimeoutMs), () => initial.anthropicConnection.listingCacheMs);
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
    ctx.llm.registerConfigurableProviders([
        {
            provider: 'localforge',
            displayName: 'LocalForge',
            settingsNs: 'llm-localforge',
            declared: false,
        },
        {
            provider: 'localforge-anthropic',
            displayName: 'LocalForge (Anthropic)',
            settingsNs: 'llm-localforge',
            declared: false,
        },
    ]);
    ctx.llm.registerAdapter(['localforge'], ccAdapter);
    ctx.llm.registerAdapter(['localforge-anthropic'], anthAdapter);
    ctx.llm.registerModelDiscovery('llm-localforge', async (req, sig) => {
        const conn = resolveConnFor('openai');
        const key = await resolveApiKey(conn).catch(() => 'lm-studio');
        const models = await fetchListing(conn.baseURL, key, conn.discoveryTimeoutMs, sig);
        return models.map(m => ({
            id: m.id,
            ...m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow },
        }));
    });
    ctx.llm.registerModelDiscovery('llm-localforge-anthropic', async (req, sig) => {
        const conn = resolveConnFor('anthropic');
        const key = await resolveApiKey(conn).catch(() => 'lm-studio');
        const models = await fetchListing(conn.baseURL, key, conn.discoveryTimeoutMs, sig);
        return models.map(m => ({
            id: m.id,
            ...m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow },
        }));
    });
    // 8. install the settings section so the UI can edit it
    ctx.inject(['settings'], (sc) => {
        sc.settings.installSection(ctx, 'llm-localforge', ConfigSchema, initial, {
            setSource: (s) => {
                current = s;
                openaiCache.invalidate();
                anthropicCache.invalidate();
            },
            onChange: () => {
                openaiCache.invalidate();
                anthropicCache.invalidate();
            },
        });
    });
    // 9. metrics route
    if (initial.metrics.enabled) {
        ctx.inject(['http'], (hc) => {
            const http = hc;
            http.http.use('/metrics', async (_req, res) => {
                res.setHeader('Content-Type', registry.contentType);
                res.end(await registry.metrics());
            });
        });
    }
    // 10. health check (auto-reconnect, structured-log transitions)
    if (initial.healthCheck.enabled) {
        const hc = new HealthCheck(initial.defaultConnection.baseURL, () => resolveApiKey(resolveConnFor('openai')), initial.healthCheck.intervalMs, (healthy) => logger.info({ healthy }, 'localforge health changed'));
        hc.start();
        ctx.on('dispose', () => {
            hc.stop();
            metrics.queueDepth.reset();
        });
    }
    logger.info({ openai: openaiBaseURL, anthropic: anthropicBaseURL }, 'localforge plugin applied');
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
export { registry as metricsRegistry } from "./observability/metrics.js";
export { logger } from "./observability/log.js";
