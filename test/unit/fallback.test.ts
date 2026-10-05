import { describe, it, expect } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { streamWithFallback } from '../../src/lifecycle/fallback.ts'

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

describe('streamWithFallback', () => {
  it('uses the primary when it succeeds', async () => {
    const calls: string[] = []
    const factory = (m: string) => {
      calls.push(m)
      return fromArray([{ type: 'text-delta' as const, index: 0, text: 'hi' }])
    }
    const out: string[] = []
    for await (const c of streamWithFallback(factory, ['a', 'b'])) {
      if (c.type === 'text-delta') out.push(c.text)
    }
    expect(calls).toEqual(['a'])
    expect(out).toEqual(['hi'])
  })

  it('falls back to next on recoverable error', async () => {
    const calls: string[] = []
    const factory = (m: string) => {
      calls.push(m)
      if (m === 'a') {
        return fromArray((async function* () {
          throw new LlmError('transport', 'TRANSPORT')
        })())
      }
      return fromArray([{ type: 'text-delta' as const, index: 0, text: 'b-ok' }])
    }
    const out: string[] = []
    for await (const c of streamWithFallback(factory, ['a', 'b'])) {
      if (c.type === 'text-delta') out.push(c.text)
    }
    expect(calls).toEqual(['a', 'b'])
    expect(out).toEqual(['b-ok'])
  })

  it('throws immediately on non-recoverable error', async () => {
    const factory = () => fromArray((async function* () {
      throw new LlmError('auth', 'AUTH')
    })())
    await expect(async () => {
      for await (const _c of streamWithFallback(factory, ['a', 'b'])) { /* drain */ }
    }).rejects.toThrow(/auth/i)
  })

  it('throws last error when chain is exhausted', async () => {
    const factory = (m: string) => fromArray((async function* () {
      throw new LlmError(`${m} timeout`, 'TIMEOUT')
    })())
    await expect(async () => {
      for await (const _c of streamWithFallback(factory, ['a', 'b'])) { /* drain */ }
    }).rejects.toThrow(/b timeout/)
  })

  it('throws on empty chain', async () => {
    const factory = () => fromArray([])
    await expect(async () => {
      for await (const _c of streamWithFallback(factory, [])) { /* drain */ }
    }).rejects.toThrow(/empty/i)
  })
})