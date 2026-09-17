import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ props: null as any, generate: vi.fn(), save: vi.fn(), hide: vi.fn(), push: vi.fn() }))
vi.mock('@/components/ui/image-modal', () => ({ ImageModal: (props: any) => { mocks.props = props; return <div data-testid="image-workspace" /> } }))
vi.mock('@/lib/api', () => ({ apiClient: { generateImage: mocks.generate, saveImageAsset: mocks.save, hideImageAsset: mocks.hide } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
import ImageWorkspace from '@/components/images/ImageWorkspace'

const beach = { id: 'beach', fileId: 'beach', url: '/beach.png', name: 'Playa.png', chatId: 'chat', messageId: 'm1', model: 'original', provider: 'OpenAI', aspectRatio: '16:9' }
beforeEach(() => vi.clearAllMocks())

describe('image workspace integration', () => {
  it('edits the selected source with the selected model and opens the saved version', async () => {
    mocks.generate.mockResolvedValue({ chatId: 'chat', messageId: 'm2', files: [{ type: 'image', fileId: 'portrait', parentFileId: 'beach', url: '/portrait.png' }] })
    render(<ImageWorkspace assets={[beach]} initialAssetId="beach" selectedModel={{ name: 'picked', provider: 'OpenRouter' }} onClose={vi.fn()} />)
    await act(() => mocks.props.onEdit(beach, { operation: 'resize', prompt: 'La misma playa vertical', aspectRatio: '3:4', quality: '2K' }))
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'beach', operation: 'reframe', model: 'picked', provider: 'OpenRouter', aspectRatio: '3:4' }))
    expect(mocks.props.images[mocks.props.selectedIndex]).toMatchObject({ fileId: 'portrait', parentFileId: 'beach', messageId: 'm2' })
    expect(mocks.props.images[0].fileId).toBe('beach')
  })

  it('persists comments without spending an image generation', async () => {
    const comments = [{ id: 'note', text: 'Mantener el horizonte', x: 50, y: 30 }]
    mocks.save.mockResolvedValue({ chatId: 'chat', messageId: 'm1', files: [{ ...beach, type: 'image', comments }] })
    render(<ImageWorkspace assets={[beach]} initialAssetId="beach" onClose={vi.fn()} />)
    await act(() => mocks.props.onEdit(beach, { operation: 'comment', prompt: '', comments }))
    expect(mocks.save).toHaveBeenCalledWith('beach', expect.objectContaining({ operation: 'comment', messageId: 'm1', comments }))
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.props.images).toHaveLength(1)
  })

  it('rejects missing source before calling generation', async () => {
    render(<ImageWorkspace assets={[beach]} initialAssetId="beach" onClose={vi.fn()} />)
    await expect(mocks.props.onEdit({ ...beach, fileId: undefined }, { prompt: 'Vertical' })).rejects.toThrow(/referencia/)
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('does not fabricate a new version after a provider failure', async () => {
    mocks.generate.mockRejectedValue(new Error('El modelo elegido no está disponible'))
    render(<ImageWorkspace assets={[beach]} initialAssetId="beach" onClose={vi.fn()} />)
    await act(async () => { await expect(mocks.props.onEdit(beach, { prompt: 'Vertical' })).rejects.toThrow(/modelo elegido/) })
    expect(mocks.generate).toHaveBeenCalledTimes(1)
    expect(mocks.props.images).toEqual([beach])
  })

  it('removes only the selected asset after the server confirms', async () => {
    mocks.hide.mockResolvedValue({ ok: true })
    const mountain = { ...beach, id: 'mountain', fileId: 'mountain' }
    render(<ImageWorkspace assets={[beach, mountain]} initialAssetId="beach" onClose={vi.fn()} />)
    await act(() => mocks.props.onDelete(beach))
    await waitFor(() => expect(mocks.props.images).toEqual([mountain]))
    expect(mocks.hide).toHaveBeenCalledWith('beach', { chatId: 'chat', messageId: 'm1' })
  })

  it('does not mistake an earlier child image for a recovered edit without a request identity', async () => {
    mocks.generate.mockResolvedValue({ recoveredFromChat: true })
    const previousVersion = { ...beach, id: 'old-child', fileId: 'old-child', parentFileId: 'beach', messageId: 'm-old' }
    const onChanged = vi.fn()
    render(<ImageWorkspace assets={[beach, previousVersion]} initialAssetId="beach" onChanged={onChanged} onClose={vi.fn()} />)
    await act(async () => {
      await expect(mocks.props.onEdit(beach, { operation: 'edit', prompt: 'Una edición nueva' })).rejects.toThrow(/Revisa el chat original/)
    })
    expect(mocks.generate).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledOnce()
    expect(mocks.props.images).toEqual([beach, previousVersion])
    expect(mocks.props.images[mocks.props.selectedIndex].id).toBe('beach')
  })

  it('retains the source message on comments and never opens a document sibling as an image', async () => {
    mocks.save.mockResolvedValue({ files: [
      { type: 'document', fileId: 'report', url: '/report.pdf' },
      { type: 'image', fileId: 'beach', url: '/beach.png', comments: [{ id: 'note', x: 10, y: 20, text: 'Conservar' }] },
      { type: 'image', fileId: 'deleted', url: '/deleted.png', deletedAt: '2026-09-17' },
    ] })
    render(<ImageWorkspace assets={[beach]} initialAssetId="beach" onClose={vi.fn()} />)
    await act(() => mocks.props.onEdit(beach, { operation: 'comment', prompt: 'Conservar', comments: [] }))
    expect(mocks.props.images).toHaveLength(1)
    expect(mocks.props.images[0]).toMatchObject({ id: 'beach', fileId: 'beach', chatId: 'chat', messageId: 'm1', model: 'original', provider: 'OpenAI', name: 'Playa.png' })
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('does not fabricate a valid image from a malformed result', async () => {
    mocks.generate.mockResolvedValue({ files: [{ type: 'document', fileId: 'pdf', url: '/report.pdf' }] })
    render(<ImageWorkspace assets={[beach]} initialAssetId="beach" onClose={vi.fn()} />)
    await act(async () => { await expect(mocks.props.onEdit(beach, { prompt: 'Más luz' })).rejects.toThrow(/archivo verificable/) })
    expect(mocks.props.images).toEqual([beach])
  })

  it('does not resurrect a hidden image when an earlier library response arrives', async () => {
    mocks.hide.mockResolvedValue({ ok: true })
    const sibling = { ...beach, id: 'sibling', fileId: 'sibling' }
    const onClose = vi.fn()
    const { rerender } = render(<ImageWorkspace assets={[beach, sibling]} initialAssetId="beach" onClose={onClose} />)
    await act(() => mocks.props.onDelete(beach))
    rerender(<ImageWorkspace assets={[{ ...beach }, { ...sibling }]} initialAssetId="beach" onClose={onClose} />)
    expect(mocks.props.images).toEqual([sibling])
  })
})
