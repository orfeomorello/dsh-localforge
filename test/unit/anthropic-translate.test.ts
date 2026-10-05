import { describe, it, expect } from 'vitest'
import { translateAnthropic } from '../../src/streaming/anthropic-translate.ts'
import type { AnthropicEvent } from '../../src/types/wire.ts'

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

describe('translateAnthropic', () => {
  it('emits text deltas and a finish', async () => {
    const events: AnthropicEvent[] = [
      { type: 'message_start', message: {
        id: 'm1', type: 'message', role: 'assistant', content: [], model: 'm',
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
      } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]
    const chunks: string[] = []
    let finishKind: string | undefined
    let finishCode: string | undefined
    let inputTokens = 0
    let outputTokens = 0
    for await (const c of translateAnthropic(fromArray(events))) {
      if (c.type === 'text-delta') chunks.push(c.text)
      if (c.type === 'finish') {
        finishKind = c.reason.kind
        if (c.reason.kind === 'error') finishCode = c.reason.failure.code
      }
      if (c.type === 'usage') { inputTokens = c.usage.inputTokens; outputTokens = c.usage.outputTokens }
    }
    expect(chunks.join('')).toBe('hello world')
    expect(finishKind).toBe('stop')
    expect(inputTokens).toBe(10)
    expect(outputTokens).toBe(2)
  })

  it('emits thinking as reasoning deltas', async () => {
    const events: AnthropicEvent[] = [
      { type: 'message_start', message: {
        id: 'm1', type: 'message', role: 'assistant', content: [], model: 'm',
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'considering...' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'final' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]
    const text: string[] = []
    const reasoning: string[] = []
    for await (const c of translateAnthropic(fromArray(events))) {
      if (c.type === 'text-delta') text.push(c.text)
      if (c.type === 'reasoning-delta') reasoning.push(c.text)
    }
    expect(reasoning.join('')).toBe('considering...')
    expect(text.join('')).toBe('final')
  })

  it('accumulates tool_use input_json_delta into a tool-call-delta', async () => {
    const events: AnthropicEvent[] = [
      { type: 'message_start', message: {
        id: 'm1', type: 'message', role: 'assistant', content: [], model: 'm',
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'search', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"hello"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    let finishKind: string | undefined
    let lastArgs: string | undefined
    for await (const c of translateAnthropic(fromArray(events))) {
      if (c.type === 'finish') finishKind = c.reason.kind
      if (c.type === 'block-end' && c.block.type === 'tool-call') lastArgs = c.block.arguments
    }
    expect(finishKind).toBe('tool-calls')
    expect(lastArgs).toBe('{"q":"hello"}')
  })

  it('maps max_tokens stop_reason to max-tokens', async () => {
    const events: AnthropicEvent[] = [
      { type: 'message_start', message: {
        id: 'm1', type: 'message', role: 'assistant', content: [], model: 'm',
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    let kind: string | undefined
    for await (const c of translateAnthropic(fromArray(events))) {
      if (c.type === 'finish') kind = c.reason.kind
    }
    expect(kind).toBe('max-tokens')
  })

  it('maps empty completion to EMPTY_RESPONSE', async () => {
    const events: AnthropicEvent[] = [
      { type: 'message_start', message: {
        id: 'm1', type: 'message', role: 'assistant', content: [], model: 'm',
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ]
    let kind: string | undefined
    let code: string | undefined
    for await (const c of translateAnthropic(fromArray(events))) {
      if (c.type === 'finish') {
        kind = c.reason.kind
        if (c.reason.kind === 'error') code = c.reason.failure.code
      }
    }
    expect(kind).toBe('error')
    expect(code).toBe('EMPTY_RESPONSE')
  })
})