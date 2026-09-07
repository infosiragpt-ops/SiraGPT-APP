import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatFolderTree, type ChatFolderTreeProps } from '@/components/sidebar/chat-folder-tree'

const createProps = (): ChatFolderTreeProps => ({
  folders: [{ name: 'luis', isPinned: false, description: 'Investigación', location: '~/proyectos/luis' }, { name: 'Nueva', isPinned: false }],
  expandedFolders: ['luis', 'Nueva'],
  activeFolder: 'luis',
  onToggleExpand: vi.fn(), onTogglePin: vi.fn(), onEdit: vi.fn(), onNewChat: vi.fn(),
  onSendChat: vi.fn(), onDelete: vi.fn(), onDrop: vi.fn(),
  renderChats: (name) => <li><button>{name === 'luis' ? 'Buscar tesis peruanas' : 'Otra conversación'}</button></li>,
  getChatCount: (name) => name === 'luis' ? 1 : 0,
})

describe('ChatFolderTree interactions with real Radix components', () => {
  it('expands folders with keyboard and preserves an explicit empty state', async () => {
    const user = userEvent.setup()
    const props = createProps()
    const { rerender } = render(<ChatFolderTree {...props} />)
    expect(screen.getByRole('button', { name: 'Buscar tesis peruanas' })).toBeVisible()
    expect(screen.getByText('Sin chats')).toBeVisible()
    const trigger = screen.getByRole('button', { name: 'Contraer carpeta luis' })
    trigger.focus()
    await user.keyboard('{ArrowLeft}')
    expect(props.onToggleExpand).toHaveBeenCalledWith('luis')
    rerender(<ChatFolderTree {...props} expandedFolders={[]} />)
    expect(screen.queryByRole('button', { name: 'Buscar tesis peruanas' })).not.toBeInTheDocument()
    screen.getByRole('button', { name: 'Expandir carpeta luis' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(props.onToggleExpand).toHaveBeenCalledTimes(2)
  })

  it('opens project details, pins the folder, and edits without expanding it', async () => {
    const user = userEvent.setup()
    const props = createProps()
    render(<ChatFolderTree {...props} />)
    await user.click(screen.getByRole('button', { name: 'Opciones de la carpeta luis' }))
    expect(screen.getByRole('dialog', { name: 'luis' })).toBeVisible()
    expect(screen.getByText('1 tarea')).toBeVisible()
    expect(screen.getByText('~/proyectos/luis')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Fijar carpeta luis' }))
    expect(props.onTogglePin).toHaveBeenCalledWith('luis')
    await user.click(screen.getByRole('button', { name: 'Editar proyecto' }))
    expect(props.onEdit).toHaveBeenCalledWith('luis')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(props.onToggleExpand).not.toHaveBeenCalled()
  })

  it('routes new-chat, add-conversation and delete actions to their folder', async () => {
    const user = userEvent.setup()
    const props = createProps()
    render(<ChatFolderTree {...props} />)
    await user.click(screen.getByRole('button', { name: 'Nuevo chat en luis' }))
    expect(props.onNewChat).toHaveBeenCalledWith('luis')
    await user.click(screen.getByRole('button', { name: 'Opciones de la carpeta luis' }))
    await user.click(screen.getByRole('button', { name: 'Agregar conversación' }))
    expect(props.onSendChat).toHaveBeenCalledWith('luis')
    await user.click(screen.getByRole('button', { name: 'Opciones de la carpeta Nueva' }))
    await user.click(screen.getByRole('button', { name: 'Eliminar carpeta' }))
    expect(props.onDelete).toHaveBeenCalledWith('Nueva')
  })

  it('passes drop data to the folder handler and resets drag feedback', () => {
    const props = createProps()
    render(<ChatFolderTree {...props} />)
    const row = screen.getByRole('button', { name: 'Contraer carpeta luis' }).parentElement!
    const dataTransfer = { getData: vi.fn(() => 'siragpt-chat:chat1'), dropEffect: 'none' }
    fireEvent.dragEnter(row, { dataTransfer })
    expect(row.className).toContain('ring-inset')
    fireEvent.drop(row, { dataTransfer })
    expect(props.onDrop).toHaveBeenCalledWith(expect.objectContaining({ dataTransfer }), 'luis')
    expect(row.className).not.toContain('ring-inset')
  })
})
