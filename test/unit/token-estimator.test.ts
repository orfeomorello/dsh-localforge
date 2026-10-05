import { describe, it, expect } from 'vitest'
import { estimateInputTokens, fitsContext } from '../../src/lifecycle/token-estimator.ts'
import { counterFor, createTokenizer } from '../../src/lifecycle/tokenizer.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const counter = counterFor('cl100k_base')

const req = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({
  model: 'm',
  messages: [],
  ...overrides,
})

describe('estimateInputTokens (real tokenizer)', () => {
  it('returns 0 for empty request', () => {
    expect(estimateInputTokens(req(), counter)).toBe(0)
  })
  it('counts system prompt via the real tokenizer', () => {
    const n = estimateInputTokens(req({ system: 'hello world' }), counter)
    // gpt-tokenizer counts 2 tokens for 'hello world'
    expect(n).toBe(2)
  })
  it('counts text in user messages', () => {
    const n = estimateInputTokens(req({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(100) }] }],
    }), counter)
    expect(n).toBeGreaterThan(10)
  })
  it('counts images at fixed cost (765 tokens)', () => {
    const n = estimateInputTokens(req({
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { id: 'i' } as never }] }],
    }), counter)
    expect(n).toBe(765)
  })
  it('counts tool definitions via the real tokenizer', () => {
    const n = estimateInputTokens(req({
      tools: [{
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      }],
    }), counter)
    expect(n).toBeGreaterThan(10)
  })
  it('counts reasoning blocks', () => {
    const n = estimateInputTokens(req({
      messages: [{ role: 'user', content: [{ type: 'reasoning', text: 'thinking...' }] }],
    }), counter)
    expect(n).toBeGreaterThan(0)
  })
})

describe('fitsContext', () => {
  it('reports fits when under window', () => {
    const r = fitsContext(req(), counter, 1000, 100)
    expect(r.fits).toBe(true)
  })
  it('reports overflow when over window', () => {
    const bigReq = req({
      system: 'a'.repeat(10_000),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'b'.repeat(10_000) }] }],
    })
    const r = fitsContext(bigReq, counter, 1000, 100)
    expect(r.fits).toBe(false)
    if (!r.fits) {
      expect(r.inputTokens).toBeGreaterThan(0)
      expect(r.wouldNeed).toBeGreaterThan(1000)
    }
  })
})

describe('createTokenizer', () => {
  it('picks o200k_base for gpt-4o', () => {
    const t = createTokenizer('openai/gpt-4o')
    expect(t.encoding).toBe('o200k_base')
  })
  it('picks o200k_base for o1', () => {
    const t = createTokenizer('o1-mini')
    expect(t.encoding).toBe('o200k_base')
  })
  it('picks cl100k_base for qwen3', () => {
    const t = createTokenizer('qwen/qwen3-8b')
    expect(t.encoding).toBe('cl100k_base')
  })
  it('picks cl100k_base for llama', () => {
    const t = createTokenizer('meta/llama-3.1-8b')
    expect(t.encoding).toBe('cl100k_base')
  })
  it('honors explicit encoding', () => {
    const t = createTokenizer('qwen/qwen3-8b', 'o200k_base')
    expect(t.encoding).toBe('o200k_base')
  })
  it('encodes and decodes round-trip', () => {
    const t = createTokenizer('m')
    const ids = t.encode('hello world')
    expect(ids.length).toBe(2)
    expect(t.decode(ids)).toBe('hello world')
  })
  it('fits() reports within-limit correctly', () => {
    const t = createTokenizer('m')
    expect(t.fits('hello world', 2)).toBe(true)
    expect(t.fits('hello world', 1)).toBe(false)
  })
})