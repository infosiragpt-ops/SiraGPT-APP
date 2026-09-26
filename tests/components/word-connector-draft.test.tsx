import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WordConnector } from '@/components/WordConnector'

const state = vi.hoisted(() => ({ chat: { id: 'word-chat', wordContent: '<p>Original</p>' } as any, editor: null as any, save: vi.fn() }))
vi.mock('@/lib/api', () => ({ apiClient: { saveOfficeDraft: (...args: any[]) => state.save(...args) } }))
vi.mock('@/lib/chat-context-integrated', () => ({ useChat: () => ({ currentChat: state.chat, setCurrentChat: (update: any) => { state.chat = update(state.chat) } }) }))
vi.mock('@/lib/auth-context-integrated', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('@tiptap/react', async (original) => {
  const tiptap = await original<typeof import('@tiptap/react')>()
  return { ...tiptap, useEditor: (...args: Parameters<typeof tiptap.useEditor>) => {
    const editor = tiptap.useEditor(...args)
    state.editor = editor
    return editor
  } }
})

describe('Word native draft persistence', () => {
  beforeEach(() => {
    state.chat = { id: 'word-chat', wordContent: '<p>Original</p>' }
    state.editor = null
    state.save.mockReset().mockResolvedValue({ saved: true })
  })
  afterEach(cleanup)

  it('hydrates and renders AI updates without saving them as manual edits', async () => {
    const ref = React.createRef<React.ComponentRef<typeof WordConnector>>()
    const view = render(<WordConnector ref={ref} onClose={() => {}} selectedModel="chosen" selectProvider="picked" />)
    await waitFor(() => expect(state.editor).not.toBeNull())
    act(() => { ref.current!.updateContent('<p>Original</p>') })
    view.rerender(<WordConnector ref={ref} onClose={() => {}} selectedModel="chosen" selectProvider="picked" isGeneratingExternal />)
    act(() => { ref.current!.updateContent('<p>Respuesta parcial de IA</p>') })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)) })
    expect(state.save).not.toHaveBeenCalled()
    expect(ref.current!.getHTML()).toContain('Respuesta parcial de IA')
  })

  it('saves native editor changes and waits for confirmation before closing', async () => {
    const ref = React.createRef<React.ComponentRef<typeof WordConnector>>()
    const close = vi.fn()
    render(<WordConnector ref={ref} onClose={close} selectedModel="chosen" selectProvider="picked" />)
    await waitFor(() => expect(state.editor).not.toBeNull())
    act(() => { ref.current!.updateContent('<p>Original</p>') })
    // Exercise the real TipTap document transaction and the rendered close action.
    act(() => { state.editor.commands.insertContent('<p>Cambio manual</p>') })
    let resolve!: () => void
    state.save.mockImplementation(() => new Promise<void>((done) => { resolve = done }))
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar', exact: true }))
    expect(close).not.toHaveBeenCalled()
    await waitFor(() => expect(state.save).toHaveBeenCalledOnce())
    expect(state.save.mock.calls[0]).toEqual(['word-chat', 'word', expect.stringContaining('Cambio manual'), '<p>Original</p>'])
    await act(async () => { resolve() })
    expect(close).toHaveBeenCalledOnce()
  })

  it('saves a finished rewrite of the selected text as a manual edit', async () => {
    const ref = React.createRef<React.ComponentRef<typeof WordConnector>>()
    render(<WordConnector ref={ref} onClose={() => {}} onTextSelected={() => {}} selectedModel="chosen" selectProvider="picked" />)
    await waitFor(() => expect(state.editor).not.toBeNull())
    act(() => {
      ref.current!.updateContent('<p>Original</p>')
      state.editor.commands.setTextSelection({ from: 1, to: 9 })
      ref.current!.replaceSelection('Corregido')
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Guardar documento', exact: true })) })
    expect(state.save).toHaveBeenCalledExactlyOnceWith('word-chat', 'word', expect.stringContaining('Corregido'), '<p>Original</p>')
  })
})
