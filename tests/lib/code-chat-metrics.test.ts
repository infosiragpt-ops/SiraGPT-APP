import { describe, it, expect } from 'vitest'
import { glyphForAction, formatWorked, formatUsd, buildWriteMetrics } from '@/lib/code-chat-metrics'

describe('glyphForAction', () => {
  it('maps each kind to its compact glyph; unknown → terminal', () => {
    expect(glyphForAction('terminal')).toBe('>_')
    expect(glyphForAction('file_read')).toBe('📖')
    expect(glyphForAction('file_write')).toBe('✎')
    expect(glyphForAction('reasoning')).toBe('🧠')
    expect(glyphForAction('whatever')).toBe('>_')
  })
})

describe('formatWorked', () => {
  it('formats seconds and minutes', () => {
    expect(formatWorked(0)).toBe('0 s')
    expect(formatWorked(12_000)).toBe('12 s')
    expect(formatWorked(60_000)).toBe('1 min')
    expect(formatWorked(125_000)).toBe('2 min 5 s')
    expect(formatWorked(-5)).toBe('0 s')
  })
})

describe('formatUsd', () => {
  it('formats real costs and floors zero / tiny values', () => {
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(-1)).toBe('$0')
    expect(formatUsd(0.00005)).toBe('<$0.0001')
    expect(formatUsd(0.0123)).toBe('$0.0123')
    expect(formatUsd(1.2)).toBe('$1.20')
  })
})

describe('buildWriteMetrics', () => {
  it('counts a brand-new file as all-added with one write action', () => {
    const { actions, metrics } = buildWriteMetrics(
      [{ path: 'a.ts', content: 'line1\nline2\nline3' }],
      { startedAt: 1000, now: 6000 },
    )
    expect(metrics).toMatchObject({ timeWorkedMs: 5000, actionsCount: 1, filesChanged: 1, linesAdded: 3, linesRemoved: 0 })
    expect(actions).toEqual([{ kind: 'file_write', label: 'a.ts' }])
  })

  it('diffs against prior content for a real +/- count', () => {
    const prev: Record<string, string> = { 'a.ts': 'keep\nold' }
    const { metrics } = buildWriteMetrics(
      [{ path: 'a.ts', content: 'keep\nnew' }],
      { startedAt: 0, now: 0, getPrevContent: (p) => prev[p] ?? '' },
    )
    // 'old' removed, 'new' added, 'keep' kept.
    expect(metrics.linesAdded).toBe(1)
    expect(metrics.linesRemoved).toBe(1)
  })

  it('records read actions before writes, counts them, and sums read lines', () => {
    const { actions, metrics } = buildWriteMetrics(
      [{ path: 'w.ts', content: 'x' }],
      { startedAt: 0, now: 0, read: [{ path: 'r1.ts', content: 'a\nb' }, { path: 'r2.ts', content: 'c' }] },
    )
    expect(actions.map((a) => a.kind)).toEqual(['file_read', 'file_read', 'file_write'])
    expect(metrics.actionsCount).toBe(3)
    expect(metrics.filesChanged).toBe(1)
    expect(metrics.itemsReadLines).toBe(3) // 2 lines + 1 line
  })
})
