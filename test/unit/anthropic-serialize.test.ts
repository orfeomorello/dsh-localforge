import { describe, it, expect } from 'vitest'
import { serializeAnthropicRequest } from '../../src/streaming/anthropic-serialize.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

describe('serializeAnthropicRequest', () => {
  it('folds system messages into a top-level system field', async () => {
    const opts: GenerateOptions = {
      model: 'm',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'You are helpful.' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    }
    const body = await serializeAnthropicRequest(opts, undefined, 4096)
    expect(body.system).toBe('You are helpful.')
    expect(body.messages.length).toBe(1)
    expect(body.messages[0]?.role).toBe('user')
  })

  it('folds multiple system messages into an array of blocks', async () => {
    const opts: GenerateOptions = {
      model: 'm',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'first' }] },
        { role: 'system', content: [{ type: 'text', text: 'second' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    }
    const body = await serializeAnthropicRequest(opts, undefined, 4096)
    expect(Array.isArray(body.system)).toBe(true)
    if (Array.isArray(body.system)) {
      expect(body.system.length).toBe(2)
    }
  })

  it('uses options.system when provided, ignoring in-message system', async () => {
    const opts: GenerateOptions = {
      model: 'm',
      system: 'from options',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'from message' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    }
    const body = await serializeAnthropicRequest(opts, undefined, 4096)
    expect(body.system).toBe('from options')
  })

  it('serializes tool definitions with input_schema', async () => {
    const opts: GenerateOptions = {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'search', description: 'Search the web', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
    }
    const body = await serializeAnthropicRequest(opts, undefined, 4096)
    expect(body.tools?.length).toBe(1)
    expect(body.tools?.[0]?.name).toBe('search')
    expect(body.tools?.[0]?.input_schema).toEqual({ type: 'object', properties: { q: { type: 'string' } } })
  })

  it('serializes assistant tool-call as tool_use block', async () => {
    const opts: GenerateOptions = {
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'search' }] },
        { role: 'assistant', content: [
          { type: 'tool-call', id: 'call_1', name: 'search', arguments: '{"q":"hello"}' },
        ] },
      ],
    }
    const body = await serializeAnthropicRequest(opts, undefined, 4096)
    const assistant = body.messages[1]
    expect(assistant?.role).toBe('assistant')
    if (assistant?.role === 'assistant') {
      const toolUse = assistant.content.find(b => b.type === 'tool_use')
      expect(toolUse).toBeDefined()
      if (toolUse?.type === 'tool_use') {
        expect(toolUse.id).toBe('call_1')
        expect(toolUse.name).toBe('search')
        expect(toolUse.input).toEqual({ q: 'hello' })
      }
    }
  })

  it('serializes user tool-result as tool_result block', async () => {
    const opts: GenerateOptions = {
      model: 'm',
      messages: [
        { role: 'user', content: [
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'result text' }] },
        ] },
      ],
    }
    const body = await serializeAnthropicRequest(opts, undefined, 4096)
    const user = body.messages[0]
    expect(user?.role).toBe('user')
    if (user?.role === 'user') {
      const tr = user.content.find(b => b.type === 'tool_result')
      expect(tr).toBeDefined()
      if (tr?.type === 'tool_result') {
        expect(tr.tool_use_id).toBe('call_1')
      }
    }
  })

  it('always sets max_tokens (Anthropic requires it)', async () => {
    const opts: GenerateOptions = {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }
    const body = await serializeAnthropicRequest(opts, undefined, 4096)
    expect(body.max_tokens).toBe(4096)
  })

  it('renames stop to stop_sequences', async () => {
    const opts: GenerateOptions = {
      model: 'm',
      stop: 'END',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }
    const body = await serializeAnthropicRequest(opts, undefined, 4096)
    expect(body.stop_sequences).toEqual(['END'])
  })

  it('sets stream: true', async () => {
    const opts: GenerateOptions = {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }
    const body = await serializeAnthropicRequest(opts, undefined, 4096)
    expect(body.stream).toBe(true)
  })
})