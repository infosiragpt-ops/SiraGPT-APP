import { describe, it, expect, vi } from 'vitest'
import {
  fetchLinkPreview,
  faviconFallbackUrl,
  type LinkPreview,
} from '../../lib/attachments/link-preview'

function okResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response
}

describe('fetchLinkPreview', () => {
  it('returns the parsed preview on success and url-encodes the query param', async () => {
    const payload: LinkPreview = {
      url: 'https://example.com/a?b=1&c=2',
      title: 'Ejemplo',
      faviconUrl: 'https://example.com/favicon.ico',
      imageUrl: 'https://example.com/og.png',
    }
    const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      okResponse(payload),
    )
    const preview = await fetchLinkPreview('https://example.com/a?b=1&c=2', {
      fetchImpl: mock as unknown as typeof fetch,
    })
    expect(preview).toEqual(payload)
    expect(mock).toHaveBeenCalledTimes(1)
    const calledUrl = mock.mock.calls[0]?.[0] as unknown as string
    expect(calledUrl).toBe(
      `/api/link-preview?url=${encodeURIComponent('https://example.com/a?b=1&c=2')}`,
    )
  })

  it('normalises missing fields to null and falls back to the input url', async () => {
    const mock = vi.fn(async () => okResponse({ title: 'Solo título' }))
    const preview = await fetchLinkPreview('https://example.com/x', {
      fetchImpl: mock as unknown as typeof fetch,
    })
    expect(preview).toEqual({
      url: 'https://example.com/x',
      title: 'Solo título',
      faviconUrl: null,
      imageUrl: null,
    })
  })

  it('returns null on non-200 responses', async () => {
    const mock = vi.fn(async () =>
      ({ ok: false, status: 502, json: async () => ({ error: 'fetch_failed' }) }) as unknown as Response,
    )
    const preview = await fetchLinkPreview('https://example.com', {
      fetchImpl: mock as unknown as typeof fetch,
    })
    expect(preview).toBeNull()
  })

  it('returns null when the network throws', async () => {
    const mock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const preview = await fetchLinkPreview('https://example.com', {
      fetchImpl: mock as unknown as typeof fetch,
    })
    expect(preview).toBeNull()
  })

  it('returns null when the body is not valid JSON', async () => {
    const mock = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } }) as unknown as Response,
    )
    const preview = await fetchLinkPreview('https://example.com', {
      fetchImpl: mock as unknown as typeof fetch,
    })
    expect(preview).toBeNull()
  })

  it('returns null on timeout (internal AbortController fires)', async () => {
    const mock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // Hang until the client aborts us via its timeout controller.
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    )
    const preview = await fetchLinkPreview('https://slow.example.com', {
      timeoutMs: 10,
      fetchImpl: mock as unknown as typeof fetch,
    })
    expect(preview).toBeNull()
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('returns null immediately when the external signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const mock = vi.fn(async () => okResponse({}))
    const preview = await fetchLinkPreview('https://example.com', {
      signal: controller.signal,
      fetchImpl: mock as unknown as typeof fetch,
    })
    expect(preview).toBeNull()
    expect(mock).not.toHaveBeenCalled()
  })
})

describe('faviconFallbackUrl', () => {
  it('builds the Google s2 favicon URL from the hostname', () => {
    expect(faviconFallbackUrl('https://sub.example.com/path?q=1')).toBe(
      'https://www.google.com/s2/favicons?domain=sub.example.com&sz=64',
    )
  })

  it('tolerates bare hosts without a scheme', () => {
    expect(faviconFallbackUrl('example.com')).toBe(
      'https://www.google.com/s2/favicons?domain=example.com&sz=64',
    )
  })

  it('returns null when no hostname can be derived', () => {
    expect(faviconFallbackUrl('')).toBeNull()
    expect(faviconFallbackUrl('not a url %%%')).toBeNull()
  })
})
