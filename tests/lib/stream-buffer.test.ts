import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StreamBuffer } from '@/lib/stream-buffer'

type FlushLog = { joined: string }[]

// `hasRAF` is captured at module-load time, so each scenario re-imports the
// module under the environment it wants to exercise.
async function loadStreamBuffer(): Promise<typeof import('@/lib/stream-buffer')> {
  return await import('@/lib/stream-buffer')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('createStreamBuffer', () => {
  it('delivers the first chunk immediately instead of waiting for the batching timer', async () => {
    const { createStreamBuffer } = await loadStreamBuffer()
    const flushed: FlushLog = []
    let buffer: StreamBuffer | null = null
    buffer = createStreamBuffer({
      onFlush: (joined) => {
        flushed.push({ joined })
      },
    })

    buffer.append('Hola')

    // Chunk 0 must reach the consumer synchronously — no rAF/timer tick.
    expect(flushed).toEqual([{ joined: 'Hola' }])
    // Advancing past several batching intervals must not re-deliver chunk 0.
    vi.advanceTimersByTime(64)
    expect(flushed).toEqual([{ joined: 'Hola' }])

    buffer.dispose()
  })

  it('keeps per-frame batching for every append after the first', async () => {
    const { createStreamBuffer } = await loadStreamBuffer()
    const flushed: FlushLog = []
    const buffer = createStreamBuffer({
      onFlush: (joined) => {
        flushed.push({ joined })
      },
    })

    buffer.append('a')
    expect(flushed).toEqual([{ joined: 'a' }])

    buffer.append('b')
    expect(flushed).toEqual([{ joined: 'a' }])
    vi.advanceTimersByTime(16)
    expect(flushed).toEqual([{ joined: 'a' }, { joined: 'b' }])

    buffer.dispose()
  })

  it('uses the immediate fast path on the setTimeout fallback (hidden tab)', async () => {
    // Keep rAF available for cancelScheduled but make the module see a
    // hidden document at import time so it captures hasRAF=false and takes
    // the setTimeout(16) fallback path.
    const realWindow = globalThis.window
    vi.stubGlobal(
      'window',
      Object.defineProperty(Object.assign({}, realWindow), 'requestAnimationFrame', {
        get: () => undefined,
      }),
    )
    const documentWithGetter = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'visibilityState',
    )
    expect(documentWithGetter?.get).toBeDefined()
    Object.defineProperty(document, 'visibilityState', {
      get: () => 'hidden',
      configurable: true,
    })

    try {
      const { createStreamBuffer } = await loadStreamBuffer()
      const flushed: FlushLog = []
      const buffer = createStreamBuffer({
        onFlush: (joined) => {
          flushed.push({ joined })
        },
      })

      buffer.append('hola')
      expect(flushed).toEqual([{ joined: 'hola' }])
      expect(vi.getTimerCount()).toBe(0)

      // Later chunks still coalesce through one 16ms fallback timer.
      buffer.append('mun')
      buffer.append('do')
      expect(flushed).toEqual([{ joined: 'hola' }])
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(16)
      expect(flushed).toEqual([{ joined: 'hola' }, { joined: 'mundo' }])

      buffer.dispose()
    } finally {
      if (documentWithGetter?.get) {
        Object.defineProperty(Document.prototype, 'visibilityState', documentWithGetter)
      }
    }
  })

  it('does not spend the fast path on an explicit flush of an empty queue', async () => {
    const { createStreamBuffer } = await loadStreamBuffer()
    const flushed: FlushLog = []
    const buffer = createStreamBuffer({
      onFlush: (joined) => {
        flushed.push({ joined })
      },
    })

    buffer.flush()
    expect(flushed).toEqual([])

    // The first real chunk still gets the immediate delivery.
    buffer.append('primero')
    expect(flushed).toEqual([{ joined: 'primero' }])

    buffer.dispose()
  })
})
