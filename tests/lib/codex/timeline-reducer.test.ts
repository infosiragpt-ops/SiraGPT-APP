import { describe, it, expect } from 'vitest'
import {
  initialTimelineState,
  timelineReducer,
  reduceEvents,
  markPlanApproved,
  type CodexEventEnvelope,
  type TimelineState,
} from '@/lib/codex/timeline-reducer'

function apply(events: CodexEventEnvelope[], from?: TimelineState) {
  return events.reduce(timelineReducer, from || initialTimelineState())
}
let seq = 0
const ev = (type: string, data?: any): CodexEventEnvelope => ({ runId: 'r1', seq: seq++, ts: 't', type, data })

describe('timelineReducer', () => {
  it('run_status updates status and is not an item', () => {
    const s = apply([ev('run_status', { status: 'running' })])
    expect(s.status).toBe('running')
    expect(s.items).toHaveLength(0)
  })

  it('narrative_delta concatenates into one narrative item', () => {
    const s = apply([ev('narrative_delta', { text: 'Hola ' }), ev('narrative_delta', { text: 'mundo' })])
    expect(s.items).toHaveLength(1)
    expect(s.items[0]).toMatchObject({ kind: 'narrative', text: 'Hola mundo' })
  })

  it('a narrative broken by an action opens a new narrative item', () => {
    const s = apply([
      ev('narrative_delta', { text: 'A' }),
      ev('action_start', { actionId: 'a1', kind: 'terminal', groupId: 'g1', command: 'ls' }),
      ev('narrative_delta', { text: 'B' }),
    ])
    const narrs = s.items.filter((i) => i.kind === 'narrative')
    expect(narrs).toHaveLength(2)
  })

  it('reasoning_start/delta/end build a block with label, text and duration', () => {
    const s = apply([
      ev('reasoning_start', { blockId: 'b1', label: 'Planeando' }),
      ev('reasoning_delta', { blockId: 'b1', text: 'pensando…' }),
      ev('reasoning_end', { blockId: 'b1', durationMs: 47000 }),
    ])
    expect(s.items[0]).toMatchObject({ kind: 'reasoning', label: 'Planeando', text: 'pensando…', durationMs: 47000, done: true })
  })

  it('action_start/end with the same groupId group into one row with N actions', () => {
    const s = apply([
      ev('action_start', { actionId: 'a1', kind: 'file_write', groupId: 'g1', path: 'a.js' }),
      ev('action_start', { actionId: 'a2', kind: 'terminal', groupId: 'g1', command: 'git status' }),
      ev('action_start', { actionId: 'a3', kind: 'terminal', groupId: 'g1', command: 'bun test' }),
      ev('action_start', { actionId: 'a4', kind: 'file_read', groupId: 'g1', path: 'b.js' }),
      ev('action_end', { actionId: 'a1', status: 'done', outputSummary: 'ok', durationMs: 5 }),
      ev('action_end', { actionId: 'a2', status: 'error', outputSummary: 'fatal', durationMs: 9 }),
    ])
    const groups = s.items.filter((i) => i.kind === 'action_group')
    expect(groups).toHaveLength(1)
    const g = groups[0] as any
    expect(g.actions).toHaveLength(4)
    expect(g.actions[0].status).toBe('done')
    expect(g.actions[1].status).toBe('error')
    expect(g.actions[1].outputSummary).toBe('fatal')
    expect(g.actions[2].status).toBe('running') // not ended yet
  })

  it('a new groupId opens a separate action row', () => {
    const s = apply([
      ev('action_start', { actionId: 'a1', kind: 'terminal', groupId: 'g1' }),
      ev('action_start', { actionId: 'a2', kind: 'terminal', groupId: 'g2' }),
    ])
    expect(s.items.filter((i) => i.kind === 'action_group')).toHaveLength(2)
  })

  it('plan_proposed, checkpoint_created, run_summary, action_required each create their item', () => {
    const s = apply([
      ev('plan_proposed', { architecture: 'Vite', pages: ['/'], components: ['Nav'], tasks: [{ id: 't1' }] }),
      ev('checkpoint_created', { checkpointId: 'cp1', commitSha: 'abc1234', title: 'feat: x', createdAt: '2026-06-13' }),
      ev('run_summary', { metrics: { timeWorkedMs: 1000, actionsCount: 3 } }),
      ev('action_required', { patternId: 'openrouter_402', title: 'Sin créditos', rawError: '402', blockedCapabilities: ['gen'], remediationUrl: 'https://x' }),
    ])
    expect(s.items.map((i) => i.kind)).toEqual(['plan', 'checkpoint', 'summary', 'action_required'])
    expect((s.items[1] as any).commitSha).toBe('abc1234')
    expect((s.items[3] as any).blockedCapabilities).toEqual(['gen'])
  })

  it('heartbeat is ignored (wire-only)', () => {
    const s = apply([ev('heartbeat', {}), ev('narrative_delta', { text: 'x' })])
    expect(s.items).toHaveLength(1)
  })

  it('dedupes by seq — an already-applied event does not change state', () => {
    const e = { runId: 'r1', seq: 5, ts: 't', type: 'narrative_delta', data: { text: 'once' } }
    let s = timelineReducer(initialTimelineState(), e)
    s = timelineReducer(s, e) // duplicate
    s = timelineReducer(s, e) // duplicate
    expect(s.items).toHaveLength(1)
    expect((s.items[0] as any).text).toBe('once')
  })

  it('covers all 12 catalog event types without throwing', () => {
    const types = ['run_status', 'plan_proposed', 'reasoning_start', 'reasoning_delta', 'reasoning_end', 'action_start', 'action_end', 'narrative_delta', 'checkpoint_created', 'run_summary', 'action_required', 'heartbeat']
    let s = initialTimelineState()
    for (const t of types) s = timelineReducer(s, { type: t, seq: seq++, data: { status: 'done', blockId: 'b', actionId: 'a', groupId: 'g', kind: 'terminal', status_: 'done', architecture: 'x', pages: [], components: [], tasks: [], metrics: {}, patternId: 'p', title: 't', rawError: 'e', blockedCapabilities: [], commitSha: 'abc1234', checkpointId: 'c', text: 'x' } })
    expect(s).toBeTruthy()
  })

  it('markPlanApproved flips the plan item', () => {
    let s = apply([ev('plan_proposed', { architecture: 'x', pages: [], components: [], tasks: [] })])
    expect((s.items[0] as any).approved).toBe(false)
    s = markPlanApproved(s)
    expect((s.items[0] as any).approved).toBe(true)
  })

  it('replaying the same event stream reconstructs byte-identical items (idempotent reload)', () => {
    const events: CodexEventEnvelope[] = [
      { seq: 0, type: 'narrative_delta', data: { text: 'a' } },
      { seq: 1, type: 'plan_proposed', data: { architecture: 'x', pages: [], components: [], tasks: [] } },
      { seq: 2, type: 'run_summary', data: { metrics: {} } },
      { seq: 3, type: 'action_required', data: { patternId: 'p', title: 't', rawError: 'e', blockedCapabilities: [] } },
    ]
    const a = reduceEvents(events)
    const b = reduceEvents(events) // a fresh reload of the same DB replay
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id))
    expect(JSON.stringify(a.items)).toEqual(JSON.stringify(b.items))
  })

  it('reduceEvents replays a full list to the same state regardless of duplicates', () => {
    const events = [
      { seq: 0, type: 'run_status', data: { status: 'running' } },
      { seq: 1, type: 'narrative_delta', data: { text: 'a' } },
      { seq: 1, type: 'narrative_delta', data: { text: 'a' } }, // dup seq
      { seq: 2, type: 'run_status', data: { status: 'done' } },
    ]
    const s = reduceEvents(events)
    expect(s.status).toBe('done')
    expect(s.items.filter((i) => i.kind === 'narrative')).toHaveLength(1)
    expect(s.lastSeq).toBe(2)
  })
})
