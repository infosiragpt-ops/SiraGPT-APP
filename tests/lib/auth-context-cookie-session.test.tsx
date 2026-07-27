import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiClientMock = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  setToken: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  apiClient: apiClientMock,
}))

vi.mock('@/lib/dev-log', () => ({
  devLog: vi.fn(),
}))

vi.mock('@/hooks/use-chat-draft', () => ({
  clearAllChatDrafts: vi.fn(),
}))

import { AuthProvider, useAuth } from '@/lib/auth-context-integrated'

const COOKIE_USER = {
  id: 'user-saml-1',
  name: 'SAML User',
  email: 'saml@example.com',
  plan: 'PRO',
  isAdmin: false,
  apiUsage: 0,
  monthlyLimit: 100,
  createdAt: '2026-07-11T00:00:00.000Z',
  updatedAt: '2026-07-11T00:00:00.000Z',
}

function AuthProbe() {
  const auth = useAuth() as ReturnType<typeof useAuth> & {
    isAuthenticated?: boolean
    sessionStatus?: string
  }

  return (
    <dl>
      <dt>loading</dt>
      <dd data-testid="loading">{String(auth.isLoading)}</dd>
      <dt>status</dt>
      <dd data-testid="status">{auth.sessionStatus || 'missing'}</dd>
      <dt>authenticated</dt>
      <dd data-testid="authenticated">{String(auth.isAuthenticated)}</dd>
      <dt>user</dt>
      <dd data-testid="user">{auth.user?.email || 'none'}</dd>
      <dt>token</dt>
      <dd data-testid="token">{auth.token || 'none'}</dd>
    </dl>
  )
}

function renderAuth() {
  return render(
    <AuthProvider>
      <AuthProbe />
    </AuthProvider>,
  )
}

describe('AuthProvider cookie-session hydration', () => {
  beforeEach(() => {
    cleanup()
    localStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('hydrates a cookie-authenticated user without creating or storing a JWT', async () => {
    apiClientMock.getCurrentUser.mockResolvedValueOnce({ user: COOKIE_USER })

    renderAuth()

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
    })

    expect(apiClientMock.getCurrentUser).toHaveBeenCalledTimes(1)
    expect(apiClientMock.setToken).toHaveBeenCalledWith(null)
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true')
    expect(screen.getByTestId('user')).toHaveTextContent(COOKIE_USER.email)
    expect(screen.getByTestId('token')).toHaveTextContent('none')
    expect(localStorage.getItem('auth-token')).toBeNull()
    expect(screen.getByTestId('loading')).toHaveTextContent('false')
  })

  it('classifies a 401 cookie check as unauthenticated', async () => {
    const unauthorized = Object.assign(new Error('Access token required'), {
      status: 401,
      statusCode: 401,
    })
    apiClientMock.getCurrentUser.mockRejectedValueOnce(unauthorized)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    renderAuth()

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated')
    })

    expect(screen.getByTestId('user')).toHaveTextContent('none')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('classifies a transient cookie check failure separately from a 401', async () => {
    const unavailable = Object.assign(new Error('Service unavailable'), {
      status: 503,
      statusCode: 503,
    })
    apiClientMock.getCurrentUser.mockRejectedValueOnce(unavailable)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    renderAuth()

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('error')
    })

    expect(screen.getByTestId('status')).not.toHaveTextContent('unauthenticated')
    expect(screen.getByTestId('user')).toHaveTextContent('none')
    expect(errorSpy).toHaveBeenCalledWith('Cookie session hydration failed:', unavailable)
  })
})
