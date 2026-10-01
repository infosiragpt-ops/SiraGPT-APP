/**
 * Behaviour test (real ChatProvider + real lib/pending-messages): a failed
 * generate turn has ONE retry path. After a retryable failure the durable
 * draft replays automatically — unless the user already took over with
 * «Reintentar» (regenerate) or sent a newer message; then the old key is
 * never POSTed again (no second answer to the same prompt, no out-of-order
 * answer).
 */
import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type StreamCall = {
  data: Record<string, any>
  onData: (chunk: string) => void
  onClose: () => void | Promise<void>
  onError: (error: Error) => void
}

const streamCalls: StreamCall[] = []
const streamBehaviour = vi.hoisted(() => ({
  next: [] as Array<'fail-retryable' | 'succeed'>,
}))

const probe = vi.hoisted(() => ({ ctx: null as any }))

// Any apiClient method the provider touches resolves to {} unless a test
// sets it explicitly below.
const apiClientMock = vi.hoisted(() => new Proxy({} as Record<string, any>, {
  get(target, prop: string) {
    if (!(prop in target)) target[prop] = vi.fn(async () => ({}))
    return target[prop]
  },
}))

vi.mock('@/lib/auth-context-integrated', () => ({
  useAuth: () => ({
    user: { id: 'user-1', name: 'Ana', email: 'ana@example.com' },
    token: 'token-1',
    isAuthenticated: true,
  }),
}))

vi.mock('@/lib/api', () => ({ apiClient: apiClientMock }))

vi.mock('@/lib/background-streams-context', () => ({
  useBackgroundStreams: () => ({
    register: vi.fn(),
    appendChunk: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    cancel: vi.fn(),
    get: vi.fn(() => undefined),
  }),
}))

vi.mock('@/lib/ai-service', () => ({
  aiService: { classifyIntent: vi.fn(async () => 'text') },
  buildProfessionalCapabilityPrompt: vi.fn(() => ''),
  isLightweightConversationalPrompt: vi.fn(() => false),
  shouldUseExistingDocumentFileContext: vi.fn(() => false),
}))

vi.mock('@/lib/dev-log', () => ({ devLog: vi.fn() }))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { ChatProvider, useChat } from '@/lib/chat-context-integrated'
import * as pending from '@/lib/pending-messages'
import { GENERATE_ERROR_COPY } from '@/lib/generate-retry-policy'

const CHAT = { id: 'chat-1', title: 'Chat', messages: [] as any[] }

function Probe() {
  probe.ctx = useChat()
  return null
}

function retryableTransportError(): Error {
  // Shape delivered by lib/api.ts after its own retry budget ran out.
  return Object.assign(new Error(GENERATE_ERROR_COPY.transport), {
    kind: 'transport',
    retryable: true,
    retryAfterMs: null,
  })
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function mount() {
  render(
    <ChatProvider>
      <Probe />
    </ChatProvider>,
  )
  await flush(50)
  await act(async () => {
    probe.ctx.setCurrentChat({ ...CHAT, messages: [] })
  })
  await flush(10)
}

function postsFor(key: string): StreamCall[] {
  return streamCalls.filter((call) => call.data.idempotencyKey === key)
}

describe('ChatProvider: one retry path per failed turn', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    localStorage.clear()
    streamCalls.length = 0
    streamBehaviour.next = []
    probe.ctx = null
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    apiClientMock.getAIModels = vi.fn(async () => ({
      models: [{ name: 'deepseek-v4-flash', provider: 'DeepSeek', type: 'TEXT' }],
    }))
    apiClientMock.getChats = vi.fn(async () => ({
      chats: [{ ...CHAT }],
      pagination: { page: 1, pages: 1, limit: 20, total: 1 },
    }))
    apiClientMock.getChat = vi.fn(async () => ({ chat: probe.ctx?.currentChat || { ...CHAT } }))
    apiClientMock.isGenerateTurnInFlight = vi.fn(() => false)
    apiClientMock.clearMessageById = vi.fn(async () => ({}))
    apiClientMock.generateAIStream = vi.fn(async (
      data: Record<string, any>,
      onData: StreamCall['onData'],
      onClose: StreamCall['onClose'],
      onError: StreamCall['onError'],
    ) => {
      streamCalls.push({ data, onData, onClose, onError })
      const behaviour = streamBehaviour.next.shift() || 'succeed'
      if (behaviour === 'fail-retryable') {
        onError(retryableTransportError())
        return
      }
      onData('respuesta')
      await onClose()
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps a newly attached draft file when GitHub resumes automatically', async () => {
    await mount()
    const draft = { id: 'draft-upload', name: 'borrador.xlsx', uploading: true }
    await act(async () => { probe.ctx.setUploadedFiles([draft]) })
    await act(async () => {
      await probe.ctx.addMessage('GitHub conectado. Retoma la tarea pendiente.', [], { ...CHAT }, false, 'text', {
        idempotencyKey: 'github-handoff-resume', preserveComposerAttachments: true,
      })
    })
    expect(probe.ctx.uploadedFiles).toEqual([draft])
    expect(streamCalls).toHaveLength(1)
    expect(JSON.stringify(streamCalls[0].data)).not.toContain('draft-upload')
  })

  it('still clears submitted composer files for an ordinary user message', async () => {
    await mount()
    await act(async () => { probe.ctx.setUploadedFiles([{ id: 'draft-upload', name: 'borrador.xlsx' }]) })
    await act(async () => { await probe.ctx.addMessage('Hola', [], { ...CHAT }, false, 'text') })
    expect(probe.ctx.uploadedFiles).toEqual([])
  })

  it('control: a retryable failure left alone is replayed once, with the same key', async () => {
    await mount()
    streamBehaviour.next = ['fail-retryable', 'succeed']

    await act(async () => {
      await probe.ctx.addMessage('Hola', [], { ...CHAT, messages: [] }, false, 'text')
    })
    expect(streamCalls).toHaveLength(1)
    const key = streamCalls[0].data.idempotencyKey
    expect(pending.getTurn(CHAT.id, key, 'user-1')).toMatchObject({ retryPolicy: 'automatic' })

    // The automatic replay waits at least 30 s, then runs from the heartbeat.
    await flush(20_000)
    expect(postsFor(key)).toHaveLength(1)
    await flush(50_000)

    expect(postsFor(key)).toHaveLength(2)
    expect(pending.getTurn(CHAT.id, key, 'user-1')).toBeUndefined()
  })

  it('«Reintentar» (regenerate) owns the failed turn: the old key is never POSTed again', async () => {
    await mount()
    streamBehaviour.next = ['fail-retryable', 'succeed']

    await act(async () => {
      await probe.ctx.addMessage('Hola', [], { ...CHAT, messages: [] }, false, 'text')
    })
    const key = streamCalls[0].data.idempotencyKey
    const failed = probe.ctx.currentChat.messages.find((m: any) => m.role === 'ASSISTANT')
    expect(failed?.error).toBeTruthy()

    // The user presses «Reintentar» on the red bubble before the replay.
    await act(async () => {
      await probe.ctx.regenerateMessage(failed.id)
    })
    expect(streamCalls).toHaveLength(2)
    expect(streamCalls[1].data.regenerate).toBe(true)
    expect(pending.getTurn(CHAT.id, key, 'user-1')).toBeUndefined()

    // Well past the 30-60 s replay window: no second answer to «Hola».
    await flush(120_000)
    expect(postsFor(key)).toHaveLength(1)
    expect(streamCalls).toHaveLength(2)
  })

  it('a replay is skipped when another answer already follows the turn (draft left behind)', async () => {
    await mount()
    streamBehaviour.next = ['fail-retryable', 'succeed']

    await act(async () => {
      await probe.ctx.addMessage('Hola', [], { ...CHAT, messages: [] }, false, 'text')
    })
    const key = streamCalls[0].data.idempotencyKey
    // Simulate a regeneration that answered the turn in another way (e.g. a
    // tab whose draft survived): the conversation already has a reply.
    await act(async () => {
      probe.ctx.setCurrentChat((prev: any) => ({
        ...prev,
        messages: [
          ...prev.messages.filter((m: any) => m.role === 'USER'),
          { id: 'ai-regen-x', chatId: CHAT.id, role: 'ASSISTANT', content: 'otra respuesta', metadata: JSON.stringify({ regeneration: { attempt: 1 } }) },
        ],
      }))
    })

    await flush(120_000)
    expect(postsFor(key)).toHaveLength(1)
    expect(pending.getTurn(CHAT.id, key, 'user-1')).toBeUndefined()
  })

  it('a newer message supersedes the failed turn: it is never answered after it', async () => {
    await mount()
    streamBehaviour.next = ['fail-retryable', 'succeed']

    await act(async () => {
      await probe.ctx.addMessage('Primera', [], { ...CHAT, messages: [] }, false, 'text')
    })
    const oldKey = streamCalls[0].data.idempotencyKey

    await act(async () => {
      await probe.ctx.addMessage('Segunda', [], probe.ctx.currentChat, false, 'text')
    })
    expect(streamCalls).toHaveLength(2)
    const newKey = streamCalls[1].data.idempotencyKey
    expect(newKey).not.toBe(oldKey)
    expect(pending.getTurn(CHAT.id, oldKey, 'user-1')).toMatchObject({ terminalKind: 'superseded' })

    await flush(120_000)
    expect(postsFor(oldKey)).toHaveLength(1)
    expect(streamCalls).toHaveLength(2)
  })
})
