/**
 * Periodic health probe against the configured LM Studio baseURL.
 *
 * Emits transitions on `onChange` for downstream observability (logging,
 * metrics, UI status dot). Bounded by a 5s timeout per probe so a hung
 * server can't lock the timer.
 */
export class HealthCheck {
    baseURL;
    resolveApiKey;
    intervalMs;
    onChange;
    timer;
    healthy = false;
    running = false;
    constructor(baseURL, resolveApiKey, intervalMs, onChange) {
        this.baseURL = baseURL;
        this.resolveApiKey = resolveApiKey;
        this.intervalMs = intervalMs;
        this.onChange = onChange;
    }
    start() {
        if (this.timer !== undefined)
            return;
        void this.tick();
        this.timer = setInterval(() => void this.tick(), this.intervalMs);
    }
    stop() {
        if (this.timer === undefined)
            return;
        clearInterval(this.timer);
        this.timer = undefined;
    }
    isHealthy() { return this.healthy; }
    async tick() {
        if (this.running)
            return;
        this.running = true;
        try {
            const key = await this.resolveApiKey();
            const r = await fetch(`${this.baseURL.replace(/\/+$/, '')}/models`, {
                headers: { authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(5_000),
            });
            const next = r.ok;
            if (next !== this.healthy) {
                this.healthy = next;
                try {
                    this.onChange(next);
                }
                catch { /* swallow observer errors */ }
            }
        }
        catch {
            if (this.healthy) {
                this.healthy = false;
                try {
                    this.onChange(false);
                }
                catch { /* same */ }
            }
        }
        finally {
            this.running = false;
        }
    }
}
