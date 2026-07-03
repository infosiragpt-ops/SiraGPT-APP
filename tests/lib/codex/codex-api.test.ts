import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { codexApi } from '@/lib/codex/codex-api'

// Capture the last fetch call so we can assert URL + body shape.
let lastCall: { url: string; init: RequestInit } | null = null

function mockFetchOnce(responseBody: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    lastCall = { url: String(url), init }
    return {
      ok,
      status,
      json: async () => responseBody,
    } as unknown as Response
  })
  ;(globalThis as any).fetch = fetchMock
  return fetchMock
}

beforeEach(() => {
  lastCall = null
  // jsdom provides localStorage; seed the auth token the client reads.
  window.localStorage.setItem('auth-token', 'jwt-abc')
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('codexApi.replanFromFeedback (G4)', () => {
  it('POSTs a plan run with priorPlanRunId + feedback and returns the run', async () => {
    mockFetchOnce({ run: { id: 'run-2', projectId: 'p1', mode: 'plan', status: 'queued' } })
    const run = await codexApi.replanFromFeedback('p1', 'plan-prev', 'agrega un carrito', { tier: 'eco' })
    expect(run.id).toBe('run-2')
    expect(lastCall?.url).toMatch(/\/projects\/p1\/runs$/)
    expect(lastCall?.init.method).toBe('POST')
    const body = JSON.parse(String(lastCall?.init.body))
    expect(body).toMatchObject({ mode: 'plan', priorPlanRunId: 'plan-prev', feedback: 'agrega un carrito', tier: 'eco' })
  })

  it('works without opts (tier/model undefined — degrades to backend defaults)', async () => {
    mockFetchOnce({ run: { id: 'run-3', projectId: 'p1', mode: 'plan', status: 'queued' } })
    await codexApi.replanFromFeedback('p1', 'plan-prev', 'ajusta esto')
    const body = JSON.parse(String(lastCall?.init.body))
    expect(body.mode).toBe('plan')
    expect(body.priorPlanRunId).toBe('plan-prev')
    expect(body.feedback).toBe('ajusta esto')
    expect(body.tier).toBeUndefined()
    expect(body.model).toBeUndefined()
  })

  it('surfaces a backend error status', async () => {
    mockFetchOnce({ error: 'invalid_prior_plan_run' }, false, 400)
    await expect(codexApi.replanFromFeedback('p1', 'foreign', 'x')).rejects.toMatchObject({ status: 400 })
  })
})

describe('codexApi.createRun accepts the G4 fields', () => {
  it('forwards priorPlanRunId + feedback through createRun', async () => {
    mockFetchOnce({ run: { id: 'run-4', projectId: 'p1', mode: 'plan', status: 'queued' } })
    await codexApi.createRun('p1', { mode: 'plan', priorPlanRunId: 'plan-prev', feedback: 'algo' })
    const body = JSON.parse(String(lastCall?.init.body))
    expect(body).toMatchObject({ mode: 'plan', priorPlanRunId: 'plan-prev', feedback: 'algo' })
  })
})
