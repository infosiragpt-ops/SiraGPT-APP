import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apiClient as api } from '@/lib/api'
import { authenticatedFetch, clearAuthenticatedFetchCsrfCache } from '@/lib/authenticated-fetch'

describe('refresh token', () => {
  const mockFetch = vi.fn()
  const testToken = 'test-token-123'
  const refreshedToken = 'refreshed-token-456'

  beforeEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = mockFetch
    mockFetch.mockReset()
    api.setToken(null)
    ;(api as any)._refreshing = null
    clearAuthenticatedFetchCsrfCache()
    vi.spyOn(authenticatedFetch.csrfManager, 'getToken').mockResolvedValue(null)
  })

  it('calls /auth/refresh on 401 then retries with new token', async () => {
    api.setToken(testToken)

    mockFetch
      // 1st /auth/me → 401
      .mockResolvedValueOnce({
        ok: false, status: 401, json: () => Promise.resolve({ error: 'expired' }),
      })
      // /auth/refresh → success
      .mockResolvedValueOnce({
        ok: true, status: 200, json: () => Promise.resolve({ token: refreshedToken }),
      })
      // 2nd /auth/me → 200
      .mockResolvedValueOnce({
        ok: true, status: 200, json: () => Promise.resolve({ user: { name: 'test' } }),
      })

    const result = await api.getCurrentUser()
    expect(result).toEqual({ user: { name: 'test' } })
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('only refreshes once for concurrent 401s', async () => {
    api.setToken(testToken)
    let refreshCount = 0
    let meCount = 0
    let chatCount = 0

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/auth/refresh')) {
        refreshCount++
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ token: refreshedToken }) })
      }
      if (url.includes('/auth/me')) {
        meCount++
        // First call fails, subsequent calls succeed (after refresh)
        if (meCount === 1) {
          return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'expired' }) })
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ user: { name: 'test' } }) })
      }
      if (url.includes('/chats')) {
        chatCount++
        if (chatCount === 1) {
          return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'expired' }) })
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ chats: [] }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    await Promise.all([
      api.getCurrentUser(),
      api.getChats({}),
    ])

    expect(refreshCount).toBe(1)
    expect(meCount).toBe(2)
    expect(chatCount).toBe(2)
  })

  it('falls back to cookie-only refresh when stale localStorage bearer poisons image generation', async () => {
    api.setToken(testToken)

    mockFetch
      // 1st /ai/generate-image → stale Bearer is rejected
      .mockResolvedValueOnce({
        ok: false, status: 401, headers: new Headers(), json: () => Promise.resolve({ error: 'Invalid or expired token' }),
      })
      // /auth/refresh with stale Bearer also fails because Authorization takes precedence over cookie
      .mockResolvedValueOnce({
        ok: false, status: 401, headers: new Headers(), json: () => Promise.resolve({ error: 'Invalid or expired token' }),
      })
      // cookie-only /auth/refresh succeeds and issues a clean token
      .mockResolvedValueOnce({
        ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({ token: refreshedToken }),
      })
      // retried /ai/generate-image uses the refreshed token
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ imageUrl: 'https://api.siragpt.com/uploads/images/generated.png' }),
      })

    const result = await api.generateImage({
      prompt: 'Crea una imagen de un pollo',
      provider: 'OpenRouter',
      model: 'bytedance-seed/seedream-4.5',
      aspectRatio: '1:1',
    })

    expect(result).toEqual({ imageUrl: 'https://api.siragpt.com/uploads/images/generated.png' })
    expect(mockFetch).toHaveBeenCalledTimes(4)

    const [, firstImageOptions] = mockFetch.mock.calls[0]
    expect(firstImageOptions.headers.get('Authorization')).toBe(`Bearer ${testToken}`)

    const [, bearerRefreshOptions] = mockFetch.mock.calls[1]
    expect(String(mockFetch.mock.calls[1][0])).toContain('/auth/refresh')
    expect(bearerRefreshOptions.headers.get('Authorization')).toBe(`Bearer ${testToken}`)

    const [, cookieRefreshOptions] = mockFetch.mock.calls[2]
    expect(String(mockFetch.mock.calls[2][0])).toContain('/auth/refresh')
    expect(cookieRefreshOptions.headers.has('Authorization')).toBe(false)

    const [, retriedImageOptions] = mockFetch.mock.calls[3]
    expect(retriedImageOptions.headers.get('Authorization')).toBe(`Bearer ${refreshedToken}`)
  })

  it('uses the in-memory token for document SSE when localStorage is empty', async () => {
    api.setToken(testToken)
    window.localStorage.removeItem('auth-token')

    const events: any[] = []
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"final","content":"ok"}\n\n'))
        controller.close()
      },
    })

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body,
    })

    await api.generateDocStream(
      { prompt: 'crea esto en un word', chatId: 'chat_1', model: 'grok-4.3', format: 'docx' },
      (event) => events.push(event),
    )

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetch.mock.calls[0]
    expect(String(url)).toContain('/doc/generate')
    expect(new Headers(options.headers).get('Authorization')).toBe(`Bearer ${testToken}`)
    expect(events).toEqual([{ type: 'final', content: 'ok' }])
  })

  it('refreshes once and retries document SSE after Access token required', async () => {
    api.setToken(null)
    window.localStorage.removeItem('auth-token')

    const events: any[] = []
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"final","content":"doc listo"}\n\n'))
        controller.close()
      },
    })

    mockFetch
      // /doc/generate without a Bearer token is rejected by authenticateToken.
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        json: () => Promise.resolve({ error: 'Access token required' }),
      })
      // /auth/refresh can still mint a clean JWT from the httpOnly refresh cookie.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ token: refreshedToken }),
      })
      // Retried /doc/generate now carries Authorization and streams normally.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        body,
      })

    await api.generateDocStream(
      { prompt: 'crea esto en un word', chatId: 'chat_1', model: 'grok-4.3', format: 'docx' },
      (event) => events.push(event),
    )

    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(String(mockFetch.mock.calls[0][0])).toContain('/doc/generate')
    expect(new Headers(mockFetch.mock.calls[0][1].headers).has('Authorization')).toBe(false)
    expect(String(mockFetch.mock.calls[1][0])).toContain('/auth/refresh')
    expect(String(mockFetch.mock.calls[2][0])).toContain('/doc/generate')
    expect(new Headers(mockFetch.mock.calls[2][1].headers).get('Authorization')).toBe(`Bearer ${refreshedToken}`)
    expect(events).toEqual([{ type: 'final', content: 'doc listo' }])
  })
})
