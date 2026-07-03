import { describe, it, expect } from 'vitest'
import { createSSEParser, openRunStream } from '@/lib/codex/run-stream'

describe('createSSEParser', () => {
  it('parses complete data frames', () => {
    const p = createSSEParser()
    const out = p.push('data: {"seq":1,"type":"run_status","data":{"status":"running"}}\n\n')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ seq: 1, type: 'run_status' })
  })

  it('buffers partial frames across chunks', () => {
    const p = createSSEParser()
    expect(p.push('data: {"seq":1,')).toHaveLength(0) // incomplete
    const out = p.push('"type":"narrative_delta","data":{"text":"hi"}}\n\n')
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('narrative_delta')
  })

  it('parses multiple frames in one chunk and skips malformed JSON', () => {
    const p = createSSEParser()
    const out = p.push('data: {"seq":1,"type":"a"}\n\ndata: not-json\n\ndata: {"seq":2,"type":"b"}\n\n')
    expect(out.map((e) => e.type)).toEqual(['a', 'b'])
  })

  it('tolerates CRLF line endings', () => {
    const p = createSSEParser()
    const out = p.push('data: {"seq":1,"type":"x"}\r\n\r\n')
    expect(out).toHaveLength(1)
  })
})

function streamResponse(frames: string[]) {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const f of frames) ctrl.enqueue(enc.encode(f))
      ctrl.close()
    },
  })
  return { ok: true, status: 200, body } as unknown as Response
}

describe('openRunStream', () => {
  it('emits events, tracks status, and ends on a terminal run_status', async () => {
    const events: string[] = []
    let finalStatus = ''
    const fetchImpl = (async () => streamResponse([
      'data: {"seq":1,"type":"run_status","data":{"status":"running"}}\n\n',
      'data: {"seq":2,"type":"narrative_delta","data":{"text":"hola"}}\n\n',
      'data: {"seq":3,"type":"run_status","data":{"status":"done"}}\n\n',
    ])) as unknown as typeof fetch

    const handle = openRunStream({
      runId: 'run-1',
      onEvent: (e) => events.push(e.type),
      onStatus: (s) => { finalStatus = s },
      fetchImpl,
      token: 't',
    })
    await handle.done
    expect(events).toContain('narrative_delta')
    expect(finalStatus).toBe('done')
  })

  it('custom terminalStatuses: waiting_approval resolves done (auto-approve engine); default reconnects', async () => {
    // Mirror the REAL server: after the waiting_approval frame the connection
    // STAYS OPEN (the server only closes on its own hard-terminal set) — the
    // client must break out of read() itself, not wait for socket close.
    let calls = 0
    const openBody = () =>
      ({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('data: {"seq":1,"type":"run_status","data":{"status":"waiting_approval"}}\n\n'))
          // never close — heartbeats would keep trickling in production
        },
      }) }) as unknown as Response
    const fetchImpl = (async () => {
      calls += 1
      return openBody()
    }) as unknown as typeof fetch
    let status = ''
    const handle = openRunStream({
      runId: 'plan-1',
      onEvent: () => {},
      onStatus: (s) => { status = s },
      fetchImpl,
      token: 't',
      terminalStatuses: ['done', 'error', 'cancelled', 'waiting_approval'],
    })
    await handle.done
    expect(status).toBe('waiting_approval')
    expect(calls).toBe(1) // resolved on the parked status — no reconnect loop

    // Default behavior unchanged: waiting_approval is NOT terminal → it
    // reconnects (human-gated panel keeps streaming); close() ends it.
    let calls2 = 0
    const fetch2 = (async () => {
      calls2 += 1
      return streamResponse(['data: {"seq":1,"type":"run_status","data":{"status":"waiting_approval"}}\n\n'])
    }) as unknown as typeof fetch
    const h2 = openRunStream({ runId: 'plan-2', onEvent: () => {}, fetchImpl: fetch2, token: 't' })
    await new Promise((r) => setTimeout(r, 600))
    h2.close()
    await h2.done
    expect(calls2).toBeGreaterThan(1)
  })

  it('stops (no reconnect storm) on a permanent client error like 404', async () => {
    let calls = 0
    let errored: unknown = null
    const fetchImpl = (async () => { calls += 1; return { ok: false, status: 404, body: null } as unknown as Response }) as unknown as typeof fetch
    const handle = openRunStream({ runId: 'gone', onEvent: () => {}, onError: (e) => { errored = e }, fetchImpl, token: 't' })
    await handle.done
    expect(calls).toBe(1) // did not reconnect against a dead URL
    expect(errored).toBeInstanceOf(Error)
  })

  it('reconnects on a transient error (503) then succeeds', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls === 1) return { ok: false, status: 503, body: null } as unknown as Response
      return streamResponse(['data: {"seq":1,"type":"run_status","data":{"status":"done"}}\n\n'])
    }) as unknown as typeof fetch
    const events: string[] = []
    const handle = openRunStream({ runId: 'r', onEvent: (e) => events.push(e.type), fetchImpl, token: 't', maxBackoffMs: 1 })
    await handle.done
    expect(calls).toBe(2) // retried the transient failure
    expect(events).toContain('run_status')
  })

  it('passes afterSeq in the URL and the token only in the Authorization header', async () => {
    let calledUrl = ''
    let calledInit: RequestInit | undefined
    const fetchImpl = (async (url: string, init?: RequestInit) => { calledUrl = url; calledInit = init; return streamResponse(['data: {"seq":6,"type":"run_status","data":{"status":"done"}}\n\n']) }) as unknown as typeof fetch
    const handle = openRunStream({ runId: 'run-1', afterSeq: 5, onEvent: () => {}, fetchImpl, token: 'tok' })
    await handle.done
    expect(calledUrl).toContain('afterSeq=5')
    expect(calledUrl).not.toContain('token=tok')
    expect(calledUrl).toContain('/codex/runs/run-1/stream')
    expect((calledInit?.headers as Record<string, string>)?.Authorization).toBe('Bearer tok')
  })
})
