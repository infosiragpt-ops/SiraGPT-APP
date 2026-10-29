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
const authState = vi.hoisted(() => ({
  user: { id: 'user-1', name: 'Ana', email: 'ana@example.com' },
  token: 'token-1',
  isAuthenticated: true,
}))

// Any apiClient method the provider touches resolves to {} unless a test
// sets it explicitly below.
const apiClientMock = vi.hoisted(() => new Proxy({} as Record<string, any>, {
  get(target, prop: string) {
    if (!(prop in target)) target[prop] = vi.fn(async () => ({}))
    return target[prop]
  },
}))

vi.mock('@/lib/auth-context-integrated', () => ({
  useAuth: () => authState,
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
import { toast } from 'sonner'

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
  const view = render(
    <ChatProvider>
      <Probe />
    </ChatProvider>,
  )
  await flush(50)
  await act(async () => {
    probe.ctx.setCurrentChat({ ...CHAT, messages: [] })
  })
  await flush(10)
  return view
}

const MEDIA_HANDOFF = { id: 'handoff-1', chatId: CHAT.id, role: 'ASSISTANT', content: 'Te aviso aquí.', metadata: {
  mediaDeliveryHandoff: 'md_delivery', transcriptionFileIds: ['video-1'], stoppedReason: 'media_delivery_handoff',
} }
const MEDIA_DELIVERED = { id: 'delivery-1', chatId: CHAT.id, role: 'ASSISTANT', content: 'Transcripción completa.', metadata: {
  source: 'media-delivery', mediaDelivery: 'md_delivery', transcriptionFileIds: ['video-1'], artifacts: [{ filename: 'transcripcion.txt' }],
} }
const mediaReads = () => apiClientMock.getChat.mock.calls.filter((args: any[]) => args[1]?.signal)

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
    authState.isAuthenticated = true
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

  it.each(['persisted-object', 'persisted-json', 'live-envelope'])(
    'refreshes a durable transcription handoff (%s) without deleting messages or starting a second job',
    async (shape) => {
      await mount()
      const handoffMetadata = { mediaDeliveryHandoff: 'md_12345678-1234-1234-1234-123456789abc', stoppedReason: 'media_delivery_handoff' }
      const handoff = {
        id: 'handoff-1', chatId: CHAT.id, role: 'ASSISTANT',
        content: shape === 'live-envelope'
          ? '```agent-task-state\n' + JSON.stringify({ done: true, stoppedReason: 'media_delivery_handoff', finalText: 'Te aviso aquí.' }) + '\n```\nTe aviso aquí.'
          : 'Te aviso aquí.',
        metadata: shape === 'persisted-object' ? handoffMetadata : shape === 'persisted-json' ? JSON.stringify(handoffMetadata) : undefined,
      }
      const messages = [
        { id: 'user-1', chatId: CHAT.id, role: 'USER', content: 'Transcribe ambos videos', files: [{ id: 'video-1' }, { id: 'video-2' }] },
        handoff,
        { id: 'user-2', chatId: CHAT.id, role: 'USER', content: 'Conserva las marcas de tiempo' },
        { id: 'answer-2', chatId: CHAT.id, role: 'ASSISTANT', content: 'De acuerdo.' },
      ]
      const draft = [{ id: 'draft-file', name: 'siguiente.docx' }]
      await act(async () => {
        probe.ctx.setCurrentChat({ ...CHAT, messages })
        probe.ctx.setUploadedFiles(draft)
      })
      apiClientMock.getChat.mockClear()
      await act(async () => { await probe.ctx.regenerateMessage(handoff.id) })
      expect(apiClientMock.getChat).toHaveBeenCalledWith(CHAT.id)
      expect(apiClientMock.clearMessageById).not.toHaveBeenCalled()
      expect(apiClientMock.generateAIStream).not.toHaveBeenCalled()
      expect(probe.ctx.currentChat.messages).toHaveLength(messages.length)
      expect(probe.ctx.currentChat.messages).toMatchObject(messages)
      expect(probe.ctx.uploadedFiles).toEqual(draft)
    },
  )

  it('loads the finished transcript from the same chat instead of regenerating its handoff', async () => {
    await mount()
    const messages = [
      { id: 'user-1', chatId: CHAT.id, role: 'USER', content: 'Transcribe el video' },
      { id: 'handoff-1', chatId: CHAT.id, role: 'ASSISTANT', content: 'Te aviso aquí.', metadata: { mediaDeliveryHandoff: 'md_delivery' } },
    ]
    const delivered = { id: 'delivery-1', chatId: CHAT.id, role: 'ASSISTANT', content: 'Transcripción completa.',
      files: [{ id: 'transcript-1', name: 'transcripcion.txt' }], metadata: { source: 'media-delivery', mediaDelivery: 'md_delivery' } }
    await act(async () => { probe.ctx.setCurrentChat({ ...CHAT, messages }) })
    apiClientMock.getChat.mockResolvedValueOnce({ chat: { ...CHAT, messages: [...messages, delivered] } })
    await act(async () => { await probe.ctx.regenerateMessage('handoff-1') })
    expect(probe.ctx.currentChat.messages.map((message: any) => message.id)).toEqual(['user-1', 'handoff-1', 'delivery-1'])
    expect(probe.ctx.currentChat.messages[2].files).toEqual(delivered.files)
    expect(apiClientMock.clearMessageById).not.toHaveBeenCalled()
    expect(apiClientMock.generateAIStream).not.toHaveBeenCalled()
  })

  it.each(['persisted-object', 'persisted-json', 'live-envelope'] as const)(
    'automatically receives a durable transcript after the stream has closed (%s)',
    async (shape) => {
      await mount()
      const handoffMetadata = { mediaDeliveryHandoff: 'md_delivery', transcriptionFileIds: ['video-1'], stoppedReason: 'media_delivery_handoff' }
      const messages = [
        { id: 'user-1', chatId: CHAT.id, role: 'USER', content: 'Transcribe el video' },
        { id: 'handoff-1', chatId: CHAT.id, role: 'ASSISTANT', content: shape === 'live-envelope'
          ? '```agent-task-state\n' + JSON.stringify({ done: true, ...handoffMetadata, finalText: 'Te aviso aquí.' }) + '\n```\nTe aviso aquí.'
          : 'Te aviso aquí.', metadata: shape === 'live-envelope' ? undefined
            : shape === 'persisted-json' ? JSON.stringify(handoffMetadata) : handoffMetadata },
      ]
      // Real media-delivery messages keep artifacts in metadata, not files.
      const delivered = { id: 'delivery-1', chatId: CHAT.id, role: 'ASSISTANT', content: 'Transcripción completa.', metadata: {
        source: 'media-delivery', mediaDelivery: 'md_delivery', transcriptionFileIds: ['video-1'],
        artifacts: [{ id: 'transcript-1', filename: 'transcripcion.txt', url: '/api/artifacts/transcript-1' }],
      } }
      const optimistic = { id: 'msg-user-followup', chatId: CHAT.id, role: 'USER', content: 'Conserva las marcas de tiempo' }
      const draft = [{ id: 'draft-file', name: 'siguiente.docx' }]
      await act(async () => {
        probe.ctx.setCurrentChat({ ...CHAT, messages: [...messages, optimistic] })
        probe.ctx.setUploadedFiles(draft)
      })
      apiClientMock.getChat.mockClear()
      apiClientMock.getChat.mockResolvedValue({ chat: { ...CHAT, messages } })
      await flush(30_000)
      expect(apiClientMock.getChat).toHaveBeenCalledTimes(1)
      apiClientMock.getChat.mockResolvedValue({ chat: { ...CHAT, messages: [...messages, delivered] } })
      await flush(30_000)
      expect(probe.ctx.currentChat.messages).toEqual(expect.arrayContaining([delivered, optimistic]))
      expect(probe.ctx.uploadedFiles).toEqual(draft)
      expect(apiClientMock.clearMessageById).not.toHaveBeenCalled()
      expect(apiClientMock.generateAIStream).not.toHaveBeenCalled()
      apiClientMock.getChat.mockClear()
      await flush(120_000)
      expect(apiClientMock.getChat).not.toHaveBeenCalled()
    },
  )

  it('keeps refreshing a batch until every transcription file has a terminal delivery', async () => {
    await mount()
    const messages = [
      { id: 'user-1', chatId: CHAT.id, role: 'USER', content: 'Transcribe ambos videos' },
      { id: 'handoff-1', chatId: CHAT.id, role: 'ASSISTANT', content: 'Te aviso aquí.', metadata: {
        mediaDeliveryHandoff: 'md_first', transcriptionFileIds: ['video-1', 'video-2'], stoppedReason: 'media_delivery_handoff',
      } },
    ]
    const delivered = (id: string, fileId: string, reason: string) => ({ id, chatId: CHAT.id, role: 'ASSISTANT', content: reason,
      metadata: { source: 'media-delivery', mediaDelivery: id, transcriptionFileIds: [fileId], stoppedReason: reason } })
    const first = delivered('md_first', 'video-1', 'transcription_completed')
    const second = delivered('md_second', 'video-2', 'transcription_failed')
    await act(async () => { probe.ctx.setCurrentChat({ ...CHAT, messages }) })
    apiClientMock.getChat.mockClear()
    apiClientMock.getChat.mockResolvedValue({ chat: { ...CHAT, messages: [...messages, first] } })
    await flush(30_000)
    expect(probe.ctx.currentChat.messages).toContainEqual(first)
    apiClientMock.getChat.mockResolvedValue({ chat: { ...CHAT, messages: [...messages, first, second] } })
    await flush(30_000)
    expect(apiClientMock.getChat).toHaveBeenCalledTimes(2)
    expect(probe.ctx.currentChat.messages).toContainEqual(second)
    apiClientMock.getChat.mockClear()
    await flush(120_000)
    expect(apiClientMock.getChat).not.toHaveBeenCalled()
  })

  it('pauses hidden chats, ignores the cancelled response and resumes when visible', async () => {
    await mount()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => { probe.ctx.setCurrentChat({ ...CHAT, messages: [MEDIA_HANDOFF] }) })
    await flush(60_000)
    expect(mediaReads()).toHaveLength(0)
    visibility.mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    let release!: (response: any) => void
    apiClientMock.getChat.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await flush(30_000)
    expect(mediaReads()).toHaveLength(1)
    await flush(90_000)
    expect(mediaReads()).toHaveLength(1) // A slow read never overlaps another.
    visibility.mockReturnValue('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(mediaReads()[0][1].signal.aborted).toBe(true)
    await act(async () => { release({ chat: { ...CHAT, messages: [MEDIA_HANDOFF, MEDIA_DELIVERED] } }) })
    expect(probe.ctx.currentChat.messages).toEqual([MEDIA_HANDOFF])
    visibility.mockReturnValue('visible')
    apiClientMock.getChat.mockResolvedValue({ chat: { ...CHAT, messages: [MEDIA_HANDOFF, MEDIA_DELIVERED] } })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush(30_000)
    expect(probe.ctx.currentChat.messages).toContainEqual(MEDIA_DELIVERED)
  })

  it.each(['navigate', 'logout', 'unmount'] as const)('cancels media refresh ownership on %s', async (action) => {
    const view = await mount()
    await act(async () => { probe.ctx.setCurrentChat({ ...CHAT, messages: [MEDIA_HANDOFF] }) })
    let release!: (response: any) => void
    apiClientMock.getChat.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await flush(30_000)
    const signal = mediaReads()[0][1].signal
    const other = { id: 'other-chat', title: 'Otro', messages: [] }
    await act(async () => {
      if (action === 'navigate') probe.ctx.setCurrentChat(other)
      if (action === 'logout') {
        authState.isAuthenticated = false
        view.rerender(<ChatProvider><Probe /></ChatProvider>)
      }
      if (action === 'unmount') view.unmount()
    })
    expect(signal.aborted).toBe(true)
    await act(async () => { release({ chat: { ...CHAT, messages: [MEDIA_HANDOFF, MEDIA_DELIVERED] } }) })
    await flush(120_000)
    expect(mediaReads()).toHaveLength(1)
    if (action === 'navigate') expect(probe.ctx.currentChat).toEqual(other)
    if (action === 'logout') expect(probe.ctx.currentChat?.messages || []).not.toContainEqual(MEDIA_DELIVERED)
  })

  it('does not let a late refresh interrupt a new streamed reply, and resumes after it closes', async () => {
    await mount()
    await act(async () => { probe.ctx.setCurrentChat({ ...CHAT, messages: [MEDIA_HANDOFF] }) })
    let release!: (response: any) => void
    apiClientMock.getChat.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await flush(30_000)
    const signal = mediaReads()[0][1].signal
    let finish!: () => Promise<void>
    apiClientMock.generateAIStream.mockImplementationOnce(async (_data: any, onData: any, onClose: any) => new Promise<void>(resolve => {
      finish = async () => { onData('Respuesta nueva'); await onClose(); resolve() }
    }))
    let turn!: Promise<void>
    await act(async () => { turn = probe.ctx.addMessage('También conserva las marcas', [], probe.ctx.currentChat, false, 'text') })
    expect(signal.aborted).toBe(true)
    await act(async () => { release({ chat: { ...CHAT, messages: [MEDIA_HANDOFF, MEDIA_DELIVERED] } }) })
    await flush(60_000)
    expect(mediaReads()).toHaveLength(1)
    expect(probe.ctx.currentChat.messages).not.toContainEqual(MEDIA_DELIVERED)
    expect(probe.ctx.currentChat.messages.some((message: any) => message.content === 'También conserva las marcas')).toBe(true)
    await act(async () => { await finish(); await turn })
    apiClientMock.getChat.mockResolvedValue({ chat: { ...CHAT, messages: [MEDIA_HANDOFF, MEDIA_DELIVERED] } })
    await flush(30_000)
    expect(probe.ctx.currentChat.messages).toContainEqual(MEDIA_DELIVERED)
    expect(probe.ctx.currentChat.messages.some((message: any) => message.content === 'También conserva las marcas')).toBe(true)
    expect(probe.ctx.currentChat.messages.some((message: any) => message.content === 'Respuesta nueva')).toBe(true)
  })

  it('waits through hours of legitimate processing without resubmitting a transcription', async () => {
    await mount()
    await act(async () => { probe.ctx.setCurrentChat({ ...CHAT, messages: [MEDIA_HANDOFF] }) })
    await flush(3 * 60 * 60_000)
    expect(mediaReads()).toHaveLength(360)
    expect(apiClientMock.generateAIStream).not.toHaveBeenCalled()
    apiClientMock.getChat.mockResolvedValue({ chat: { ...CHAT, messages: [MEDIA_HANDOFF, MEDIA_DELIVERED] } })
    await flush(30_000)
    expect(probe.ctx.currentChat.messages).toContainEqual(MEDIA_DELIVERED)
  })

  it.each(['server-error', 'invalid-shape'] as const)('backs off %s and recovers without requiring user activity', async (failure) => {
    await mount()
    await act(async () => { probe.ctx.setCurrentChat({ ...CHAT, messages: [MEDIA_HANDOFF] }) })
    if (failure === 'server-error') apiClientMock.getChat.mockRejectedValue(Object.assign(new Error('offline'), { status: 500 }))
    else apiClientMock.getChat.mockResolvedValue({ chat: { id: 'unexpected-chat', messages: [] } })
    await flush(30_000)
    expect(mediaReads()).toHaveLength(1)
    await flush(60_000)
    expect(mediaReads()).toHaveLength(2)
    await flush(270_000)
    expect(mediaReads()).toHaveLength(5)
    apiClientMock.getChat.mockResolvedValue({ chat: { ...CHAT, messages: [MEDIA_HANDOFF, MEDIA_DELIVERED] } })
    await flush(120_000)
    expect(probe.ctx.currentChat.messages).toContainEqual(MEDIA_DELIVERED)
    expect(apiClientMock.generateAIStream).not.toHaveBeenCalled()
  })

  it.each([401, 403, 404, 410])('stops automatic refresh after a terminal HTTP %s response', async (status) => {
    await mount()
    await act(async () => { probe.ctx.setCurrentChat({ ...CHAT, messages: [MEDIA_HANDOFF] }) })
    apiClientMock.getChat.mockRejectedValue(Object.assign(new Error('unavailable'), { status }))
    await flush(5 * 60_000)
    expect(mediaReads()).toHaveLength(1)
  })

  it('keeps the handoff and later turns if its refresh fails', async () => {
    await mount()
    const messages = [
      { id: 'user-1', chatId: CHAT.id, role: 'USER', content: 'Transcribe el video' },
      { id: 'handoff-1', chatId: CHAT.id, role: 'ASSISTANT', content: 'Te aviso aquí.', metadata: { mediaDeliveryHandoff: 'md_delivery' } },
      { id: 'user-2', chatId: CHAT.id, role: 'USER', content: 'Gracias' },
    ]
    await act(async () => { probe.ctx.setCurrentChat({ ...CHAT, messages }) })
    apiClientMock.getChat.mockRejectedValueOnce(new Error('offline'))
    await act(async () => { await probe.ctx.regenerateMessage('handoff-1') })
    expect(probe.ctx.currentChat.messages).toEqual(messages)
    expect(apiClientMock.clearMessageById).not.toHaveBeenCalled()
    expect(apiClientMock.generateAIStream).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('No se pudo actualizar'))
  })

  it('coalesces repeated handoff refreshes and never replaces a different selected chat', async () => {
    await mount()
    const messages = [
      { id: 'user-1', chatId: CHAT.id, role: 'USER', content: 'Transcribe el video' },
      { id: 'handoff-1', chatId: CHAT.id, role: 'ASSISTANT', content: 'Te aviso aquí.', metadata: { mediaDeliveryHandoff: 'md_delivery' } },
    ]
    await act(async () => { probe.ctx.setCurrentChat({ ...CHAT, messages }) })
    let release!: (response: any) => void
    apiClientMock.getChat.mockClear()
    apiClientMock.getChat.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    let first!: Promise<void>
    let second!: Promise<void>
    await act(async () => {
      first = probe.ctx.regenerateMessage('handoff-1')
      second = probe.ctx.regenerateMessage('handoff-1')
    })
    expect(apiClientMock.getChat).toHaveBeenCalledTimes(1)
    const otherChat = { id: 'chat-2', title: 'Otro chat', messages: [] }
    await act(async () => { probe.ctx.setCurrentChat(otherChat) })
    await act(async () => { release({ chat: { ...CHAT, messages } }); await Promise.all([first, second]) })
    expect(probe.ctx.currentChat).toEqual(otherChat)
    expect(apiClientMock.clearMessageById).not.toHaveBeenCalled()
    expect(apiClientMock.generateAIStream).not.toHaveBeenCalled()
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
