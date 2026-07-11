import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  params: new URLSearchParams(),
}))

const auth = vi.hoisted(() => ({
  loginWithToken: vi.fn(),
  hydrateSession: vi.fn(),
  isLoading: false,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: navigation.replace,
    push: navigation.push,
  }),
  useSearchParams: () => navigation.params,
}))

vi.mock('@/lib/auth-context-integrated', () => ({
  useAuth: () => auth,
}))

vi.mock('@/components/ui/thinking-indicator', () => ({
  ThinkingIndicator: () => <span data-testid="thinking" />,
}))

import AuthCallback from '@/app/auth/callback/page'

describe('auth callback completion', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    vi.clearAllMocks()
    navigation.params = new URLSearchParams()
  })

  afterEach(() => {
    cleanup()
  })

  it('awaits cookie-session hydration after SAML and redirects to chat', async () => {
    navigation.params = new URLSearchParams('sso=success')
    auth.hydrateSession.mockResolvedValueOnce({
      status: 'authenticated',
      user: { id: 'saml-user' },
    })

    render(<AuthCallback />)

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith('/chat')
    })

    expect(auth.hydrateSession).toHaveBeenCalledTimes(1)
    expect(auth.loginWithToken).not.toHaveBeenCalled()
    expect(localStorage.getItem('auth-token')).toBeNull()
  })

  it('rejects OAuth session tokens in the query string without persisting them', async () => {
    navigation.params = new URLSearchParams('token=legacy-oauth-token')

    render(<AuthCallback />)

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith(
        '/auth/login?error=' + encodeURIComponent('Enlace de autenticación no válido'),
      )
    })

    expect(auth.loginWithToken).not.toHaveBeenCalled()
    expect(auth.hydrateSession).not.toHaveBeenCalled()
    expect(localStorage.getItem('auth-token')).toBeNull()
  })
})
