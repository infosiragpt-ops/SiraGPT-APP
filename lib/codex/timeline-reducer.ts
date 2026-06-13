// codex/timeline-reducer — pure (state, event) → state for the run timeline
// (feature 10). Consumes the typed SSE envelopes from the backend and folds
// them into an ordered list of render items. No React; fully unit-testable.
//
// Dedup by seq makes reconnection safe: an event whose seq was already applied
// is ignored. Items appear in first-seen (seq) order; reasoning blocks and
// action bursts update in place.

export interface CodexEventEnvelope {
  runId?: string
  seq?: number
  ts?: string
  type: string
  data?: any
}

export type ActionStatus = 'running' | 'done' | 'error'
export interface ActionItem {
  actionId: string
  kind: string // terminal | file_read | file_write | reasoning | web
  command?: string
  path?: string
  status: ActionStatus
  outputSummary?: string
  durationMs?: number
  linesRead?: number
}

export type TimelineItem =
  | { kind: 'narrative'; id: string; text: string }
  | { kind: 'reasoning'; id: string; label: string; text: string; durationMs?: number; done: boolean }
  | { kind: 'action_group'; id: string; actions: ActionItem[] }
  | { kind: 'plan'; id: string; architecture: string; pages: any[]; components: any[]; tasks: any[]; approved: boolean }
  | { kind: 'checkpoint'; id: string; checkpointId: string; commitSha: string; title: string; createdAt?: string }
  | { kind: 'summary'; id: string; metrics: any }
  | { kind: 'action_required'; id: string; patternId: string; title: string; rawError: string; blockedCapabilities: string[]; remediationUrl?: string }

export interface TimelineState {
  items: TimelineItem[]
  status: string | null
  lastSeq: number
  seen: Set<number>
}

export function initialTimelineState(): TimelineState {
  return { items: [], status: null, lastSeq: -1, seen: new Set() }
}

let synthCounter = 0
function synthId(prefix: string): string {
  synthCounter += 1
  return `${prefix}_${synthCounter}`
}

function replaceItem(items: TimelineItem[], idx: number, next: TimelineItem): TimelineItem[] {
  const copy = items.slice()
  copy[idx] = next
  return copy
}

export function timelineReducer(state: TimelineState, event: CodexEventEnvelope): TimelineState {
  const seq = typeof event.seq === 'number' ? event.seq : undefined
  // Dedup: ignore an already-applied seq (reconnection / replay overlap).
  if (seq !== undefined && state.seen.has(seq)) return state

  const data = event.data || {}
  let items = state.items
  let status = state.status

  switch (event.type) {
    case 'heartbeat':
      return state // wire-only, never rendered

    case 'run_status':
      status = data.status ?? status
      break

    case 'narrative_delta': {
      const last = items[items.length - 1]
      if (last && last.kind === 'narrative') {
        items = replaceItem(items, items.length - 1, { ...last, text: last.text + (data.text || '') })
      } else {
        items = [...items, { kind: 'narrative', id: synthId('narr'), text: data.text || '' }]
      }
      break
    }

    case 'reasoning_start': {
      const id = data.blockId || synthId('reason')
      if (!items.some((it) => it.kind === 'reasoning' && it.id === id)) {
        items = [...items, { kind: 'reasoning', id, label: data.label || '', text: '', durationMs: undefined, done: false }]
      }
      break
    }
    case 'reasoning_delta': {
      const idx = items.findIndex((it) => it.kind === 'reasoning' && it.id === data.blockId)
      if (idx >= 0) {
        const it = items[idx] as Extract<TimelineItem, { kind: 'reasoning' }>
        items = replaceItem(items, idx, { ...it, text: it.text + (data.text || '') })
      }
      break
    }
    case 'reasoning_end': {
      const idx = items.findIndex((it) => it.kind === 'reasoning' && it.id === data.blockId)
      if (idx >= 0) {
        const it = items[idx] as Extract<TimelineItem, { kind: 'reasoning' }>
        items = replaceItem(items, idx, { ...it, durationMs: data.durationMs, done: true })
      }
      break
    }

    case 'action_start': {
      const groupId = data.groupId || synthId('grp')
      const action: ActionItem = {
        actionId: data.actionId,
        kind: data.kind,
        command: data.command,
        path: data.path,
        status: 'running',
      }
      const idx = items.findIndex((it) => it.kind === 'action_group' && it.id === groupId)
      if (idx >= 0) {
        const grp = items[idx] as Extract<TimelineItem, { kind: 'action_group' }>
        items = replaceItem(items, idx, { ...grp, actions: [...grp.actions, action] })
      } else {
        items = [...items, { kind: 'action_group', id: groupId, actions: [action] }]
      }
      break
    }
    case 'action_end': {
      let done = false
      items = items.map((it) => {
        if (done || it.kind !== 'action_group') return it
        const ai = it.actions.findIndex((a) => a.actionId === data.actionId)
        if (ai < 0) return it
        done = true
        const actions = it.actions.slice()
        actions[ai] = {
          ...actions[ai],
          status: data.status === 'error' ? 'error' : 'done',
          outputSummary: data.outputSummary,
          durationMs: data.durationMs,
          linesRead: data.linesRead,
        }
        return { ...it, actions }
      })
      break
    }

    case 'plan_proposed':
      items = [...items, { kind: 'plan', id: synthId('plan'), architecture: data.architecture, pages: data.pages || [], components: data.components || [], tasks: data.tasks || [], approved: false }]
      break

    case 'checkpoint_created':
      items = [...items, { kind: 'checkpoint', id: data.checkpointId || synthId('cp'), checkpointId: data.checkpointId, commitSha: data.commitSha, title: data.title, createdAt: data.createdAt }]
      break

    case 'run_summary':
      items = [...items, { kind: 'summary', id: synthId('sum'), metrics: data.metrics || {} }]
      break

    case 'action_required':
      items = [...items, { kind: 'action_required', id: synthId('ar'), patternId: data.patternId, title: data.title, rawError: data.rawError, blockedCapabilities: data.blockedCapabilities || [], remediationUrl: data.remediationUrl }]
      break

    default:
      return state // unknown type: ignore, don't break the timeline
  }

  const seen = seq !== undefined ? new Set(state.seen).add(seq) : state.seen
  const lastSeq = seq !== undefined && seq > state.lastSeq ? seq : state.lastSeq
  return { items, status, lastSeq, seen }
}

/** Mark the plan item approved (after the user clicks "Aprobar y construir"). */
export function markPlanApproved(state: TimelineState): TimelineState {
  let changed = false
  const items = state.items.map((it) => {
    if (it.kind === 'plan' && !it.approved) { changed = true; return { ...it, approved: true } }
    return it
  })
  return changed ? { ...state, items } : state
}

/** Reduce a whole event list (replay). */
export function reduceEvents(events: CodexEventEnvelope[], from?: TimelineState): TimelineState {
  return events.reduce(timelineReducer, from || initialTimelineState())
}
