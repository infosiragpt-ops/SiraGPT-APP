import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOfficeDraft } from '@/lib/use-office-draft'

const state = vi.hoisted(() => ({
  chat: { id: 'chat-a', wordContent: 'original', excelContent: null } as any,
  save: vi.fn(), notify: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ apiClient: { saveOfficeDraft: (...args: any[]) => state.save(...args) } }))
vi.mock('@/lib/chat-context-integrated', () => ({ useChat: () => ({
  currentChat: state.chat,
  setCurrentChat: (update: any) => { state.chat = update(state.chat) },
}) }))
vi.mock('sonner', () => ({ toast: { error: (...args: any[]) => state.notify(...args) } }))

describe('native Office draft persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    state.chat = { id: 'chat-a', wordContent: 'original', excelContent: null }
    state.save.mockReset().mockResolvedValue({ saved: true })
    state.notify.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('debounces manual edits and restores the server-confirmed content after remount', async () => {
    const first = renderHook(() => useOfficeDraft('word'))
    act(() => { first.result.current.change('one'); first.result.current.change('two') })
    expect(first.result.current.status).toBe('unsaved')
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    expect(state.save).toHaveBeenCalledExactlyOnceWith('chat-a', 'word', 'two', 'original')
    expect(first.result.current.label).toBe('Guardado')
    first.unmount()
    const second = renderHook(() => useOfficeDraft('word'))
    act(() => { second.result.current.change('three') })
    await act(async () => { await second.result.current.save() })
    expect(state.save).toHaveBeenLastCalledWith('chat-a', 'word', 'three', 'two')
    second.unmount()
  })

  it('does not acknowledge failures or allow a close callback to claim a save', async () => {
    state.save.mockRejectedValue(new Error('conflict'))
    const { result, unmount } = renderHook(() => useOfficeDraft('word'))
    act(() => { result.current.change('unsaved') })
    let ok: boolean | undefined
    await act(async () => { ok = await result.current.save() })
    expect(ok).toBe(false)
    expect(result.current.label).toBe('No guardado')
    expect(state.chat.wordContent).toBe('original')
    state.save.mockResolvedValue({ saved: true })
    await act(async () => { expect(await result.current.save()).toBe(true) })
    unmount()
  })

  it('flushes navigation edits to the original chat without overwriting the new chat state', async () => {
    const { result, rerender, unmount } = renderHook(() => useOfficeDraft('word'))
    act(() => { result.current.change('edited-a') })
    state.chat = { id: 'chat-b', wordContent: 'b-original' }
    await act(async () => { rerender() })
    expect(state.save).toHaveBeenCalledWith('chat-a', 'word', 'edited-a', 'original')
    expect(state.chat.wordContent).toBe('b-original')
    act(() => { result.current.change('edited-b') })
    await act(async () => { await result.current.save() })
    expect(state.save).toHaveBeenLastCalledWith('chat-b', 'word', 'edited-b', 'b-original')
    unmount()
  })

  it('ignores a late save response after leaving and reopening the same chat', async () => {
    let finishOldSave!: () => void
    state.save.mockImplementationOnce(() => new Promise<void>((resolve) => { finishOldSave = resolve }))
    const { result, rerender, unmount } = renderHook(() => useOfficeDraft('word'))
    act(() => { result.current.change('first save') })
    let oldSave!: Promise<boolean>
    act(() => { oldSave = result.current.save() })
    state.chat = { id: 'chat-b', wordContent: 'other' }
    act(() => { rerender() })
    // The server applied the first save, but its HTTP response is delayed.
    state.chat = { id: 'chat-a', wordContent: 'first save' }
    act(() => { rerender(); })
    act(() => { result.current.change('newer save') })
    await act(async () => { await result.current.save() })
    act(() => { result.current.change('still typing') })
    await act(async () => { finishOldSave(); await oldSave })
    expect(state.chat.wordContent).toBe('newer save')
    expect(result.current.status).toBe('unsaved')
    unmount()
  })

  it.each(['word', 'excel'] as const)('uses a confirmed generated %s document as the next manual save baseline', async (kind) => {
    const generated = kind === 'word' ? '<p>Generado</p>' : { workbook: { sheets: [{ name: 'Generado' }] }, actions: [] }
    const edited = kind === 'word' ? '<p>Editado</p>' : { sheets: [{ name: 'Editado' }] }
    const { result, rerender, unmount } = renderHook(() => useOfficeDraft(kind))
    state.chat = { ...state.chat, [`${kind}Content`]: generated }
    act(() => { rerender() })
    act(() => { result.current.change(edited) })
    await act(async () => { await result.current.save() })
    expect(state.save).toHaveBeenCalledExactlyOnceWith('chat-a', kind, edited, generated)
    unmount()
  })
})
