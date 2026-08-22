import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient as api } from '@/lib/api'
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

function sseEvents(events: Array<Record<string, unknown>>, opts?: { withDone?: boolean }) {
  const encoder = new TextEncoder()
  const withDone = opts?.withDone !== false
  const payload = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}${withDone ? 'data: [DONE]\n\n' : ''}`
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
  return { ok: true, status: 200, headers: new Headers(), body }
}

describe('generateAIStream lifecycle frames (start / heartbeat)', () => {
  beforeEach(() => {
    vi.useRealTimers()
    mockFetch.mockReset()
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.setToken(null)
    clearAuthenticatedFetchCsrfCache()
    vi.spyOn(authenticatedFetch.csrfManager, 'getToken').mockResolvedValue('csrf-lifecycle')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fires onStart on the start frame and every heartbeat without touching message content', async () => {
    mockFetch.mockResolvedValueOnce(sseEvents([
      { type: 'start', model: 'test-model', ts: 1000 },
      { type: 'heartbeat', ts: 6000 },
      { type: 'heartbeat', ts: 11000 },
      { content: 'hola' },
    ]))

    const chunks: string[] = []
    const starts: Array<{ type: string; model?: string; ts?: number }> = []
    const onClose = vi.fn()
    const onError = vi.fn()

    await api.generateAIStream(
      streamData,
      chunk => chunks.push(chunk),
      onClose,
      onError,
      undefined,
      { onStart: p => starts.push(p) },
    )

    expect(starts).toEqual([
      { type: 'start', ts: 1000, model: 'test-model' },
      { type: 'heartbeat', ts: 6000, model: undefined },
      { type: 'heartbeat', ts: 11000, model: undefined },
    ])
    expect(chunks.join('')).toBe('hola')
    expect(onClose).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not fire onStart for streams without lifecycle frames', async () => {
    mockFetch.mockResolvedValueOnce(sseEvents([{ content: 'solo contenido' }]))

    const starts: unknown[] = []
    const chunks: string[] = []
    const onClose = vi.fn()
    const onError = vi.fn()

    await api.generateAIStream(
      streamData,
      chunk => chunks.push(chunk),
      onClose,
      onError,
      undefined,
      { onStart: p => starts.push(p) },
    )

    expect(starts).toEqual([])
    expect(chunks.join('')).toBe('solo contenido')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('works without an onStart handler (legacy callers unaffected)', async () => {
    mockFetch.mockResolvedValueOnce(sseEvents([
      { type: 'start' },
      { type: 'heartbeat' },
      { content: 'ok' },
    ]))

    const chunks: string[] = []
    const onClose = vi.fn()
    const onError = vi.fn()

    await api.generateAIStream(
      streamData,
      chunk => chunks.push(chunk),
      onClose,
      onError,
    )

    expect(chunks.join('')).toBe('ok')
    expect(onClose).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })
})
