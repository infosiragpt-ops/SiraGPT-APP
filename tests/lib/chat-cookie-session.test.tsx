import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiClientMock = vi.hoisted(() => ({
  getAIModels: vi.fn(),
  getChats: vi.fn(),
}))

const cookieAuthState = vi.hoisted(() => ({
  user: {
    id: 'cookie-user',
    name: 'Cookie User',
    email: 'cookie@example.com',
  },
  token: null,
  isAuthenticated: true,
}))

const backgroundStreams = vi.hoisted(() => ({
  register: vi.fn(),
  appendChunk: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  cancel: vi.fn(),
  get: vi.fn(),
}))

vi.mock('@/lib/auth-context-integrated', () => ({
  useAuth: () => cookieAuthState,
}))

vi.mock('@/lib/api', () => ({
  apiClient: apiClientMock,
}))

vi.mock('@/lib/background-streams-context', () => ({
  useBackgroundStreams: () => backgroundStreams,
}))

vi.mock('@/lib/pending-messages', () => ({
  save: vi.fn(),
  clear: vi.fn(),
  retryAll: vi.fn().mockResolvedValue(undefined),
  subscribeOnlineRetry: vi.fn(() => () => {}),
}))

vi.mock('@/lib/dev-log', () => ({
  devLog: vi.fn(),
}))

vi.mock('@/lib/ai-service', () => ({
  aiService: {},
  buildProfessionalCapabilityPrompt: vi.fn(() => ''),
  shouldUseExistingDocumentFileContext: vi.fn(() => false),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

import { ChatProvider } from '@/lib/chat-context-integrated'

describe('ChatProvider cookie sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiClientMock.getAIModels.mockResolvedValue({
      models: [{ name: 'cookie-ready-model', provider: 'test' }],
    })
    apiClientMock.getChats.mockResolvedValue({
      chats: [],
      pagination: { page: 1, pages: 1, limit: 20, total: 0 },
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('initializes chat for an authenticated cookie session with no local JWT', async () => {
    render(
      <ChatProvider>
        <div>chat child</div>
      </ChatProvider>,
    )

    await waitFor(() => {
      expect(apiClientMock.getAIModels).toHaveBeenCalledWith('TEXT')
    })
    expect(apiClientMock.getChats).toHaveBeenCalledWith({ page: 1, limit: 20 })
  })
})
