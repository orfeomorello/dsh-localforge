/**
 * AnthropicMessagesAdapter: full-featured Anthropic-compatible
 * adapter for LM Studio's `/v1/messages` endpoint.
 *
 * Production scope:
 *  - Live listing (same ListingCache as the OpenAI route)
 *  - Auto-load via the same REST native API
 *  - Token pre-flight via the real `gpt-tokenizer`
 *  - Per-model concurrency limit
 *  - Sampling presets
 *  - Reasoning budget (translated to Anthropic's
 *    `thinking: { type: 'enabled', budget_tokens }`)
 *  - Full SSE translation including thinking, text, and tool_use blocks
 *  - Tool calling with partial-JSON delta accumulation
 *  - Vision via base64 image blocks
 *  - Fallback chain on recoverable errors
 *  - Idle watchdog + abort propagation
 *  - Prometheus metrics
 *
 * Auth uses `x-api-key` (Anthropic protocol). The `anthropic-version`
 * header is required; we send `2023-06-01` (LM Studio accepts it).
 */
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { LlmAdapter, LlmError, ToolCallId, attributionHeaders, } from '@deepseek-ai/dsh-llm';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { ensureLoaded } from "../discovery/autoload.js";
import { Semaphore } from "../lifecycle/semaphore.js";
import { streamWithFallback } from "../lifecycle/fallback.js";
import { fitsContext } from "../lifecycle/token-estimator.js";
import { counterFor } from "../lifecycle/tokenizer.js";
import { applyPreset } from "../config/presets.js";
import { serializeAnthropicRequest } from "../streaming/anthropic-serialize.js";
import { parseAnthropicSse } from "../streaming/anthropic-sse.js";
import { translateAnthropic } from "../streaming/anthropic-translate.js";
import { metrics } from "../observability/metrics.js";
/** The Anthropic protocol version LM Studio accepts. */
const ANTHROPIC_VERSION = '2023-06-01';
/** Anthropic's `thinking` budget can be at most 64000 tokens. */
const MAX_THINKING_BUDGET = 64_000;
/**
 * One AnthropicMessagesAdapter instance serves the single
 * `localforge-anthropic` provider route.
 */
export class AnthropicMessagesAdapter extends LlmAdapter {
    opts;
    semaphores = new Map();
    constructor(opts) {
        super();
        this.opts = opts;
    }
    providerInfo(provider) {
        return { id: provider, name: 'LocalForge (Anthropic)' };
    }
    providerRetryPolicy(_provider) {
        return this.opts.resolveConn().retryPolicy;
    }
    async listModels(provider) {
        const models = await this.opts.cache.get();
        const overrides = this.opts.modelOverrides ?? [];
        const byId = new Map(overrides.map(o => [o.id, o]));
        return models.map((m) => {
            const o = byId.get(m.id);
            return {
                provider,
                id: m.id,
                name: o?.name ?? m.id,
                ...o?.description !== undefined ? { description: o.description } : {},
                inputModalities: (o?.vision ?? m.vision) === false
                    ? ['text']
                    : ['text', 'image'],
            };
        });
    }
    async *stream(options) {
        const conn = this.normalizeConn(this.opts.resolveConn());
        const key = await this.opts.resolveApiKey(conn);
        const overrides = this.opts.modelOverrides ?? [];
        const override = overrides.find(o => o.id === options.model);
        // -- 1. resolve context window and output cap
        const contextWindow = override?.contextWindow ?? conn.defaultContextWindow;
        const outputCap = options.maxTokens ?? override?.maxTokens ?? conn.defaultMaxTokens;
        // -- 2. token pre-flight (real tokenizer)
        const counter = counterFor('cl100k_base');
        const preflight = fitsContext(options, counter, contextWindow, outputCap);
        if (!preflight.fits) {
            metrics.errors.inc({ model: options.model, code: 'OVERFLOW' });
            throw new LlmError(`request exceeds context window: ~${preflight.inputTokens} in + ${outputCap} out > ${contextWindow}`, 'OVERFLOW');
        }
        // -- 3. per-model concurrency limit
        const sem = this.semaphores.get(options.model) ??
            (() => {
                const s = new Semaphore(conn.maxConcurrentPerModel);
                this.semaphores.set(options.model, s);
                return s;
            })();
        await sem.acquire(options.signal);
        metrics.queueDepth.inc({ model: options.model });
        try {
            // -- 4. best-effort auto-load
            try {
                await ensureLoaded(conn.baseURL, options.model, key, Math.min(conn.requestTimeoutMs, 30_000), options.signal, () => this.opts.cache.get());
            }
            catch { /* best-effort */ }
            // -- 5. build the wire request
            let body = await serializeAnthropicRequest(options, this.opts.resolveAttachments?.(), outputCap);
            body = this.applyReasoning(body, override?.reasoningBudget);
            body = this.applyPresetFields(body, override?.preset);
            // -- 6. fallback chain
            const chain = override?.fallback !== undefined && override.fallback.length > 0
                ? [options.model, ...override.fallback]
                : [options.model];
            yield* streamWithFallback((model) => this.runStream(model, body, conn, key, options), chain, options.signal);
        }
        finally {
            sem.release();
            metrics.queueDepth.dec({ model: options.model });
        }
    }
    /** Apply the model's sampling preset to the Anthropic request body. */
    applyPresetFields(body, preset) {
        if (preset === undefined)
            return body;
        const p = applyPreset({}, preset);
        return {
            ...body,
            ...p.temperature !== undefined ? { temperature: body.temperature ?? p.temperature } : {},
            ...p.top_p !== undefined ? { top_p: body.top_p ?? p.top_p } : {},
        };
    }
    /**
     * Apply the reasoning budget as Anthropic's `thinking` block. If the
     * budget exceeds `MAX_THINKING_BUDGET`, clamp it. If the model has
     * not opted into thinking, the field is omitted.
     */
    applyReasoning(body, budget) {
        if (budget === undefined || budget <= 0)
            return body;
        const clamped = Math.min(budget, MAX_THINKING_BUDGET);
        return { ...body, thinking: { type: 'enabled', budget_tokens: clamped } };
    }
    /** Strip a trailing `/v1` from a baseURL when present (Anthropic appends `/v1/messages`). */
    normalizeConn(conn) {
        const baseURLNoV1 = conn.baseURL.replace(/\/v1\/?$/, '');
        return { ...conn, baseURLNoV1 };
    }
    async *runStream(model, body, conn, key, options) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const controller = new AbortController();
            const upstream = options.signal === undefined
                ? controller.signal
                : AbortSignal.any([options.signal, controller.signal]);
            const watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, conn.streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT'), false);
            const startedAt = performance.now();
            let firstTokenAt;
            let response;
            try {
                response = await fetch(`${conn.baseURLNoV1}/v1/messages`, {
                    method: 'POST',
                    headers: {
                        'x-api-key': key,
                        'anthropic-version': ANTHROPIC_VERSION,
                        'content-type': 'application/json',
                        accept: 'text/event-stream',
                        ...attributionHeaders(),
                    },
                    body: JSON.stringify({ ...body, model }),
                    signal: watchdog.signal,
                });
            }
            catch (err) {
                metrics.errors.inc({ model, code: 'TRANSPORT' });
                if (options.signal?.aborted) {
                    throw new LlmError('caller aborted', 'ABORTED', { cause: err });
                }
                throw new LlmError(`transport error: ${err.message}`, 'TRANSPORT', { cause: err });
            }
            if (!response.ok) {
                const errBody = await response.json().catch(() => null);
                const msg = errBody?.error?.message
                    ?? errBody?.message
                    ?? `HTTP ${response.status}`;
                const code = response.status === 401 || response.status === 403 ? 'AUTH'
                    : response.status === 429 ? 'RATE_LIMIT'
                        : response.status === 400 ? 'INVALID_REQUEST'
                            : response.status >= 500 ? 'SERVER'
                                : `HTTP_${response.status}`;
                metrics.errors.inc({ model, code });
                throw new LlmError(msg, code, { status: response.status });
            }
            if (!response.body) {
                metrics.errors.inc({ model, code: 'EMPTY_RESPONSE' });
                throw new LlmError('empty response body', 'EMPTY_RESPONSE');
            }
            try {
                for await (const chunk of translateAnthropic(parseAnthropicSse(response.body))) {
                    if (firstTokenAt === undefined && chunk.type !== 'finish' && chunk.type !== 'usage') {
                        firstTokenAt = performance.now();
                        metrics.ttft.observe({ model }, (firstTokenAt - startedAt) / 1000);
                    }
                    if (chunk.type === 'usage') {
                        metrics.tokens.inc({ model, kind: 'input' }, chunk.usage.inputTokens);
                        metrics.tokens.inc({ model, kind: 'output' }, chunk.usage.outputTokens);
                    }
                    yield chunk;
                }
            }
            catch (err) {
                if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
                    metrics.errors.inc({ model, code: 'TIMEOUT' });
                    throw new LlmError(`stream idle ${conn.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: err });
                }
                if (options.signal?.aborted) {
                    throw new LlmError('caller aborted', 'ABORTED', { cause: err });
                }
                if (err instanceof LlmError)
                    throw err;
                metrics.errors.inc({ model, code: 'TRANSPORT' });
                throw new LlmError(`transport error: ${err.message}`, 'TRANSPORT', { cause: err });
            }
            finally {
                controller.abort();
            }
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    }
}
// Re-export ToolCallId so consumers don't need a deep import
export { ToolCallId };
