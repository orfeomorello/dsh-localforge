import { describe, it, expect } from 'vitest'
import { applyReasoningBudget, supportsReasoningEffort } from '../../src/lifecycle/reasoning.ts'
import type { WireRequest } from '../../src/types/wire.ts'

const base: WireRequest = {
  model: 'qwen/qwen3-8b',
  messages: [],
  stream: true,
  stream_options: { include_usage: true },
}

describe('supportsReasoningEffort', () => {
  it('matches qwen3', () => {
    expect(supportsReasoningEffort('qwen/qwen3-8b')).toBe(true)
  })
  it('matches gpt-oss', () => {
    expect(supportsReasoningEffort('openai/gpt-oss-20b')).toBe(true)
  })
  it('does not match llama', () => {
    expect(supportsReasoningEffort('meta/llama-3.1-8b')).toBe(false)
  })
})

describe('applyReasoningBudget', () => {
  it('sets reasoning_effort for effort-aware models', () => {
    const out = applyReasoningBudget(base, 4096)
    expect(out.reasoning_effort).toBe('medium')
  })
  it('maps low budget to low effort', () => {
    expect(applyReasoningBudget(base, 1000).reasoning_effort).toBe('low')
  })
  it('maps high budget to high effort', () => {
    expect(applyReasoningBudget(base, 16_000).reasoning_effort).toBe('high')
  })
  it('appends a system reminder for non-effort-aware models', () => {
    const req: WireRequest = { ...base, model: 'meta/llama-3.1-8b' }
    const out = applyReasoningBudget(req, 2048)
    expect(out.reasoning_effort).toBeUndefined()
    expect(out.messages.length).toBe(1)
    const sys = out.messages[0]
    expect(sys?.role).toBe('system')
    if (sys?.role === 'system') {
      expect(sys.content).toContain('2048')
    }
  })
  it('ignores zero or negative budgets', () => {
    expect(applyReasoningBudget(base, 0)).toBe(base)
    expect(applyReasoningBudget(base, -10)).toBe(base)
  })
  it('ignores undefined budget', () => {
    expect(applyReasoningBudget(base, undefined)).toBe(base)
  })
})