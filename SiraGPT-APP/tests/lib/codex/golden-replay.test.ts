import { describe, it, expect } from 'vitest'
import { reduceEvents, type CodexEventEnvelope } from '@/lib/codex/timeline-reducer'

// Golden replay (feature 15): a recorded full run touching all 12 event types.
// Running it through the reducer must yield a stable item structure — change a
// shape and this test breaks on purpose, locking the §5 protocol ↔ UI contract.
const GOLDEN: CodexEventEnvelope[] = [
  { seq: 1, type: 'run_status', data: { status: 'running' } },
  { seq: 2, type: 'reasoning_start', data: { blockId: 'b1', label: 'Planeando la arquitectura' } },
  { seq: 3, type: 'reasoning_delta', data: { blockId: 'b1', text: 'Voy a usar Vite + React.' } },
  { seq: 4, type: 'reasoning_end', data: { blockId: 'b1', durationMs: 4200 } },
  { seq: 5, type: 'plan_proposed', data: { architecture: 'Vite + React SPA', pages: ['/'], components: ['Hero', 'Nav'], tasks: [{ id: 't1', title: 'Estructura', status: 'pending' }] } },
  { seq: 6, type: 'run_status', data: { status: 'waiting_approval' } },
  // build run continues on the same timeline for the golden file
  { seq: 7, type: 'run_status', data: { status: 'running' } },
  { seq: 8, type: 'narrative_delta', data: { text: 'Creo el index ' } },
  { seq: 9, type: 'narrative_delta', data: { text: 'y reviso el repo.' } },
  { seq: 10, type: 'action_start', data: { actionId: 'a1', kind: 'file_write', groupId: 'g1', path: 'index.html' } },
  { seq: 11, type: 'action_start', data: { actionId: 'a2', kind: 'terminal', groupId: 'g1', command: 'git status' } },
  { seq: 12, type: 'action_end', data: { actionId: 'a1', status: 'done', outputSummary: 'escrito index.html (24 bytes)', durationMs: 12 } },
  { seq: 13, type: 'action_end', data: { actionId: 'a2', status: 'done', outputSummary: 'clean', durationMs: 30 } },
  { seq: 14, type: 'heartbeat', data: {} },
  { seq: 15, type: 'checkpoint_created', data: { checkpointId: 'cp1', commitSha: 'abc1234', title: 'feat: landing inicial', createdAt: '2026-06-13T12:00:00.000Z' } },
  { seq: 16, type: 'run_summary', data: { metrics: { timeWorkedMs: 65000, actionsCount: 2, itemsReadLines: 0, additions: 1, deletions: 0, tokensIn: 100, tokensOut: 40, costUsd: 0, costSource: 'provider_exact', costOriginalUsd: 0, costAppliedUsd: 0 } } },
  { seq: 17, type: 'run_status', data: { status: 'done' } },
]

describe('golden replay', () => {
  it('reduces to the expected item structure (the §5 protocol contract)', () => {
    const s = reduceEvents(GOLDEN)
    expect(s.status).toBe('done')
    expect(s.lastSeq).toBe(17)
    // Item kinds in order: reasoning, plan, narrative, action_group, checkpoint, summary.
    expect(s.items.map((i) => i.kind)).toEqual(['reasoning', 'plan', 'narrative', 'action_group', 'checkpoint', 'summary'])

    const reasoning = s.items[0] as any
    expect(reasoning).toMatchObject({ label: 'Planeando la arquitectura', durationMs: 4200, done: true })

    const plan = s.items[1] as any
    expect(plan.components).toEqual(['Hero', 'Nav'])
    expect(plan.approved).toBe(false)

    const narrative = s.items[2] as any
    expect(narrative.text).toBe('Creo el index y reviso el repo.') // concatenated

    const group = s.items[3] as any
    expect(group.actions).toHaveLength(2)
    expect(group.actions.every((a: any) => a.status === 'done')).toBe(true)

    const checkpoint = s.items[4] as any
    expect(checkpoint.commitSha).toBe('abc1234')

    const summary = s.items[5] as any
    expect(summary.metrics.costSource).toBe('provider_exact')
  })

  it('is idempotent — replaying twice yields byte-identical items (reload safety)', () => {
    const a = reduceEvents(GOLDEN)
    const b = reduceEvents(GOLDEN)
    expect(JSON.stringify(a.items)).toEqual(JSON.stringify(b.items))
  })

  it('an aggressive reconnection (every event replayed twice, out of order overlap) loses nothing and duplicates nothing', () => {
    // Simulate a drop+replay: feed each event, then re-feed the prior 3 (overlap).
    const stream: CodexEventEnvelope[] = []
    for (let i = 0; i < GOLDEN.length; i++) {
      stream.push(GOLDEN[i])
      for (let j = Math.max(0, i - 2); j <= i; j++) stream.push(GOLDEN[j]) // replay overlap
    }
    const s = reduceEvents(stream)
    const clean = reduceEvents(GOLDEN)
    expect(JSON.stringify(s.items)).toEqual(JSON.stringify(clean.items))
  })
})
