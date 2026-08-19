import { describe, it, expect } from 'vitest'
import { isNearBottom, DEFAULT_STICK_THRESHOLD_PX } from '@/lib/codex/use-stick-to-bottom'

describe('isNearBottom', () => {
  it('is true at the exact bottom', () => {
    // scrollTop = scrollHeight - clientHeight → distance 0
    expect(isNearBottom(900, 1000, 100)).toBe(true)
  })

  it('is true within the threshold', () => {
    // distance = 1000 - 100 - 850 = 50 ≤ 80
    expect(isNearBottom(850, 1000, 100)).toBe(true)
  })

  it('is false when scrolled up beyond the threshold', () => {
    // distance = 1000 - 100 - 700 = 200 > 80
    expect(isNearBottom(700, 1000, 100)).toBe(false)
  })

  it('honors a custom threshold', () => {
    // distance = 200; with threshold 250 → near
    expect(isNearBottom(700, 1000, 100, 250)).toBe(true)
    expect(isNearBottom(700, 1000, 100, 10)).toBe(false)
  })

  it('default threshold is 80px', () => {
    expect(DEFAULT_STICK_THRESHOLD_PX).toBe(80)
    expect(isNearBottom(1000 - 100 - 80, 1000, 100)).toBe(true)
    expect(isNearBottom(1000 - 100 - 81, 1000, 100)).toBe(false)
  })
})
