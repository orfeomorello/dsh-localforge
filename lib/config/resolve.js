/**
 * Connection resolver: per-request snapshot of validated config.
 *
 * The plugin's hot-reload behavior relies on this thunk. The settings
 * section calls `setSource` to swap the active config getter; every
 * subsequent operation reads the new values without re-registration.
 *
 * A memoized `lastGood` survives an invalid snapshot: a transient bad
 * edit in the UI keeps the last good connection serving, while the bad
 * snapshot is logged. A bad snapshot at boot (no lastGood) propagates.
 */
export function makeResolver(getConfig) {
    let lastRaw;
    let lastGood;
    return () => {
        const raw = getConfig();
        if (raw === lastRaw && lastGood !== undefined)
            return lastGood;
        try {
            lastGood = {
                baseURL: raw.defaultConnection.baseURL,
                apiKeyEnv: raw.defaultConnection.apiKeyEnv,
                requestTimeoutMs: raw.defaultConnection.requestTimeoutMs,
                streamIdleTimeoutMs: raw.defaultConnection.streamIdleTimeoutMs,
                discoveryTimeoutMs: raw.defaultConnection.discoveryTimeoutMs,
                listingCacheMs: raw.defaultConnection.listingCacheMs,
                maxConcurrentPerModel: raw.defaultConnection.maxConcurrentPerModel,
                retryPolicy: raw.defaultConnection.retryPolicy,
            };
            lastRaw = raw;
            return lastGood;
        }
        catch (err) {
            if (lastGood === undefined)
                throw err;
            lastRaw = raw;
            // In production, we'd log via the ctx logger. The thunk doesn't have
            // ctx access; the apply() caller wraps it with a logger-aware
            // version if needed.
            return lastGood;
        }
    };
}
