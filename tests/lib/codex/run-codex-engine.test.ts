import { describe, it, expect } from 'vitest'
import type { CodexEventEnvelope } from '@/lib/codex/timeline-reducer'
import {
  foldCodexEvent,
  codexLiveContent,
  codexLiveActionsMarkdown,
  initialCodexEngineFold,
  isCodexTerminalStatus,
  sanitizeCodexNarrative,
  type CodexEngineFoldState,
} from '@/lib/code-agent/codex-engine-mapping'

// Unit tests for the pure event→turn/phase mapping that runCodexEngine folds
// onto the /code chat turn, plus the post-terminal file-pull driven off the
// collected file_write paths. No network: a scripted event stream + a fake
// codex-api stand in for the real run.

function reduceFold(events: CodexEventEnvelope[]): CodexEngineFoldState {
  return events.reduce(foldCodexEvent, initialCodexEngineFold())
}

// A representative plan→build run: reasoning while planning, narrative while
// building, two file writes, one command, then a run_summary + terminal done.
const BUILD_EVENTS: CodexEventEnvelope[] = [
  { seq: 1, type: 'run_status', data: { status: 'running' } },
  { seq: 2, type: 'reasoning_start', data: { blockId: 'b1', label: 'Planeando' } },
  { seq: 3, type: 'reasoning_delta', data: { blockId: 'b1', text: 'Uso Vite.' } },
  { seq: 4, type: 'reasoning_end', data: { blockId: 'b1', durationMs: 1200 } },
  { seq: 5, type: 'narrative_delta', data: { text: 'Creo la estructura ' } },
  { seq: 6, type: 'narrative_delta', data: { text: 'del proyecto.' } },
  { seq: 7, type: 'action_start', data: { actionId: 'a1', kind: 'file_write', groupId: 'g1', path: 'index.html' } },
  { seq: 8, type: 'action_end', data: { actionId: 'a1', status: 'done', durationMs: 5 } },
  { seq: 9, type: 'action_start', data: { actionId: 'a2', kind: 'file_write', groupId: 'g1', path: 'src/App.tsx' } },
  { seq: 10, type: 'action_end', data: { actionId: 'a2', status: 'done', durationMs: 5 } },
  { seq: 11, type: 'action_start', data: { actionId: 'a3', kind: 'terminal', groupId: 'g1', command: 'npm run build' } },
  { seq: 12, type: 'action_end', data: { actionId: 'a3', status: 'done', durationMs: 40 } },
  { seq: 13, type: 'heartbeat', data: {} },
  { seq: 14, type: 'run_summary', data: { metrics: { timeWorkedMs: 42000, actionsCount: 3, additions: 12, deletions: 0 } } },
  { seq: 15, type: 'run_status', data: { status: 'done' } },
]

describe('codex-engine-mapping — foldCodexEvent', () => {
  it('accumulates narrative + reasoning and folds it into the live content', () => {
    const s = reduceFold(BUILD_EVENTS)
    expect(s.narrative).toBe('Creo la estructura del proyecto.')
    expect(s.reasoning.b1).toBe('Uso Vite.')
    // narrative wins over reasoning for the live turn content
    expect(codexLiveContent(s)).toBe('Creo la estructura del proyecto.')
  })

  it('collects file_write paths (bounded post-terminal file pull) and read paths', () => {
    const s = reduceFold(BUILD_EVENTS)
    expect(s.writtenPaths).toEqual(['index.html', 'src/App.tsx'])
    expect(s.readPaths).toEqual([])
    expect(s.commandCount).toBe(1)
  })

  it('records file_read paths separately', () => {
    const s = reduceFold([
      { seq: 1, type: 'run_status', data: { status: 'running' } },
      { seq: 2, type: 'action_start', data: { actionId: 'r1', kind: 'file_read', groupId: 'g1', path: 'package.json' } },
      { seq: 3, type: 'action_start', data: { actionId: 'w1', kind: 'file_write', groupId: 'g1', path: 'src/App.tsx' } },
    ])
    expect(s.readPaths).toEqual(['package.json'])
    expect(s.writtenPaths).toEqual(['src/App.tsx'])
  })

  it('advances the coarse phase: plan → generate → apply → verify', () => {
    expect(initialCodexEngineFold().phase).toBe('plan')
    // a reasoning start moves plan → context
    const afterReason = reduceFold(BUILD_EVENTS.slice(0, 2))
    expect(afterReason.phase).toBe('context')
    // narrative moves to generate
    const afterNarr = reduceFold(BUILD_EVENTS.slice(0, 5))
    expect(afterNarr.phase).toBe('generate')
    // a file_write moves to apply
    const afterWrite = reduceFold(BUILD_EVENTS.slice(0, 7))
    expect(afterWrite.phase).toBe('apply')
    // run_summary moves to verify
    const full = reduceFold(BUILD_EVENTS)
    expect(full.phase).toBe('verify')
  })

  it('captures the final run_summary metrics', () => {
    const s = reduceFold(BUILD_EVENTS)
    expect(s.summaryMetrics).toMatchObject({ timeWorkedMs: 42000, actionsCount: 3, additions: 12 })
  })

  it('folds the terminal run_status and isCodexTerminalStatus recognises it', () => {
    const s = reduceFold(BUILD_EVENTS)
    expect(s.status).toBe('done')
    expect(isCodexTerminalStatus(s.status)).toBe(true)
    expect(isCodexTerminalStatus('running')).toBe(false)
    expect(isCodexTerminalStatus('error')).toBe(true)
    expect(isCodexTerminalStatus('cancelled')).toBe(true)
    expect(isCodexTerminalStatus(null)).toBe(false)
  })

  it('dedupes already-seen seq (reconnection / replay overlap is a no-op)', () => {
    let s = reduceFold(BUILD_EVENTS.slice(0, 6))
    const before = s.narrative
    // Re-apply an event whose seq was already folded → same reference, no change.
    const replayed = foldCodexEvent(s, BUILD_EVENTS[5])
    expect(replayed).toBe(s)
    expect(replayed.narrative).toBe(before)
  })

  it('ignores heartbeat / rich-card events without mutating state', () => {
    const base = reduceFold(BUILD_EVENTS.slice(0, 6))
    expect(foldCodexEvent(base, { seq: 99, type: 'heartbeat', data: {} })).toBe(base)
    expect(foldCodexEvent(base, { seq: 100, type: 'plan_proposed', data: { architecture: 'x', pages: [], components: [], tasks: [] } })).toBe(base)
    expect(foldCodexEvent(base, { seq: 101, type: 'unknown_future_type', data: {} })).toBe(base)
  })

  it('caps the live content so a runaway trace cannot blow up the turn', () => {
    const big = 'x'.repeat(20000)
    const s = foldCodexEvent(initialCodexEngineFold(), { seq: 1, type: 'narrative_delta', data: { text: big } })
    expect(codexLiveContent(s).length).toBe(12000)
    expect(codexLiveContent(s, 100).length).toBe(100)
  })
})

describe('codex-engine-mapping — post-terminal file pull', () => {
  // Mirror the runCodexEngine post-terminal step: prefer the collected
  // file_write paths, filter noise, read each via the (fake) codex-api, and
  // hand {path,content}[] to applyFilesToWorkspace.
  function fakeCodexApi(tree: Record<string, string>) {
    const calls: string[] = []
    return {
      calls,
      listFiles: async () => Object.keys(tree),
      readFileContent: async (_id: string, path: string) => {
        calls.push(path)
        return { ok: true, path, content: tree[path] ?? '' }
      },
    }
  }

  async function pullWrittenFiles(
    projectId: string,
    fold: CodexEngineFoldState,
    api: ReturnType<typeof fakeCodexApi>,
  ): Promise<Array<{ path: string; content: string }>> {
    let paths = fold.writtenPaths.filter(Boolean)
    if (paths.length === 0) paths = await api.listFiles()
    const sourcePaths = paths
      .filter((p) => !/(^|\/)(node_modules|\.git|dist|build|\.next)\//.test(p))
      .slice(0, 80)
    const pulled = await Promise.all(
      sourcePaths.map(async (path) => {
        const file = await api.readFileContent(projectId, path)
        return file?.content ? { path, content: file.content } : null
      }),
    )
    return pulled.filter((f): f is { path: string; content: string } => Boolean(f))
  }

  it('pulls exactly the file_write paths seen in the stream', async () => {
    const api = fakeCodexApi({
      'index.html': '<!doctype html>',
      'src/App.tsx': 'export default function App(){return null}',
      'node_modules/react/index.js': 'noise',
    })
    const fold = reduceFold(BUILD_EVENTS)
    const written = await pullWrittenFiles('p1', fold, api)
    expect(written.map((f) => f.path)).toEqual(['index.html', 'src/App.tsx'])
    expect(written[0].content).toBe('<!doctype html>')
    // listFiles is NOT called when we already have write paths.
    expect(api.calls).toEqual(['index.html', 'src/App.tsx'])
  })

  it('falls back to listFiles when no file_write paths were seen, filtering noise', async () => {
    const api = fakeCodexApi({
      'index.html': '<!doctype html>',
      'dist/bundle.js': 'built',
      '.git/config': 'x',
    })
    // A plan-only / no-write fold.
    const fold = reduceFold([{ seq: 1, type: 'run_status', data: { status: 'done' } }])
    const written = await pullWrittenFiles('p1', fold, api)
    expect(written.map((f) => f.path)).toEqual(['index.html'])
  })
})

describe('sanitizeCodexNarrative (protocol-fence leak → prose)', () => {
  it('replaces a fenced finalize block with its answer markdown (the real-run leak)', () => {
    const raw = 'We will edit index.html. ```finalize\n{"answer":"## Resumen del trabajo realizado\\n\\n- `index.html` actualizado"}\n```\nAlcancé el límite de pasos.'
    const out = sanitizeCodexNarrative(raw)
    expect(out).toContain('## Resumen del trabajo realizado')
    expect(out).toContain('`index.html` actualizado')
    expect(out).toContain('Alcancé el límite de pasos.')
    expect(out).not.toContain('```finalize')
    expect(out).not.toContain('{"answer"')
  })

  it('drops tool_call fences entirely (chips already narrate the work)', () => {
    const out = sanitizeCodexNarrative('Escribo el archivo.\n```tool_call\n{"tool":"write_file","path":"a.ts"}\n```\nListo.')
    expect(out).not.toContain('tool_call')
    expect(out).not.toContain('write_file')
    expect(out).toContain('Escribo el archivo.')
    expect(out).toContain('Listo.')
  })

  it('recovers the answer from an unterminated finalize fence (stream cut mid-block)', () => {
    const out = sanitizeCodexNarrative('Cierro.\n```finalize\n{"answer":"Todo aplicado y verificado."}')
    expect(out).toContain('Todo aplicado y verificado.')
    expect(out).not.toContain('finalize')
  })

  it('trims an unterminated fence whose body is not yet parseable', () => {
    const out = sanitizeCodexNarrative('Trabajando…\n```finalize\n{"answer":"a medio esc')
    expect(out.trim()).toBe('Trabajando…')
  })

  it('replaces a bare {"answer": …} JSON tail with its answer', () => {
    const out = sanitizeCodexNarrative('Hecho. {"answer":"### Resumen\\nTodo listo."}')
    expect(out).toContain('### Resumen')
    expect(out).not.toContain('{"answer"')
  })

  it('leaves normal code fences and prose untouched', () => {
    const raw = 'Mira:\n```ts\nconst x = 1\n```\nfin'
    expect(sanitizeCodexNarrative(raw)).toBe(raw)
  })

  it('codexLiveContent applies the sanitizer to the folded narrative', () => {
    const fold = reduceFold([
      { seq: 1, type: 'narrative_delta', data: { text: 'Edito. ```finalize\n{"answer":"Resumen final."}\n```' } },
    ])
    const live = codexLiveContent(fold)
    expect(live).toContain('Resumen final.')
    expect(live).not.toContain('finalize')
  })
})

describe('codexLiveActionsMarkdown (live action feed)', () => {
  it('shows running actions with ⏺ and flips to ✓ on action_end', () => {
    const s1 = reduceFold([
      { seq: 1, type: 'run_status', data: { status: 'running' } },
      { seq: 2, type: 'action_start', data: { actionId: 'a1', kind: 'file_write', groupId: 'g1', path: 'src/App.tsx' } },
    ])
    const live1 = codexLiveActionsMarkdown(s1)
    expect(live1).toContain('⏺ Escribiendo `src/App.tsx`…')

    const s2 = foldCodexEvent(s1, { seq: 3, type: 'action_end', data: { actionId: 'a1', status: 'done', durationMs: 4 } })
    const live2 = codexLiveActionsMarkdown(s2)
    expect(live2).toContain('✓ Escribiendo `src/App.tsx`')
    expect(live2).not.toContain('⏺')
  })

  it('marks failed actions with ✗ and re-renders on action_end (new state ref)', () => {
    const s1 = reduceFold([
      { seq: 1, type: 'action_start', data: { actionId: 'c1', kind: 'terminal', groupId: 'g1', command: 'bun run build' } },
    ])
    const s2 = foldCodexEvent(s1, { seq: 2, type: 'action_end', data: { actionId: 'c1', status: 'error', durationMs: 9 } })
    expect(s2).not.toBe(s1)
    expect(codexLiveActionsMarkdown(s2)).toContain('✗ Ejecutando `bun run build`')
  })

  it('unmatched action_end keeps the same reference (no re-render)', () => {
    const s1 = reduceFold([
      { seq: 1, type: 'action_start', data: { actionId: 'a1', kind: 'file_read', groupId: 'g1', path: 'x.ts' } },
    ])
    const s2 = foldCodexEvent(s1, { seq: 99, type: 'action_end', data: { actionId: 'nope', status: 'done' } })
    expect(s2).toBe(s1)
  })

  it('bounds the feed to the last N with a hidden-count note', () => {
    const events = [] as CodexEventEnvelope[]
    for (let i = 0; i < 12; i++) {
      events.push({ seq: i + 1, type: 'action_start', data: { actionId: `a${i}`, kind: 'file_write', groupId: 'g1', path: `f${i}.ts` } })
    }
    const s = reduceFold(events)
    const md = codexLiveActionsMarkdown(s, 8)
    expect(md).toContain('_+4 acciones previas_')
    expect(md).toContain('f11.ts')
    expect(md).not.toContain('f0.ts')
  })

  it('goes quiet once the run is terminal (Worked Summary takes over)', () => {
    const s = reduceFold([
      { seq: 1, type: 'action_start', data: { actionId: 'a1', kind: 'file_write', groupId: 'g1', path: 'a.ts' } },
      { seq: 2, type: 'run_status', data: { status: 'done' } },
    ])
    expect(codexLiveActionsMarkdown(s)).toBe('')
  })

  it('dedupes replayed action_start by actionId', () => {
    const ev: CodexEventEnvelope = { seq: 1, type: 'action_start', data: { actionId: 'a1', kind: 'file_write', groupId: 'g1', path: 'a.ts' } }
    const s1 = reduceFold([ev])
    // Replay with a NEW seq (reconnect gets fresh seqs on some paths).
    const s2 = foldCodexEvent(s1, { ...ev, seq: 2 })
    expect(s2.liveActions.length).toBe(1)
  })
})
