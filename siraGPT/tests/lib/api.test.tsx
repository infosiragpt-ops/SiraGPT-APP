import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apiClient as api } from '@/lib/api'

// Mock fetch globally
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

describe('api client core', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.setToken(null)
  })

  it('includes Authorization header when token is set', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    })

    api.setToken('my-token')
    await api.getCurrentUser()

    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers.get('Authorization')).toBe('Bearer my-token')
  })

  it('sanitizes decorated headers before constructing request headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    })

    const headers: Record<PropertyKey, unknown> = {
      'x-safe': 'yes',
      'x-count': 2,
      'x-null': null,
      'x-symbol-value': Symbol('skip'),
    }
    headers[Symbol('sdk-metadata')] = 'skip'

    await (api as any).request('/auth/me', { headers })

    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.headers.get('x-safe')).toBe('yes')
    expect(opts.headers.get('x-count')).toBe('2')
    expect(opts.headers.has('x-null')).toBe(false)
    expect(opts.headers.has('x-symbol-value')).toBe(false)
  })

  it('returns null for 204 No Content (via getCurrentUser)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
    })

    const result = await api.getCurrentUser()
    expect(result).toBeNull()
  })

  it('rejects on 4xx without retry (via getCurrentUser)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    })

    await expect(api.getCurrentUser()).rejects.toThrow()
    // Should not retry on 4xx
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('retries on 5xx (via getCurrentUser)', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: 'Unavailable' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ user: { name: 'test' } }),
      })

    const result = await api.getCurrentUser()
    expect(result).toEqual({ user: { name: 'test' } })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('retries on network error (via getCurrentUser)', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ user: { name: 'test' } }),
      })

    const result = await api.getCurrentUser()
    expect(result).toEqual({ user: { name: 'test' } })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('exhausts retries after repeated failures', async () => {
    // Need to mock multiple failures
    mockFetch.mockRejectedValue(new TypeError('Always down'))

    await expect(api.getCurrentUser()).rejects.toThrow()
    // Should try initial + 2 retries (MAX_RETRIES=2)
    expect(mockFetch.mock.calls.length).toBe(3)
  })
})
