import { describe, it, expect } from 'vitest'
import { applyPreset, SamplingPresets } from '../../src/config/presets.ts'

describe('applyPreset', () => {
  it('returns params unchanged when preset is undefined', () => {
    const params = { temperature: 0.5 }
    expect(applyPreset(params, undefined)).toEqual(params)
  })

  it('applies preset fields when caller left them undefined', () => {
    expect(applyPreset({}, 'code')).toEqual(SamplingPresets.code)
  })

  it('does not override caller-specified fields', () => {
    const params = { temperature: 0.99, top_p: 0.1 }
    const out = applyPreset(params, 'code')
    expect(out.temperature).toBe(0.99)
    expect(out.top_p).toBe(0.1)
  })

  it('all presets are non-empty', () => {
    for (const [name, p] of Object.entries(SamplingPresets)) {
      expect(p, name).toBeDefined()
      expect(p.temperature, `${name}.temperature`).toBeGreaterThanOrEqual(0)
    }
  })
})