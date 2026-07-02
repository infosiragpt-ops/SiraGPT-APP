import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apiClient as api } from '@/lib/api'

vi.mock('@/lib/client-logs', () => ({
  reportClientLog: vi.fn(),
}))

const mockFetch = vi.fn()
globalThis.fetch = mockFetch as unknown as typeof fetch

function streamOfChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]))
        i += 1
      } else {
        controller.close()
      }
    },
  })
}

describe('generateWordStream — cross-read SSE frame reassembly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.setToken(null)
  })

  it('reassembles a data frame split across two reads and fires onClose on a boundary-split done frame', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: streamOfChunks([
        'data: {"content":"hel',
        'lo"}\n\ndata: {"done":true}\n\n',
      ]),
    })

    const received: string[] = []
    let closed = false
    let errored: Error | null = null

    await api.generateWordStream(
      { provider: 'p', model: 'm', prompt: 'x', streamId: 's1' },
      (chunk) => received.push(chunk),
      () => { closed = true },
      (err) => { errored = err },
    )

    expect(errored).toBeNull()
    expect(received.join('')).toBe('hello')
    expect(closed).toBe(true)
  })

  it('does not lose tokens when every frame arrives whole', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: streamOfChunks([
        'data: {"content":"foo"}\n\n',
        'data: {"content":"bar"}\n\n',
        'data: {"done":true}\n\n',
      ]),
    })

    const received: string[] = []
    let closed = false

    await api.generateWordStream(
      { provider: 'p', model: 'm', prompt: 'x', streamId: 's2' },
      (chunk) => received.push(chunk),
      () => { closed = true },
      () => {},
    )

    expect(received.join('')).toBe('foobar')
    expect(closed).toBe(true)
  })
})
