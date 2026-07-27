import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient as api } from '@/lib/api'
import { cancelTask, resolveApproval } from '@/lib/agent-task-service'
import {
  authenticatedFetch,
  clearAuthenticatedFetchCsrfCache,
} from '@/lib/authenticated-fetch'

vi.mock('@/lib/client-logs', () => ({
  reportClientLog: vi.fn(),
}))

const mockFetch = vi.fn()
globalThis.fetch = mockFetch as unknown as typeof fetch

const streamData = {
  provider: 'test-provider',
  model: 'test-model',
  prompt: 'hello',
  streamId: 'stream-1',
}

function sseResponse(content = 'done') {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\ndata: [DONE]\n\n`))
      controller.close()
    },
  })

  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body,
  }
}

function jsonError(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function runStream(signal?: AbortSignal) {
  const chunks: string[] = []
  const onClose = vi.fn()
  const onError = vi.fn()

  await api.generateAIStream(
    streamData,
    chunk => chunks.push(chunk),
    onClose,
    onError,
    signal,
  )

  return { chunks, onClose, onError }
}

describe('generateAIStream cookie session CSRF transport', () => {
  beforeEach(() => {
    vi.useRealTimers()
    mockFetch.mockReset()
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.setToken(null)
    clearAuthenticatedFetchCsrfCache()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('includes browser credentials and a CSRF token for a cookie-only stream', async () => {
    const ensureCsrf = vi.fn().mockResolvedValue('csrf-cookie-session')
    vi.spyOn(authenticatedFetch.csrfManager, 'getToken').mockImplementation(ensureCsrf)
    mockFetch.mockResolvedValueOnce(sseResponse('cookie reply'))

    const { chunks, onClose, onError } = await runStream()

    expect(chunks.join('')).toBe('cookie reply')
    expect(onClose).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(ensureCsrf).toHaveBeenCalledOnce()

    const [, options] = mockFetch.mock.calls[0]
    const headers = new Headers(options.headers)
    expect(options.credentials).toBe('include')
    expect(headers.get('X-CSRF-Token')).toBe('csrf-cookie-session')
    expect(headers.has('Authorization')).toBe(false)
  })

  it('prepares cookie credentials and CSRF again before a transport reconnect', async () => {
    vi.useFakeTimers()
    const ensureCsrf = vi.fn().mockResolvedValue('csrf-reconnect')
    vi.spyOn(authenticatedFetch.csrfManager, 'getToken').mockImplementation(ensureCsrf)
    mockFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(sseResponse('reconnected'))

    const streamPromise = runStream()
    await vi.runAllTimersAsync()
    const { chunks, onClose, onError } = await streamPromise

    expect(chunks).toEqual(['reconnected'])
    expect(onClose).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(ensureCsrf).toHaveBeenCalledTimes(2)
    for (const [, options] of mockFetch.mock.calls) {
      expect(options.credentials).toBe('include')
      expect(new Headers(options.headers).get('X-CSRF-Token')).toBe('csrf-reconnect')
    }
  })

  it('force-refreshes csrf_invalid once without consuming the provider retry budget', async () => {
    vi.useFakeTimers()
    let refreshed = false
    const ensureCsrf = vi.fn(async (forceRefresh = false) => {
      if (forceRefresh) refreshed = true
      return refreshed ? 'csrf-fresh' : 'csrf-stale'
    })
    vi.spyOn(authenticatedFetch.csrfManager, 'getToken').mockImplementation(ensureCsrf)

    mockFetch
      .mockResolvedValueOnce(jsonError(403, { error: 'csrf_invalid' }))
      .mockResolvedValueOnce(jsonError(500, { error: 'provider unavailable 1' }))
      .mockResolvedValueOnce(jsonError(500, { error: 'provider unavailable 2' }))
      .mockResolvedValueOnce(jsonError(500, { error: 'provider unavailable 3' }))
      .mockResolvedValueOnce(jsonError(500, { error: 'provider unavailable 4' }))
      .mockResolvedValueOnce(sseResponse('after full retry budget'))

    const streamPromise = runStream()
    await vi.runAllTimersAsync()
    const { chunks, onClose, onError } = await streamPromise

    expect(chunks).toEqual(['after full retry budget'])
    expect(onClose).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(6)
    expect(ensureCsrf).toHaveBeenCalledWith(true)

    const firstHeaders = new Headers(mockFetch.mock.calls[0][1].headers)
    const secondHeaders = new Headers(mockFetch.mock.calls[1][1].headers)
    expect(firstHeaders.get('X-CSRF-Token')).toBe('csrf-stale')
    expect(secondHeaders.get('X-CSRF-Token')).toBe('csrf-fresh')
  })

  it('preserves bearer authentication without requesting or sending CSRF', async () => {
    api.setToken('bearer-session')
    const ensureCsrf = vi.fn().mockResolvedValue('must-not-be-used')
    vi.spyOn(authenticatedFetch.csrfManager, 'getToken').mockImplementation(ensureCsrf)
    mockFetch.mockResolvedValueOnce(sseResponse('bearer reply'))

    const { chunks, onError } = await runStream()

    expect(chunks.join('')).toBe('bearer reply')
    expect(onError).not.toHaveBeenCalled()
    expect(ensureCsrf).not.toHaveBeenCalled()

    const [, options] = mockFetch.mock.calls[0]
    const headers = new Headers(options.headers)
    expect(options.credentials).toBe('include')
    expect(headers.get('Authorization')).toBe('Bearer bearer-session')
    expect(headers.has('X-CSRF-Token')).toBe(false)
  })

  it('does not prepare or dispatch a request after the caller aborts', async () => {
    const ensureCsrf = vi.fn().mockResolvedValue('csrf-unused')
    vi.spyOn(authenticatedFetch.csrfManager, 'getToken').mockImplementation(ensureCsrf)
    const controller = new AbortController()
    controller.abort()

    const { chunks, onClose, onError } = await runStream(controller.signal)

    expect(mockFetch).not.toHaveBeenCalled()
    expect(ensureCsrf).not.toHaveBeenCalled()
    expect(chunks).toEqual([])
    expect(onClose).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].message).toMatch(/aborted/i)
  })

  it('never reconnects or duplicates content after a chunk reached the caller', async () => {
    const ensureCsrf = vi.fn().mockResolvedValue('csrf-once')
    vi.spyOn(authenticatedFetch.csrfManager, 'getToken').mockImplementation(ensureCsrf)
    const encoded = new TextEncoder().encode(
      `data: ${JSON.stringify({ content: 'first chunk\n' })}\n\n`,
    )
    let reads = 0
    const cancel = vi.fn()
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1
            if (reads === 1) return { done: false, value: encoded }
            throw new TypeError('socket dropped')
          },
          cancel,
        }),
      },
    })

    const { chunks, onClose, onError } = await runStream()

    expect(chunks).toEqual(['first chunk\n'])
    expect(mockFetch).toHaveBeenCalledOnce()
    expect(ensureCsrf).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('uses the same cookie and CSRF preparation for direct auxiliary chat streams', async () => {
    const ensureCsrf = vi.fn().mockResolvedValue('csrf-doc-stream')
    vi.spyOn(authenticatedFetch.csrfManager, 'getToken').mockImplementation(ensureCsrf)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'))
          controller.close()
        },
      }),
    })

    await api.generateDocStream(
      { prompt: 'make a document' },
      vi.fn(),
    )

    const [, options] = mockFetch.mock.calls[0]
    const headers = new Headers(options.headers)
    expect(options.credentials).toBe('include')
    expect(headers.get('X-CSRF-Token')).toBe('csrf-doc-stream')
    expect(headers.has('Authorization')).toBe(false)
  })

  it('keeps chat stop and agent permissions on the CSRF-aware request transport', async () => {
    const ensureCsrf = vi.fn().mockResolvedValue('csrf-control')
    vi.spyOn(authenticatedFetch.csrfManager, 'getToken').mockImplementation(ensureCsrf)
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ ok: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ ok: true }),
      })

    await api.stopAIStream('stream-to-stop')
    await api.resolveAgentPermission('permission-1', 'allow')

    expect(mockFetch).toHaveBeenCalledTimes(2)
    for (const [, options] of mockFetch.mock.calls) {
      const headers = new Headers(options.headers)
      expect(options.credentials).toBe('include')
      expect(headers.get('X-CSRF-Token')).toBe('csrf-control')
    }
  })

  it('protects standalone agent cancel and approval transports for cookie sessions', async () => {
    const ensureCsrf = vi.fn().mockResolvedValue('csrf-agent-control')
    vi.spyOn(authenticatedFetch.csrfManager, 'getToken').mockImplementation(ensureCsrf)
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ taskId: 'task-1', status: 'cancelled' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ taskId: 'task-1', decision: 'approve' }),
      })

    await cancelTask('task-1')
    await resolveApproval('task-1', 'approve')

    expect(mockFetch).toHaveBeenCalledTimes(2)
    for (const [, options] of mockFetch.mock.calls) {
      const headers = new Headers(options.headers)
      expect(options.credentials).toBe('include')
      expect(headers.get('X-CSRF-Token')).toBe('csrf-agent-control')
      expect(headers.has('Authorization')).toBe(false)
    }
  })
})
