/**
 * Periodic health probe against the configured LM Studio baseURL.
 *
 * Emits transitions on `onChange` for downstream observability (logging,
 * metrics, UI status dot). Bounded by a 5s timeout per probe so a hung
 * server can't lock the timer.
 */

export class HealthCheck {
  private timer: ReturnType<typeof setInterval> | undefined
  private healthy = false
  private running = false
  private initialized = false
  private readonly getBaseURL: () => string

  constructor(
    baseURL: string | (() => string),
    private readonly resolveApiKey: () => Promise<string>,
    private readonly intervalMs: number,
    private readonly onChange: (healthy: boolean, error?: string) => void,
  ) {
    this.getBaseURL = typeof baseURL === 'function' ? baseURL : () => baseURL
  }

  start(): void {
    if (this.timer !== undefined) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  isHealthy(): boolean { return this.healthy }

  probeNow(): void {
    void this.tick()
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    const url = this.getBaseURL()
    try {
      const key = await this.resolveApiKey()
      const r = await fetch(`${url.replace(/\/+$/, '')}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5_000),
      })
      const next = r.ok
      if (!this.initialized || next !== this.healthy) {
        this.initialized = true
        this.healthy = next
        const errMsg = next
          ? undefined
          : `LM Studio server at ${url} returned HTTP ${r.status}.`
        try { this.onChange(next, errMsg) } catch { /* swallow observer errors */ }
      }
    } catch {
      if (!this.initialized || this.healthy) {
        this.initialized = true
        this.healthy = false
        const errMsg = `Cannot reach LM Studio server at ${url}. Start the Local Server in LM Studio or run "lms server start".`
        try { this.onChange(false, errMsg) } catch { /* same */ }
      }
    } finally {
      this.running = false
    }
  }
}