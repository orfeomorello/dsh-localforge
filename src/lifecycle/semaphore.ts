/**
 * A counting semaphore with `acquire`/`release` and abort-aware waiting.
 *
 * Used to serialize concurrent stream calls against one model on LM Studio,
 * which is fragile under heavy parallelism on quantized small models.
 * One semaphore per model id, instantiated on first use and held forever
 * (cheap — just two integer fields plus an array of waiters).
 */

export class Semaphore {
  private available: number
  private readonly waiters: Array<{
    resolve: () => void
    reject: (e: unknown) => void
  }> = []

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`Semaphore capacity must be a positive integer, got ${capacity}`)
    }
    this.available = capacity
  }

  /**
   * Acquire one permit. Resolves immediately if a permit is free; otherwise
   * queues and resolves when one becomes available. Honors `signal` by
   * removing the waiter and rejecting with `AbortError` on cancellation.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    if (this.available > 0) {
      this.available--
      return
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject }
      this.waiters.push(waiter)
      if (signal === undefined) return
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new DOMException('aborted', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Release one permit. If a waiter is queued, hand the permit directly to
   * them; otherwise increment the available count. Order is FIFO.
   */
  release(): void {
    const next = this.waiters.shift()
    if (next !== undefined) {
      next.resolve()
      return
    }
    if (this.available < this.capacity) this.available++
  }
}