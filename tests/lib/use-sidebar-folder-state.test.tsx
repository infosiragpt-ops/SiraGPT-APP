import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useSidebarFolderState } from '@/lib/use-sidebar-folder-state'
import { emptySidebarFolderState, serializeSidebarFolderState, sidebarFolderCacheKey, sidebarFolderMigrationLedgerKey, SIDEBAR_FOLDER_MIGRATION_KEY, SIDEBAR_FOLDER_SETTINGS_KEY as KEY } from '@/lib/sidebar-folder-state'
import { CHAT_FOLDERS_STORAGE_KEY } from '@/lib/sidebar-chat-folders'

const api = vi.hoisted(() => ({ getUserSettings: vi.fn(), updateUserSettings: vi.fn() }))
vi.mock('@/lib/api', () => ({ apiClient: api }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function settings(name?: string) {
  return { settings: { [KEY]: serializeSidebarFolderState({ ...emptySidebarFolderState(), names: name ? [name] : [] }) } }
}
async function drain() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); localStorage.clear(); api.updateUserSettings.mockResolvedValue({ success: true }) })
afterEach(() => { vi.useRealTimers() })

describe('useSidebarFolderState account synchronization', () => {
  it('migrates a verified legacy chat from a later page after a zero-match first page', async () => {
    localStorage.setItem(CHAT_FOLDERS_STORAGE_KEY, JSON.stringify({ later: 'Legacy' }))
    api.getUserSettings.mockResolvedValueOnce({ settings: {} })
    const { result, rerender } = renderHook(({ ids }) => useSidebarFolderState('A', ids), { initialProps: { ids: ['first-page'] } })
    await drain()
    expect(result.current.state.assignments).toEqual({})
    expect(api.updateUserSettings).not.toHaveBeenCalled()
    rerender({ ids: ['first-page', 'later'] })
    await drain()
    expect(result.current.state.assignments).toEqual({ later: 'Legacy' })
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(JSON.parse(localStorage.getItem(sidebarFolderMigrationLedgerKey('A'))!)).toEqual(['later'])
  })

  it('imports newly verified IDs for the same owner without resurrecting a removed assignment after reload', async () => {
    localStorage.setItem(CHAT_FOLDERS_STORAGE_KEY, JSON.stringify({ old: 'Old', later: 'Later' }))
    api.getUserSettings.mockResolvedValueOnce({ settings: {} })
    const first = renderHook(() => useSidebarFolderState('A', ['old']))
    await drain()
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(first.result.current.state.assignments).toEqual({ old: 'Old' })
    act(() => first.result.current.update(() => emptySidebarFolderState()))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    first.unmount()

    api.getUserSettings.mockResolvedValueOnce(settings())
    const second = renderHook(() => useSidebarFolderState('A', ['old', 'later']))
    await drain()
    expect(second.result.current.state.assignments).toEqual({ later: 'Later' })
    expect(second.result.current.state.names).toEqual(['Later'])
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(JSON.parse(localStorage.getItem(sidebarFolderMigrationLedgerKey('A'))!)).toEqual(['old', 'later'])
    expect(JSON.parse(localStorage.getItem(SIDEBAR_FOLDER_MIGRATION_KEY)!)).toBe('A')
  })

  it('does not resurrect a migrated assignment removed before its first successful upload', async () => {
    localStorage.setItem(CHAT_FOLDERS_STORAGE_KEY, JSON.stringify({ old: 'Old' }))
    api.getUserSettings.mockResolvedValueOnce({ settings: {} })
    api.updateUserSettings.mockRejectedValueOnce(new Error('offline'))
    const first = renderHook(() => useSidebarFolderState('A', ['old']))
    await drain()
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    act(() => first.result.current.update(() => emptySidebarFolderState()))
    first.unmount()

    api.getUserSettings.mockResolvedValueOnce({ settings: {} })
    const second = renderHook(() => useSidebarFolderState('A', ['old']))
    await drain()
    expect(second.result.current.state.assignments).toEqual({})
    expect(second.result.current.state.names).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(JSON.parse(localStorage.getItem(sidebarFolderMigrationLedgerKey('A'))!)).toEqual(['old'])
  })

  it('recovers and saves a pending browser draft after reload when the remote base is unchanged', async () => {
    const base = settings('Anterior')["settings"][KEY]
    const draft = settings('Borrador pendiente')["settings"][KEY]
    localStorage.setItem(sidebarFolderCacheKey('A'), JSON.stringify({ snapshot: draft, pending: true, base }))
    api.getUserSettings.mockResolvedValueOnce({ settings: { [KEY]: base } })
    const { result } = renderHook(() => useSidebarFolderState('A', []))
    await drain()
    expect(result.current.state.names).toEqual(['Borrador pendiente'])
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(api.updateUserSettings).toHaveBeenCalledWith({ [KEY]: draft })
    expect(JSON.parse(localStorage.getItem(sidebarFolderCacheKey('A'))!).pending).toBe(false)
  })

  it('preserves a conflicting local draft and waits for explicit retry before saving it', async () => {
    const base = settings('Anterior')["settings"][KEY]
    const draft = settings('Borrador pendiente')["settings"][KEY]
    localStorage.setItem(sidebarFolderCacheKey('A'), JSON.stringify({ snapshot: draft, pending: true, base }))
    api.getUserSettings.mockResolvedValueOnce(settings('Desde otro dispositivo'))
    const { result } = renderHook(() => useSidebarFolderState('A', []))
    await drain()
    expect(result.current.state.names).toEqual(['Borrador pendiente'])
    expect(result.current.error).toContain('otra versión')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(api.updateUserSettings).not.toHaveBeenCalled()
    act(() => result.current.retry())
    await drain()
    expect(api.updateUserSettings).toHaveBeenCalledWith({ [KEY]: draft })
    expect(result.current.error).toBe(null)
  })

  it('does not write an empty initial state or accept edits before hydration', async () => {
    const read = deferred<ReturnType<typeof settings>>()
    api.getUserSettings.mockReturnValueOnce(read.promise)
    const { result } = renderHook(() => useSidebarFolderState('A', []))
    act(() => result.current.update(state => ({ ...state, names: ['Too early'] })))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(api.updateUserSettings).not.toHaveBeenCalled()
    expect(result.current.ready).toBe(false)
    await act(async () => { read.resolve(settings('Servidor')) })
    expect(result.current.state.names).toEqual(['Servidor'])
    expect(result.current.ready).toBe(true)
    expect(api.updateUserSettings).not.toHaveBeenCalled()
  })

  it('ignores a late account A response after switching to account B', async () => {
    const a = deferred<ReturnType<typeof settings>>()
    const b = deferred<ReturnType<typeof settings>>()
    api.getUserSettings.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const { result, rerender } = renderHook(({ user }) => useSidebarFolderState(user, []), { initialProps: { user: 'A' } })
    rerender({ user: 'B' })
    await act(async () => { b.resolve(settings('Cuenta B')) })
    await act(async () => { a.resolve(settings('Cuenta A')) })
    expect(result.current.state.names).toEqual(['Cuenta B'])
    expect(api.updateUserSettings).not.toHaveBeenCalled()
  })

  it('serializes requests so edits during an in-flight save are sent after it', async () => {
    api.getUserSettings.mockResolvedValueOnce(settings())
    const firstSave = deferred<{ success: boolean }>()
    api.updateUserSettings.mockReturnValueOnce(firstSave.promise).mockResolvedValueOnce({ success: true })
    const { result } = renderHook(() => useSidebarFolderState('A', []))
    await drain()
    act(() => result.current.update(state => ({ ...state, names: ['Primera'] })))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(api.updateUserSettings).toHaveBeenCalledTimes(1)
    act(() => result.current.update(state => ({ ...state, names: ['Última'] })))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(api.updateUserSettings).toHaveBeenCalledTimes(1)
    await act(async () => { firstSave.resolve({ success: true }) })
    expect(api.updateUserSettings).toHaveBeenCalledTimes(2)
    expect(api.updateUserSettings.mock.calls[1][0][KEY].folders[0].name).toBe('Última')
    expect(result.current.state.names).toEqual(['Última'])
    expect(result.current.saving).toBe(false)
  })

  it('persists clears as arrays so backend deep-merge removes folders', async () => {
    api.getUserSettings.mockResolvedValueOnce(settings('Eliminar'))
    const { result } = renderHook(() => useSidebarFolderState('A', []))
    await drain()
    act(() => result.current.update(() => emptySidebarFolderState()))
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(api.updateUserSettings.mock.calls[0][0][KEY]).toEqual({ version: 1, folders: [], assignments: [], unreadIds: [], sections: [], chatSections: [] })
  })

  it('leaves failed hydration read-only and reloads on retry', async () => {
    api.getUserSettings.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(settings('Recuperado'))
    const { result } = renderHook(() => useSidebarFolderState('A', []))
    await drain()
    expect(result.current.ready).toBe(false)
    expect(result.current.error).toContain('No se pudieron cargar')
    act(() => result.current.update(() => emptySidebarFolderState()))
    expect(api.updateUserSettings).not.toHaveBeenCalled()
    act(() => result.current.retry())
    await drain()
    expect(result.current.ready).toBe(true)
    expect(result.current.state.names).toEqual(['Recuperado'])
    expect(result.current.error).toBe(null)
  })
})
