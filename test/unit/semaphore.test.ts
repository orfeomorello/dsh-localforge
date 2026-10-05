import { describe, it, expect } from 'vitest'
import { Semaphore } from '../../src/lifecycle/semaphore.ts'

describe('Semaphore', () => {
  it('acquires immediately when available', async () => {
    const sem = new Semaphore(2)
    await sem.acquire()
    await sem.acquire()
    // third should queue
    let resolved = false
    void sem.acquire().then(() => { resolved = true })
    await new Promise(r => setTimeout(r, 10))
    expect(resolved).toBe(false)
  })

  it('releases permit to a queued waiter', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    const p = sem.acquire()
    sem.release()
    await p
    // available should now be 0 (handed to waiter)
    let second = false
    void sem.acquire().then(() => { second = true })
    await new Promise(r => setTimeout(r, 10))
    expect(second).toBe(false)
  })

  it('honors AbortSignal', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    const c = new AbortController()
    const p = sem.acquire(c.signal).catch(e => e)
    c.abort()
    const err = await p
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe('AbortError')
  })

  it('rejects invalid capacity', () => {
    expect(() => new Semaphore(0)).toThrow()
    expect(() => new Semaphore(-1)).toThrow()
    expect(() => new Semaphore(1.5)).toThrow()
  })

  it('never exceeds capacity even with many releases', () => {
    const sem = new Semaphore(2)
    sem.release()
    sem.release()
    sem.release()
    expect((sem as unknown as { available: number }).available).toBeLessThanOrEqual(2)
  })
})