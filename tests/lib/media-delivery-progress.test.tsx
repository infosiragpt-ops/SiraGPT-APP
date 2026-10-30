import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getFilesProcessingStatus: vi.fn() }))
vi.mock('@/lib/api', () => ({ apiClient: api }))

import { useMediaDeliveryProgress } from '@/hooks/use-media-delivery-progress'
import { pendingMediaDeliveries, type MediaDeliveryMessage } from '@/lib/media-delivery-refresh'

const handoff = (files = ['audio-1']) => ({
  id: 'handoff-1', role: 'ASSISTANT', content: 'Te aviso aquí.',
  metadata: { mediaDeliveryHandoff: 'md_current', transcriptionFileIds: files, stoppedReason: 'media_delivery_handoff' },
})
const delivery = {
  id: 'delivered-1', role: 'ASSISTANT', content: 'Transcripción terminada.',
  metadata: { source: 'media-delivery', mediaDelivery: 'md_current', transcriptionFileIds: ['audio-1'] },
}
const options = (messages: MediaDeliveryMessage[] = [handoff()]) => ({ chatId: 'chat-1', ownerId: 'user-1', enabled: true, messages })
const progress = (percent: unknown = 67) => ({ files: [{ id: 'audio-1', processingStage: 'extracting',
  processingProgress: { stage: 'transcribing', percent, etaSeconds: 60 } }] })
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const visible = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  api.getFilesProcessingStatus.mockReset().mockResolvedValue(progress())
  visible('visible')
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('durable transcription progress after reload', () => {
  it.each(['object', 'json', 'envelope'])('rehydrates the same job from persisted %s and reads server progress on remount', async shape => {
    const message = handoff()
    const metadata = message.metadata
    const messages = [{ ...message,
      content: shape === 'envelope' ? '```agent-task-state\n' + JSON.stringify({ done: true, meta: metadata }) + '\n```' : message.content,
      metadata: shape === 'json' ? JSON.stringify(metadata) : shape === 'envelope' ? undefined : metadata,
    }]
    const props = { ...options(), messages }
    expect(pendingMediaDeliveries(messages)).toEqual([{ messageId: 'handoff-1', deliveryId: 'md_current', fileIds: ['audio-1'], sourceFileIds: ['audio-1'] }])
    const first = renderHook(() => useMediaDeliveryProgress(props))
    expect(first.result.current['handoff-1']).toMatchObject({ label: 'Recuperando estado del trabajo…', percent: null })
    await flush()
    expect(first.result.current['handoff-1']).toMatchObject({ pending: true, stage: 'transcribing', percent: 67 })
    expect(first.result.current['handoff-1'].label).toContain('67 %')
    first.unmount()
    const remounted = renderHook(() => useMediaDeliveryProgress(props))
    await flush()
    expect(api.getFilesProcessingStatus.mock.calls.map(call => call[0])).toEqual([['audio-1'], ['audio-1']])
    expect(remounted.result.current['handoff-1'].percent).toBe(67)
    expect(Object.keys(api)).toEqual(['getFilesProcessingStatus'])
  })

  it('keeps ready source pending until its actual delivery message arrives', async () => {
    api.getFilesProcessingStatus.mockResolvedValue({ files: [{ id: 'audio-1', processingStage: 'ready' }] })
    const hook = renderHook(props => useMediaDeliveryProgress(props), { initialProps: options() })
    await flush()
    expect(hook.result.current['handoff-1']).toMatchObject({ pending: true, label: 'Esperando el resultado…', percent: null })
    await flush(120_000)
    expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(1)
    hook.rerender(options([handoff(), delivery]))
    expect(hook.result.current).toEqual({})
    await flush(120_000)
    expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(1)
  })

  it('does not average unlike recordings or stop when only one batch source finishes', async () => {
    api.getFilesProcessingStatus.mockResolvedValue({ files: [
      { id: 'audio-1', processingStage: 'ready' },
      { id: 'audio-2', processingStage: 'extracting', processingProgress: { percent: 80 } },
    ] })
    const hook = renderHook(() => useMediaDeliveryProgress(options([handoff(['audio-1', 'audio-2'])])))
    await flush()
    expect(hook.result.current['handoff-1']).toMatchObject({ label: 'Transcribiendo 2 archivos…', percent: null })
    await flush(5_000)
    expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(2)
  })

  it('uses bounded unique batches and refuses unrelated or missing response rows', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `audio-${index}`)
    api.getFilesProcessingStatus.mockImplementation(async () => ({ files: [{ id: 'not-requested', processingStage: 'ready' }] }))
    const hook = renderHook(() => useMediaDeliveryProgress(options([handoff([...ids, ids[0]])])))
    await flush()
    expect(api.getFilesProcessingStatus.mock.calls.map(call => call[0].length)).toEqual([50, 1])
    expect(new Set(api.getFilesProcessingStatus.mock.calls.flatMap(call => call[0])).size).toBe(51)
    expect(hook.result.current['handoff-1']).toMatchObject({ label: 'Estado del trabajo no disponible.', stage: 'unavailable', percent: null })
  })

  it.each([null, undefined, 'unknown'])('does not claim transcription for an unrecognized stage %s', async processingStage => {
    api.getFilesProcessingStatus.mockResolvedValue({ files: [{ id: 'audio-1', processingStage }] })
    const hook = renderHook(() => useMediaDeliveryProgress(options()))
    await flush()
    expect(hook.result.current['handoff-1']).toMatchObject({ label: 'Estado del trabajo no disponible.', stage: 'unavailable', percent: null })
  })

  it('keeps reading a pending concurrent job when another delivery covered its same source', async () => {
    const messages = [handoff(), { ...handoff(), id: 'handoff-2', metadata: { ...handoff().metadata, mediaDeliveryHandoff: 'md_second' } }, delivery]
    const hook = renderHook(() => useMediaDeliveryProgress(options(messages)))
    await flush()
    expect(hook.result.current['handoff-1']).toBeUndefined()
    expect(hook.result.current['handoff-2']).toMatchObject({ percent: 67, stage: 'transcribing' })
    expect(api.getFilesProcessingStatus).toHaveBeenCalledWith(['audio-1'], { signal: expect.any(AbortSignal) })
  })

  it('serializes slow reads, aborts on hide and ignores a late hidden response', async () => {
    let release!: (body: unknown) => void
    api.getFilesProcessingStatus.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const hook = renderHook(() => useMediaDeliveryProgress(options()))
    await flush()
    await flush(120_000)
    expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(1)
    act(() => visible('hidden'))
    expect(api.getFilesProcessingStatus.mock.calls[0][1].signal.aborted).toBe(true)
    await act(async () => { release(progress(99)) })
    expect(hook.result.current['handoff-1'].percent).toBe(null)
    await flush(60_000)
    expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(1)
    act(() => visible('visible'))
    await flush()
    expect(hook.result.current['handoff-1'].percent).toBe(67)
    hook.unmount()
    await flush(60_000)
    expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(2)
  })

  it('does not fetch while hidden and resumes immediately on focus or connectivity', async () => {
    visible('hidden')
    renderHook(() => useMediaDeliveryProgress(options()))
    await flush(30_000)
    expect(api.getFilesProcessingStatus).not.toHaveBeenCalled()
    act(() => visible('visible'))
    await flush()
    expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(1)
    act(() => window.dispatchEvent(new Event('online')))
    await flush()
    expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(2)
  })

  it('never leaks stale progress across chats, owners or logout', async () => {
    let release!: (body: unknown) => void
    api.getFilesProcessingStatus.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const hook = renderHook(props => useMediaDeliveryProgress(props), { initialProps: options() })
    await flush()
    hook.rerender({ ...options(), chatId: 'chat-2', ownerId: 'user-2' })
    expect(api.getFilesProcessingStatus.mock.calls[0][1].signal.aborted).toBe(true)
    await act(async () => { release(progress(99)) })
    expect(hook.result.current['handoff-1'].percent).toBe(null)
    await flush()
    expect(hook.result.current['handoff-1'].percent).toBe(67)
    hook.rerender({ ...options(), enabled: false })
    expect(hook.result.current).toEqual({})
    const calls = api.getFilesProcessingStatus.mock.calls.length
    await flush(60_000)
    expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(calls)
  })

  it('keeps read failures distinct from completed or cancelled jobs and can recover', async () => {
    api.getFilesProcessingStatus.mockRejectedValueOnce(Object.assign(new Error('temporary'), { status: 503 }))
    const hook = renderHook(() => useMediaDeliveryProgress(options()))
    await flush()
    expect(hook.result.current['handoff-1']).toMatchObject({ pending: true, stage: 'unavailable', percent: null })
    await flush(5_000)
    expect(hook.result.current['handoff-1'].percent).toBe(67)
    api.getFilesProcessingStatus.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }))
    await flush(5_000)
    expect(hook.result.current['handoff-1'].stage).toBe('unavailable')
    await flush(120_000)
    expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(3)
  })

  it('backs off failed status reads up to one minute and resets after recovery', async () => {
    api.getFilesProcessingStatus.mockRejectedValue(Object.assign(new Error('temporary'), { status: 503 }))
    const hook = renderHook(() => useMediaDeliveryProgress(options()))
    await flush()
    let calls = 1
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      await flush(delay - 1)
      expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(calls)
      await flush(1)
      expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(++calls)
    }
    api.getFilesProcessingStatus.mockResolvedValue(progress())
    await flush(60_000)
    expect(hook.result.current['handoff-1'].percent).toBe(67)
    expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(++calls)
    await flush(15_000)
    expect(api.getFilesProcessingStatus).toHaveBeenCalledTimes(++calls)
  })

  it.each([null, undefined, '67', Number.NaN])('does not invent a percentage from %s', async percent => {
    const response = progress()
    response.files[0].processingProgress.percent = percent
    api.getFilesProcessingStatus.mockResolvedValue(response)
    const hook = renderHook(() => useMediaDeliveryProgress(options()))
    await flush()
    expect(hook.result.current['handoff-1'].percent).toBe(null)
  })

  it('ignores user-shaped handoffs and calls no endpoint without valid references', async () => {
    const user = { ...handoff(), role: 'USER' }
    const hook = renderHook(() => useMediaDeliveryProgress(options([user])))
    await flush(30_000)
    expect(hook.result.current).toEqual({})
    expect(api.getFilesProcessingStatus).not.toHaveBeenCalled()
  })
})
