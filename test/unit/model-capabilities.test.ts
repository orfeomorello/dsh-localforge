import { describe, it, expect } from 'vitest'
import { modelSupportsVision } from '../../src/config/model-capabilities.ts'

describe('modelSupportsVision', () => {
  it('lets the explicit override win over discovery', () => {
    expect(modelSupportsVision({ vision: false }, { vision: true })).toBe(false)
    expect(modelSupportsVision({ vision: true }, { vision: false })).toBe(true)
  })

  it('uses the discovered capability when no override exists', () => {
    expect(modelSupportsVision(undefined, { vision: false })).toBe(false)
    expect(modelSupportsVision(undefined, { vision: true })).toBe(true)
  })

  it('stays permissive when neither source reports a capability', () => {
    expect(modelSupportsVision(undefined, undefined)).toBe(true)
    expect(modelSupportsVision(undefined, {})).toBe(true)
  })
})
