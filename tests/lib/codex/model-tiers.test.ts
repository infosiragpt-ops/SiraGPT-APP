import { describe, it, expect } from 'vitest'
import { TIERS, TIER_ORDER, DEFAULT_TIER, isTier, resolveTier, costLabel } from '@/lib/codex/model-tiers'

describe('model-tiers', () => {
  it('exposes three tiers in order with Eco as default + free', () => {
    expect(TIER_ORDER).toEqual(['eco', 'standard', 'power'])
    expect(DEFAULT_TIER).toBe('eco')
    expect(TIERS.eco.free).toBe(true)
    expect(TIERS.eco.cost).toBe('free')
    expect(TIERS.power.cost).toBe('$$$')
  })

  it('isTier validates known ids', () => {
    expect(isTier('eco')).toBe(true)
    expect(isTier('power')).toBe(true)
    expect(isTier('turbo')).toBe(false)
    expect(isTier(undefined)).toBe(false)
  })

  it('resolveTier falls back to Eco for an unknown value', () => {
    expect(resolveTier('standard').id).toBe('standard')
    expect(resolveTier('nope').id).toBe('eco')
    expect(resolveTier(undefined).id).toBe('eco')
  })

  it('costLabel returns the relative cost', () => {
    expect(costLabel('eco')).toBe('free')
    expect(costLabel('standard')).toBe('$')
    expect(costLabel('power')).toBe('$$$')
  })
})
