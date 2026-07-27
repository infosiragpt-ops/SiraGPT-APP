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

  it('renders durable file patches and the executive close-out in sequence', () => {
    const s = apply([
      ev('file_patch', { path: 'src/App.tsx', patch: '@@ -1 +1 @@', truncated: false }),
      ev('executive_summary', {
        status: 'passed',
        department: 'CEO Office',
        title: 'Mejorar producto',
        result: 'Trabajo completado.',
        impact: '1 archivo cambiado.',
        risks: [],
        nextActions: ['Continuar.'],
        evidence: ['type_check: ok'],
        audioText: 'Trabajo completado.',
        diffstat: { filesChanged: 1, additions: 2, deletions: 1 },
      }),
    ])
    expect(s.items.map((item) => item.kind)).toEqual(['file_patch', 'executive_summary'])
    expect((s.items[0] as any).path).toBe('src/App.tsx')
    expect((s.items[1] as any).summary.audioText).toBe('Trabajo completado.')
  })

  it('keeps only the latest bounded patch per file', () => {
    const events: CodexEventEnvelope[] = [
      { seq: 100, type: 'file_patch', data: { path: 'src/App.tsx', patch: 'old' } },
      { seq: 101, type: 'file_patch', data: { path: 'src/App.tsx', patch: 'latest' } },
      ...Array.from({ length: 14 }, (_value, index) => ({
        seq: 102 + index,
        type: 'file_patch',
        data: { path: `src/file-${index}.ts`, patch: `patch-${index}` },
      })),
    ]
    const s = reduceEvents(events)
    const patches = s.items.filter((item) => item.kind === 'file_patch') as Array<any>
    expect(patches).toHaveLength(12)
    expect(patches.some((item) => item.patch === 'old')).toBe(false)
    expect(patches.some((item) => item.path === 'src/App.tsx')).toBe(false)
    expect(patches.at(-1)?.path).toBe('src/file-13.ts')
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

  it('covers all catalog event types without throwing', () => {
    const types = ['run_status', 'plan_proposed', 'plan_updated', 'reasoning_start', 'reasoning_delta', 'reasoning_end', 'action_start', 'action_end', 'narrative_delta', 'file_patch', 'checkpoint_created', 'run_summary', 'executive_summary', 'action_required', 'heartbeat']
    let s = initialTimelineState()
    for (const t of types) s = timelineReducer(s, { type: t, seq: seq++, data: { status: 'done', blockId: 'b', actionId: 'a', groupId: 'g', kind: 'terminal', status_: 'done', architecture: 'x', pages: [], components: [], tasks: [], metrics: {}, patternId: 'p', title: 't', rawError: 'e', blockedCapabilities: [], commitSha: 'abc1234', checkpointId: 'c', text: 'x' } })
    expect(s).toBeTruthy()
  })

  it('plan_updated is not a timeline item; it accumulates the latest progress (last write wins)', () => {
    const s = apply([
      ev('plan_proposed', { architecture: 'Vite', pages: [], components: [], tasks: [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }] }),
      ev('plan_updated', { tasks: [{ id: 't1', title: 'A', status: 'in_progress' }, { id: 't2', title: 'B', status: 'pending' }] }),
      ev('plan_updated', { tasks: [{ id: 't1', title: 'A', status: 'completed' }, { id: 't2', title: 'B', status: 'in_progress' }] }),
    ])
    // Only the plan item exists in the timeline; plan_updated is not an item.
    expect(s.items.map((i) => i.kind)).toEqual(['plan'])
    expect(s.planProgress).toEqual([
      { id: 't1', title: 'A', status: 'completed' },
      { id: 't2', title: 'B', status: 'in_progress' },
    ])
  })

  it('planProgress stays null until the first plan_updated (legacy runs degrade)', () => {
    const s = apply([ev('plan_proposed', { architecture: 'x', pages: [], components: [], tasks: [{ id: 't1' }] })])
    expect(s.planProgress).toBeNull()
  })

  it('plan_updated coerces an unknown status to pending', () => {
    const s = apply([ev('plan_updated', { tasks: [{ id: 't1', title: 'A', status: 'weird' }] })])
    expect(s.planProgress).toEqual([{ id: 't1', title: 'A', status: 'pending' }])
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
