import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apiClient as api } from '@/lib/api'
import { reportClientLog } from '@/lib/client-logs'
import { authenticatedFetch, clearAuthenticatedFetchCsrfCache } from '@/lib/authenticated-fetch'

vi.mock('@/lib/client-logs', () => ({
  reportClientLog: vi.fn(),
}))

// Mock fetch globally
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

describe('api client core', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockFetch.mockReset()
    vi.clearAllMocks()
    api.setToken(null)
    clearAuthenticatedFetchCsrfCache()
    vi.spyOn(authenticatedFetch.csrfManager, 'getToken').mockResolvedValue(null)
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

  it('uses browser credentials without inventing an Authorization header for cookie session hydration', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ user: { id: 'cookie-user' } }),
    })

    await api.getCurrentUser()

    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.credentials).toBe('include')
    expect(opts.headers.has('Authorization')).toBe(false)
    expect(localStorage.getItem('auth-token')).toBeNull()
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

  it('verifies payment sessions with a CSRF-aware POST body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ updated: true }),
    })
    vi.mocked(authenticatedFetch.csrfManager.getToken).mockResolvedValue('csrf-payment-token')

    await api.verifyPaymentSession('cs_test_123')

    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toMatch(/\/payments\/verify-session$/)
    expect(opts.method).toBe('POST')
    expect(JSON.parse(String(opts.body))).toEqual({ session_id: 'cs_test_123' })
    expect(opts.headers.get('X-CSRF-Token')).toBe('csrf-payment-token')
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
      headers: new Headers(),
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    })

    await expect(api.getCurrentUser()).rejects.toThrow()
    // Should not retry on 4xx
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('does not report expected auth/me 401 telemetry', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: () => Promise.resolve({ error: 'Invalid or expired token' }),
    })

    await expect(api.getCurrentUser()).rejects.toThrow('Invalid or expired token')

    expect(reportClientLog).not.toHaveBeenCalled()
  })

  it('does not report invalid login credentials as API error telemetry', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Headers(),
      json: () => Promise.resolve({ error: 'Invalid credentials' }),
    })

    await expect(api.login({ email: 'bad@example.com', password: 'wrong' } as any)).rejects.toThrow('Invalid credentials')

    expect(reportClientLog).not.toHaveBeenCalled()
  })

  it('does not report expired-token failures from protected feature calls', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        json: () => Promise.resolve({ error: 'Invalid or expired token' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        json: () => Promise.resolve({ error: 'Invalid or expired token' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        json: () => Promise.resolve({ error: 'Invalid or expired token' }),
      })

    api.setToken('expired-token')
    await expect(api.generateVideo({ prompt: 'test video' })).rejects.toThrow('Invalid or expired token')

    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(reportClientLog).not.toHaveBeenCalled()
  })

  it('still reports unexpected API failures', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: new Headers([['X-Request-Id', 'req_bad']]),
      json: () => Promise.resolve({ error: 'Malformed payload', code: 'bad_request' }),
    })

    await expect((api as any).request('/ai/generate-video', { method: 'POST', body: '{}' })).rejects.toThrow('Malformed payload')

    expect(reportClientLog).toHaveBeenCalledWith(expect.objectContaining({
      source: 'api',
      severity: 'warn',
      action: 'api_request_failed',
      endpoint: '/ai/generate-video',
      status: 400,
      requestId: 'req_bad',
    }))
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
