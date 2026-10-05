import { describe, it, expect } from 'vitest'
import { translate, mapFinishReason, mapUsage } from '../../src/streaming/translate.ts'

/** Helper to convert an array into an async iterable for `translate`. */
async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

describe('mapFinishReason', () => {
  it('maps stop', () => {
    expect(mapFinishReason('stop')).toEqual({ kind: 'stop' })
  })
  it('maps tool_calls', () => {
    expect(mapFinishReason('tool_calls')).toEqual({ kind: 'tool-calls' })
  })
  it('maps length', () => {
    expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' })
  })
  it('maps unknown to error', () => {
    const r = mapFinishReason('something_weird')
    expect(r.kind).toBe('error')
    if (r.kind === 'error') {
      expect(r.failure.code).toBe('SOMETHING_WEIRD')
    }
  })
})

describe('mapUsage', () => {
  it('subtracts cached_tokens from prompt_tokens', () => {
    const u = mapUsage({
      prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 30 },
      completion_tokens_details: { reasoning_tokens: 20 },
    })
    expect(u.inputTokens).toBe(70)
    expect(u.outputTokens).toBe(50)
    expect(u.cacheReadTokens).toBe(30)
    expect(u.reasoningTokens).toBe(20)
  })
  it('omits cache and reasoning when not reported', () => {
    const u = mapUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
    expect(u.inputTokens).toBe(10)
    expect(u.outputTokens).toBe(5)
    expect(u.cacheReadTokens).toBeUndefined()
    expect(u.reasoningTokens).toBeUndefined()
  })
})

describe('translate', () => {
  it('emits text deltas then finish', async () => {
    const chunks = [
      JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 0, model: 'm',
        choices: [{ index: 0, delta: { content: 'hello ' }, finish_reason: null }] }),
      JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 0, model: 'm',
        choices: [{ index: 0, delta: { content: 'world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
      '[DONE]',
    ]
    const out: string[] = []
    for await (const c of translate(fromArray(chunks))) {
      if (c.type === 'block-start' || c.type === 'block-end') out.push(`block:${c.blockType}`)
      if (c.type === 'text-delta') out.push(`text:${c.text}`)
      if (c.type === 'finish') out.push(`finish:${c.reason.kind}`)
      if (c.type === 'usage') out.push(`usage:${c.usage.inputTokens}`)
    }
    expect(out).toEqual([
      'block:text', 'text:hello ', 'text:world',
      'block:text', 'usage:1', 'finish:stop',
    ])
  })

  it('skips ping-like chunks (no choices)', async () => {
    const chunks = [
      JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [] }),
      JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 0, model: 'm',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
      '[DONE]',
    ]
    const out: string[] = []
    for await (const c of translate(fromArray(chunks))) {
      if (c.type === 'text-delta') out.push(`text:${c.text}`)
    }
    expect(out).toEqual(['text:ok'])
  })

  it('opens a reasoning block lazily on first non-empty delta', async () => {
    const chunks = [
      JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 0, model: 'm',
        choices: [{ index: 0, delta: { reasoning_content: '' }, finish_reason: null }] }),
      JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 0, model: 'm',
        choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }] }),
      JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 0, model: 'm',
        choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] }),
      '[DONE]',
    ]
    let reasoningBlocks = 0
    for await (const c of translate(fromArray(chunks))) {
      if (c.type === 'block-start' && c.blockType === 'reasoning') reasoningBlocks++
    }
    expect(reasoningBlocks).toBe(1)
  })

  it('maps empty completion to EMPTY_RESPONSE', async () => {
    const chunks = [
      JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 0, model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ]
    let finishKind: string | undefined
    for await (const c of translate(fromArray(chunks))) {
      if (c.type === 'finish') finishKind = c.reason.kind
    }
    expect(finishKind).toBe('error')
  })

  it('throws MALFORMED_RESPONSE on bad JSON', async () => {
    const chunks = ['{not-json}', '[DONE]']
    await expect(async () => {
      for await (const _c of translate(fromArray(chunks))) { /* drain */ }
    }).rejects.toThrow(/malformed SSE/i)
  })
})