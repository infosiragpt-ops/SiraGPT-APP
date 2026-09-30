import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient as api } from '@/lib/api'
import { clearAuthenticatedFetchCsrfCache } from '@/lib/authenticated-fetch'
import {
  CONTEXT_OVERFLOW_MESSAGE,
  GENERATE_ERROR_COPY,
  GENERATE_FOLLOWER_CONNECT_MS,
  GENERATE_TOTAL_CONNECT_BUDGET_MS,
  RESTARTING_ACTIVITY,
  RESTART_MAX_WAIT_MS,
  TURN_IN_PROGRESS_ACTIVITY,
  TURN_IN_PROGRESS_MAX_WAIT_MS,
} from '@/lib/generate-retry-policy'
import { GENERATE_STREAM_CONNECT_MS } from '@/lib/sse-idle'

vi.mock('@/lib/client-logs', () => ({
  reportClientLog: vi.fn(),
}))

const mockFetch = vi.fn()
globalThis.fetch = mockFetch as unknown as typeof fetch

const streamData = {
  provider: 'test-provider',
  model: 'test-model',
  prompt: 'hola',
  streamId: 'stream-policy',
}

function sseBody(payload: string) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function sseResponse(content: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: sseBody(`data: ${JSON.stringify({ content })}\n\ndata: [DONE]\n\n`),
  }
}

function sseFrames(frames: Array<Record<string, unknown>>) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: sseBody(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`),
  }
}

function jsonError(status: number, payload: Record<string, unknown> | null, headers: Record<string, string> = {}) {
  return new Response(payload ? JSON.stringify(payload) : '', {
    status,
    headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers },
  })
}

const isHealth = (url: unknown) => String(url).includes('/health/')
const generateCalls = () => mockFetch.mock.calls.filter(([url]) => !isHealth(url))
const healthCalls = () => mockFetch.mock.calls.filter(([url]) => isHealth(url))

async function run(options: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  const chunks: string[] = []
  const onClose = vi.fn()
  const onError = vi.fn()
  const promise = api.generateAIStream(
    { ...streamData, ...data } as typeof streamData,
    (chunk) => chunks.push(chunk),
    onClose,
    onError,
    undefined,
    options,
  )
  await vi.runAllTimersAsync()
  await promise
  return { chunks, onClose, onError }
}

describe('generateAIStream retry policy', () => {
  let dispatchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Bearer session: no CSRF preflight in these transport tests.
    api.setToken('bearer-policy')
    clearAuthenticatedFetchCsrfCache()
    dispatchSpy = vi.spyOn(window, 'dispatchEvent')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    api.setToken(null)
  })

  it('delivers only valid workspace metadata for the requested chat without treating it as a token', async () => {
    const onCodingWorkspace = vi.fn()
    mockFetch.mockResolvedValue(sseFrames([
      { type: 'coding_workspace', chatId: 'another-chat', projectId: 'other', projectName: 'Other' },
      { type: 'coding_workspace', chatId: 'code-chat', projectId: '', projectName: 'Invalid' },
      { type: 'coding_workspace', chatId: 'code-chat', projectId: 'project-1', projectName: 'Bicicletas', brief: { internal: true }, workspacePath: '/private/path' },
      { content: 'Proyecto preparado.' },
    ]))
    const result = await run({ onCodingWorkspace }, { chatId: 'code-chat' })
    expect(onCodingWorkspace).toHaveBeenCalledExactlyOnceWith({ chatId: 'code-chat', projectId: 'project-1', projectName: 'Bicicletas' })
    expect(result.chunks.join('')).toBe('Proyecto preparado.')
    expect(result.onError).not.toHaveBeenCalled()
  })

  it('stops a 429 rate limit after 4 retries with Spanish copy and no upgrade prompt', async () => {
    mockFetch.mockImplementation(async () => jsonError(429, {
      error: 'rate_limited',
      code: 'rate_limited',
      retryable: true,
      message: 'Demasiados generate en esta sesión. Espera un momento.',
    }, { 'Retry-After': '2' }))

    const { onClose, onError } = await run()

    expect(generateCalls()).toHaveLength(5)
    expect(onClose).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    const error = onError.mock.calls[0][0]
    expect(error.kind).toBe('rate_limited')
    expect(error.retryable).toBe(true)
    expect(error.status).toBe(429)
    expect(error.message).toBe(GENERATE_ERROR_COPY.rate_limited)
    expect(error.message).not.toMatch(/HTTP|generate|Monthly/i)
    const upgradeEvents = dispatchSpy.mock.calls.filter(([event]) => (event as Event).type === 'open-upgrade-modal')
    expect(upgradeEvents).toHaveLength(0)
  })

  it('does not retry the plan quota (429 quota_exceeded): one fetch, kind quota', async () => {
    mockFetch.mockImplementation(async () => jsonError(429, { error: 'quota_exceeded', reason: 'monthly' }))

    const { onError } = await run()

    expect(generateCalls()).toHaveLength(1)
    expect(onError).toHaveBeenCalledOnce()
    const error = onError.mock.calls[0][0]
    expect(error.kind).toBe('quota')
    expect(error.retryable).toBe(false)
    expect(error.message).toBe(GENERATE_ERROR_COPY.quota)
  })

  it('shows a picked model provider failure verbatim and never retries it', async () => {
    const message = 'DeepSeek V4 Pro no pudo responder: su proveedor no tiene saldo ahora. No cambié de modelo; elige otro en el selector o inténtalo más tarde.'
    mockFetch.mockImplementationOnce(async () => sseFrames([
      { type: 'error', error: message, code: 'E_PROVIDER', message, recovered: false },
    ]))

    const { onError } = await run()

    expect(generateCalls()).toHaveLength(1)
    expect(onError).toHaveBeenCalledOnce()
    const error = onError.mock.calls[0][0]
    expect(error.message).toBe(message)
    expect(error.kind).toBe('provider')
    expect(error.retryable).toBe(false)
  })

  it('waits on turn_in_progress, polls the persisted reply between tries and keeps the transport budget', async () => {
    const tryRecoverPersistedTurn = vi.fn().mockResolvedValue(false)
    const onActivity = vi.fn()
    const inProgress = () => jsonError(409, { error: 'turn_in_progress', code: 'turn_in_progress', retryable: true }, { 'Retry-After': '1' })
    mockFetch
      .mockResolvedValueOnce(inProgress())
      .mockResolvedValueOnce(inProgress())
      .mockResolvedValueOnce(inProgress())
      .mockResolvedValueOnce(jsonError(500, { error: 'provider unavailable 1' }))
      .mockResolvedValueOnce(jsonError(500, { error: 'provider unavailable 2' }))
      .mockResolvedValueOnce(jsonError(500, { error: 'provider unavailable 3' }))
      .mockResolvedValueOnce(jsonError(500, { error: 'provider unavailable 4' }))
      .mockResolvedValueOnce(sseResponse('respuesta final'))

    const { chunks, onClose, onError } = await run({ tryRecoverPersistedTurn, onActivity })

    expect(generateCalls()).toHaveLength(8)
    expect(tryRecoverPersistedTurn).toHaveBeenCalledTimes(3)
    expect(onActivity.mock.calls.filter(([text]) => text === TURN_IN_PROGRESS_ACTIVITY)).toHaveLength(1)
    expect(chunks).toEqual(['respuesta final'])
    expect(onClose).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })

  it('closes with the persisted reply found while the turn was still in progress', async () => {
    const tryRecoverPersistedTurn = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    mockFetch.mockImplementation(async () => jsonError(409, { error: 'turn_in_progress', code: 'turn_in_progress', retryable: true }))

    const { onClose, onError } = await run({ tryRecoverPersistedTurn })

    expect(generateCalls()).toHaveLength(2)
    expect(onClose).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    // One chat read per wait, never a burst of reads.
    for (const call of tryRecoverPersistedTurn.mock.calls) expect(call[0]).toEqual({ attempts: 1 })
  })

  it('delivers an exhausted 10-min turn_in_progress wait as non-retryable (never started again)', async () => {
    const tryRecoverPersistedTurn = vi.fn().mockResolvedValue(false)
    mockFetch.mockImplementation(async () => jsonError(409, { error: 'turn_in_progress', code: 'turn_in_progress', retryable: true }))

    const startedAt = Date.now()
    const { onClose, onError } = await run({ tryRecoverPersistedTurn })

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(TURN_IN_PROGRESS_MAX_WAIT_MS)
    expect(onClose).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    const error = onError.mock.calls[0][0]
    expect(error.kind).toBe('turn_in_progress')
    expect(error.retryable).toBe(false)
    expect(error.message).toBe(GENERATE_ERROR_COPY.turn_in_progress)
    // Each try reads the chat once (not four back-to-back reads).
    expect(tryRecoverPersistedTurn.mock.calls.length).toBe(generateCalls().length - 1)
    for (const call of tryRecoverPersistedTurn.mock.calls) expect(call[0]).toEqual({ attempts: 1 })
  })

  it('classifies an SSE error frame with its own status: 402 quota_exhausted is the plan quota', async () => {
    mockFetch.mockResolvedValueOnce(sseFrames([{ type: 'error', code: 'quota_exhausted', status: 402, remainingQuota: 0 }]))

    const { onError } = await run()

    expect(generateCalls()).toHaveLength(1)
    const error = onError.mock.calls[0][0]
    expect(error.kind).toBe('quota')
    expect(error.retryable).toBe(false)
    expect(error.status).toBe(402)
    expect(error.message).toBe(GENERATE_ERROR_COPY.quota)
  })

  it('explains a 413 context_overflow frame instead of blaming the model', async () => {
    mockFetch.mockResolvedValueOnce(sseFrames([{ type: 'error', code: 'context_overflow', status: 413, suggestedModel: 'some-raw-model-id' }]))

    const { onError } = await run()

    expect(generateCalls()).toHaveLength(1)
    const error = onError.mock.calls[0][0]
    expect(error.kind).toBe('invalid')
    expect(error.retryable).toBe(false)
    expect(error.message).toBe(CONTEXT_OVERFLOW_MESSAGE)
    expect(error.message).not.toContain('some-raw-model-id')
  })

  it('re-POSTs after a retryable SSE error frame that arrives before any content', async () => {
    mockFetch
      .mockResolvedValueOnce(sseFrames([{
        type: 'error',
        code: 'sandbox_at_capacity',
        retryable: true,
        retryAfterSeconds: 1,
        message: 'Los entornos de ejecución están ocupados. Reintento en unos segundos.',
      }]))
      .mockResolvedValueOnce(sseResponse('ya hay entorno'))

    const { chunks, onClose, onError } = await run()

    expect(generateCalls()).toHaveLength(2)
    expect(chunks).toEqual(['ya hay entorno'])
    expect(onClose).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    const secondHeaders = new Headers(generateCalls()[1][1].headers)
    expect(secondHeaders.has('Last-Event-ID')).toBe(false)
  })

  it('treats a retryable SSE error frame after content as terminal', async () => {
    mockFetch.mockResolvedValueOnce(sseFrames([
      { content: 'parte de la respuesta' },
      { type: 'error', code: 'sandbox_at_capacity', retryable: true, message: 'Los entornos de ejecución están ocupados.' },
    ]))

    const { chunks, onClose, onError } = await run()

    expect(generateCalls()).toHaveLength(1)
    expect(chunks).toEqual(['parte de la respuesta'])
    expect(onClose).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    const error = onError.mock.calls[0][0]
    expect(error.kind).toBe('rate_limited')
    // Terminal for the caller too: a durable replay would wipe the partial
    // answer the user is reading.
    expect(error.contentDelivered).toBe(true)
    expect(error.retryable).toBe(false)
  })

  it('waits out a restart (502 with an empty body) on HEAD /api/health/ready without spending attempts', async () => {
    // Down for the first probe of each wait, then up.
    let healthDownCalls = 0
    const generateResponses = [
      () => jsonError(502, null),
      () => jsonError(502, null),
      () => jsonError(500, { error: 'provider unavailable 1' }),
      () => jsonError(500, { error: 'provider unavailable 2' }),
      () => jsonError(500, { error: 'provider unavailable 3' }),
      () => jsonError(500, { error: 'provider unavailable 4' }),
      () => sseResponse('de vuelta'),
    ]
    mockFetch.mockImplementation(async (url: unknown) => {
      if (isHealth(url)) {
        if (healthDownCalls > 0) {
          healthDownCalls -= 1
          return jsonError(502, null)
        }
        return new Response('{"status":"ok"}', { status: 200 })
      }
      const next = generateResponses.shift()
      if (!next) throw new Error('unexpected generate call')
      const response = next()
      if (response.status === 502) healthDownCalls = 1
      return response
    })
    const onActivity = vi.fn()

    const { chunks, onClose, onError } = await run({ onActivity })

    expect(generateCalls()).toHaveLength(7)
    // Per wait: one failed probe and one good probe.
    expect(healthCalls()).toHaveLength(4)
    for (const [url, init] of healthCalls()) {
      expect(String(url)).toMatch(/\/health\/ready$/)
      expect((init as RequestInit).method).toBe('HEAD')
    }
    expect(onActivity.mock.calls.filter(([text]) => text === RESTARTING_ACTIVITY)).toHaveLength(1)
    expect(chunks).toEqual(['de vuelta'])
    expect(onClose).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })

  it('never shows «HTTP 502» when a restart outlasts the budgets', async () => {
    mockFetch.mockImplementation(async (url: unknown) => (
      isHealth(url) ? jsonError(502, null) : jsonError(502, null)
    ))

    const { onError } = await run()

    expect(onError).toHaveBeenCalledOnce()
    const error = onError.mock.calls[0][0]
    expect(error.message).not.toMatch(/HTTP\s*\d{3}/)
    expect(error.message).toMatch(/actualiz/i)
    // Nothing retries any more: the terminal line must not say it does.
    expect(error.message).not.toMatch(/Reintentando/i)
    expect(error.message).toBe(GENERATE_ERROR_COPY.restarting)
    expect(error.kind).toBe('restarting')
  })

  it('waits out an explicit server_restarting drain without spending attempts, even while health stays up', async () => {
    // During a graceful drain the old process still answers health: the
    // explicit code alone keeps the wait free, within the restart budget.
    const drains = 6 // more than the 5 transport attempts
    let served = 0
    mockFetch.mockImplementation(async (url: unknown) => {
      if (isHealth(url)) return new Response(null, { status: 204 })
      served += 1
      if (served <= drains) {
        return jsonError(503, { error: 'server_restarting', code: 'server_restarting', retryable: true }, { 'Retry-After': '5' })
      }
      return sseResponse('servidor nuevo')
    })
    const onActivity = vi.fn()

    const startedAt = Date.now()
    const { chunks, onClose, onError } = await run({ onActivity })

    expect(generateCalls()).toHaveLength(drains + 1)
    expect(chunks).toEqual(['servidor nuevo'])
    expect(onClose).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(onActivity.mock.calls.filter(([text]) => text === RESTARTING_ACTIVITY)).toHaveLength(1)
    // Never sooner than Retry-After, backing off, and within the 120 s budget.
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(drains * 5_000)
    expect(elapsed).toBeLessThanOrEqual(RESTART_MAX_WAIT_MS + 20_000)
  })

  it('stops waiting for an explicit drain after the restart budget, then uses the transport budget', async () => {
    mockFetch.mockImplementation(async (url: unknown) => {
      if (isHealth(url)) return new Response(null, { status: 204 })
      return jsonError(503, { error: 'server_restarting', code: 'server_restarting', retryable: true }, { 'Retry-After': '5' })
    })

    const { onClose, onError } = await run()

    expect(onClose).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    const error = onError.mock.calls[0][0]
    expect(error.kind).toBe('restarting')
    expect(error.message).toBe(GENERATE_ERROR_COPY.restarting)
    // Bounded: the free drain retries plus at most the transport budget.
    expect(generateCalls().length).toBeLessThanOrEqual(30)
  })

  it('uses the follower connect timeout right after a connect timeout and enforces the total budget', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const startedAt: number[] = []
    mockFetch.mockImplementation((_url: unknown, init: RequestInit) => {
      startedAt.push(Date.now())
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })

    const { onClose, onError } = await run()

    // 20 s, then 65 s (follower), then what is left of the 150 s budget.
    expect(startedAt).toHaveLength(3)
    const connectMs = [
      startedAt[1] - startedAt[0],
      startedAt[2] - startedAt[1],
    ]
    expect(connectMs[0]).toBeGreaterThanOrEqual(GENERATE_STREAM_CONNECT_MS)
    expect(connectMs[0]).toBeLessThan(GENERATE_STREAM_CONNECT_MS + 1_000)
    expect(connectMs[1]).toBeGreaterThanOrEqual(GENERATE_FOLLOWER_CONNECT_MS)
    expect(connectMs[1]).toBeLessThan(GENERATE_FOLLOWER_CONNECT_MS + 1_000)
    expect(GENERATE_STREAM_CONNECT_MS + GENERATE_FOLLOWER_CONNECT_MS * 2).toBe(GENERATE_TOTAL_CONNECT_BUDGET_MS)
    expect(onClose).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    const error = onError.mock.calls[0][0]
    expect(error.kind).toBe('transport')
    expect(error.message).not.toMatch(/timeout|HTTP/i)
  })

  it('goes back to the normal connect timeout once an attempt did not time out', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const startedAt: number[] = []
    let call = 0
    mockFetch.mockImplementation((_url: unknown, init: RequestInit) => {
      startedAt.push(Date.now())
      call += 1
      if (call === 2) return Promise.resolve(jsonError(500, { error: 'provider unavailable' }))
      if (call === 4) return Promise.resolve(sseResponse('conectado'))
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })

    const { chunks, onError } = await run()

    expect(startedAt).toHaveLength(4)
    // Attempt 3 follows a 500 (not a connect timeout): plain 20 s timeout.
    const thirdConnectMs = startedAt[3] - startedAt[2]
    expect(thirdConnectMs).toBeGreaterThanOrEqual(GENERATE_STREAM_CONNECT_MS)
    expect(thirdConnectMs).toBeLessThan(GENERATE_STREAM_CONNECT_MS + 5_000)
    expect(chunks).toEqual(['conectado'])
    expect(onError).not.toHaveBeenCalled()
  })

  it('runs one network loop per turn key in a tab (second caller waits)', async () => {
    let releaseFirst!: () => void
    mockFetch
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve(sseResponse('primera'))
      }))
      .mockImplementationOnce(async () => sseResponse('segunda'))

    const first = { chunks: [] as string[], onClose: vi.fn(), onError: vi.fn() }
    const second = { chunks: [] as string[], onClose: vi.fn(), onError: vi.fn() }
    const data = { ...streamData, idempotencyKey: 'turn-single-flight' }
    const p1 = api.generateAIStream(data, (c) => first.chunks.push(c), first.onClose, first.onError)
    const p2 = api.generateAIStream(data, (c) => second.chunks.push(c), second.onClose, second.onError)
    await vi.advanceTimersByTimeAsync(10)

    expect(api.isGenerateTurnInFlight('turn-single-flight')).toBe(true)
    expect(generateCalls()).toHaveLength(1)

    releaseFirst()
    await vi.runAllTimersAsync()
    await Promise.all([p1, p2])

    expect(generateCalls()).toHaveLength(2)
    expect(first.chunks).toEqual(['primera'])
    expect(second.chunks).toEqual(['segunda'])
    expect(first.onClose).toHaveBeenCalledOnce()
    expect(second.onClose).toHaveBeenCalledOnce()
    expect(api.isGenerateTurnInFlight('turn-single-flight')).toBe(false)
  })
})
