import { describe, it, expect } from 'vitest'
import { relativeTime, humanizeDuration, formatUsd, shouldStrikethrough } from '@/lib/codex/format'

describe('relativeTime', () => {
  const now = 1_000_000_000_000
  it('formats seconds, minutes, hours and days', () => {
    expect(relativeTime(now - 2_000, now)).toBe('ahora')
    expect(relativeTime(now - 30_000, now)).toBe('hace 30 s')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('hace 5 min')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('hace 3 h')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('hace 2 d')
  })
  it('returns empty for an invalid input', () => {
    expect(relativeTime('not-a-date', now)).toBe('')
  })
})

describe('humanizeDuration', () => {
  it('formats seconds and minutes', () => {
    expect(humanizeDuration(45_000)).toBe('45 s')
    expect(humanizeDuration(90_000)).toBe('1 min 30 s')
    expect(humanizeDuration(120_000)).toBe('2 min')
    expect(humanizeDuration(3_660_000)).toBe('1 h 1 min')
  })
})

describe('formatUsd', () => {
  it('scales decimals by magnitude; 0 → $0', () => {
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(-1)).toBe('$0')
    expect(formatUsd(0.0042)).toBe('$0.0042')
    expect(formatUsd(0.5)).toBe('$0.500')
    expect(formatUsd(2.5)).toBe('$2.50')
  })
})

describe('shouldStrikethrough', () => {
  it('only when the original is meaningfully greater than applied', () => {
    expect(shouldStrikethrough(1, 0.9)).toBe(true)
    expect(shouldStrikethrough(1, 1)).toBe(false)
    expect(shouldStrikethrough(0, 0)).toBe(false)
  })
})
