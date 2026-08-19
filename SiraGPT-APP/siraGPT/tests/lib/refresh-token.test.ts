import { describe, it, expect, vi, beforeEach } from 'vitest'
import { apiClient as api } from '@/lib/api'

describe('refresh token', () => {
  const mockFetch = vi.fn()
  const testToken = 'test-token-123'
  const refreshedToken = 'refreshed-token-456'

  beforeEach(() => {
    globalThis.fetch = mockFetch
    vi.clearAllMocks()
    api.setToken(null)
    ;(api as any)._refreshing = null
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
})
