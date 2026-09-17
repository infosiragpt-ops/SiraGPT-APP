import { describe, expect, it } from 'vitest'
import { imageAssetFromFile, imageAssetsFromMessages, imageOriginalChatHref, resolveImageWorkspaceModel } from '@/lib/image-workspace'

describe('image workspace source identity', () => {
  it('keeps the source, version and original message when opening multiple images', () => {
    const images = imageAssetsFromMessages([
      { id: 'm1', chatId: 'chat', files: JSON.stringify([{ type: 'image', fileId: 'beach', url: '/uploads/images/beach.png', model: 'picked', provider: 'OpenAI' }]) },
      { id: 'm2', chatId: 'chat', files: [{ type: 'image/png', fileId: 'portrait', parentFileId: 'beach', version: 2, url: '/uploads/images/portrait.png' }] },
    ])
    expect(images.map(image => image.fileId)).toEqual(['beach', 'portrait'])
    expect(images[1]).toMatchObject({ messageId: 'm2', chatId: 'chat', parentFileId: 'beach', version: 2 })
    expect(imageOriginalChatHref(images[1])).toBe('/agentes?id=chat&message=m2')
  })

  it('excludes removed assets without discarding their siblings', () => {
    expect(imageAssetsFromMessages([{ id: 'm', files: [
      { type: 'image', fileId: 'removed', url: '/removed.png', deletedAt: '2026-09-17' },
      { type: 'image', fileId: 'kept', url: '/kept.png' },
    ] }]).map(image => image.id)).toEqual(['kept'])
  })

  it('retains an agent artifact source instead of a display-only URL', () => {
    expect(imageAssetFromFile({ type: 'image', url: '/api/agent/artifact/abcdef012345' }, 'chat', 'm').fileId).toBe('artifact:abcdef012345')
  })

  it('honors a current selection and never replaces missing model information', () => {
    const asset = imageAssetFromFile({ fileId: 'source', url: '/source.png', model: 'original', provider: 'OpenAI' })
    expect(resolveImageWorkspaceModel(asset, { name: 'selected', provider: 'OpenRouter' })).toEqual({ model: 'selected', provider: 'OpenRouter' })
    expect(resolveImageWorkspaceModel(asset)).toEqual({ model: 'original', provider: 'OpenAI' })
    expect(() => resolveImageWorkspaceModel({ id: 'lost', url: '/lost.png', name: 'Lost' })).toThrow(/Selecciona un modelo/)
    expect(() => resolveImageWorkspaceModel(asset, { name: '', provider: 'OpenRouter' })).toThrow(/Selecciona un modelo/)
    expect(() => resolveImageWorkspaceModel(asset, { name: 'picked', provider: '' })).toThrow(/Selecciona un modelo/)
  })

  it('preserves library identity and uses its original bytes instead of its thumbnail', () => {
    const asset = imageAssetFromFile({
      type: 'image', fileId: 'original', id: 'display-row',
      url: '/uploads/original.png', preview: '/thumbs/small.png',
      chatId: 'stale-chat', messageId: 'stale-message',
      parentFileId: 'parent', rootFileId: 'root', version: 3,
    }, 'current-chat', 'current-message')
    expect(asset).toMatchObject({ id: 'original', fileId: 'original', chatId: 'current-chat', messageId: 'current-message', parentFileId: 'parent', rootFileId: 'root', version: 3 })
    expect(asset.url).toMatch(/\/uploads\/original\.png$/)
    expect(imageOriginalChatHref(asset)).toBe('/agentes?id=current-chat&message=current-message')
  })

  it('never truncates a non-artifact identifier into a different artifact', () => {
    expect(imageAssetFromFile({ url: '/api/agent/artifact/abcdefzzzzzz' }).fileId).toBeUndefined()
  })
})
