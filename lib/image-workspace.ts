import { normalizeBackendAssetUrl, resolveImageAttachmentUrl } from './attachment-url'
import type { ImageViewerAsset } from '@/components/ui/image-modal'

export type WorkspaceImage = ImageViewerAsset & {
  model?: string
  provider?: string
  quality?: string
  aspectRatio?: string
  version?: number
  rootFileId?: string
  comments?: Array<{ id: string; text: string; x: number; y: number }>
}

export function imageAssetsFromMessages(messages: any[], chatId?: string): WorkspaceImage[] {
  const assets: WorkspaceImage[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    let files = message?.files
    try { if (typeof files === 'string') files = JSON.parse(files) } catch { files = [] }
    if (!Array.isArray(files)) continue
    for (const file of files) {
      if (!file || file.deletedAt || !(file.type === 'image' || /^image\//.test(file.mimeType || file.mime || file.type || ''))) continue
      const asset = imageAssetFromFile(file, message.chatId || chatId, message.id)
      if (!asset.url || seen.has(asset.id)) continue
      seen.add(asset.id)
      assets.push(asset)
    }
  }
  return assets
}

export function imageAssetFromFile(file: any, chatId?: string, messageId?: string): WorkspaceImage {
  // An edit must read the persisted original, never a smaller preview. The
  // normalizer also repairs legacy /uploads URLs that contain an internal host.
  const url = normalizeBackendAssetUrl(resolveImageAttachmentUrl({
    ...file,
    imageUrl: file.url || file.imageUrl || file.downloadUrl || file.download_url,
  }))
  const artifact = url.match(/\/api\/agent\/artifact\/([a-f0-9]{6,64})(?:[/?#]|$)/i)?.[1]
  const fileId = file.fileId || (artifact ? `artifact:${artifact}` : file.id)
  return {
    id: String(fileId || `${messageId || 'image'}:${url}`),
    fileId: fileId ? String(fileId) : undefined,
    url,
    name: file.originalName || file.filename || file.name || 'Imagen.png',
    // The message containing the asset is authoritative, including a newly
    // saved version whose embedded metadata still mentions its original chat.
    chatId: chatId || file.chatId,
    messageId: messageId || file.messageId,
    width: file.width,
    height: file.height,
    parentFileId: file.parentFileId,
    rootFileId: file.rootFileId,
    version: file.version,
    model: file.model,
    provider: file.provider,
    quality: file.quality,
    aspectRatio: file.aspectRatio || file.aspect_ratio,
    comments: file.comments || [],
  }
}

/** Model identity is binding; a missing/inactive choice never picks a replacement. */
export function resolveImageWorkspaceModel(asset: WorkspaceImage, selected?: { name: string; provider: string }) {
  const name = String(selected ? selected.name : asset.model || '').trim()
  const provider = String(selected ? selected.provider : asset.provider || '').trim()
  if (!name || !provider) throw new Error('Selecciona un modelo en Imágenes dentro del chat original para editar esta imagen.')
  return { model: name, provider }
}

export function imageOriginalChatHref(asset: Pick<WorkspaceImage, 'chatId' | 'messageId'>) {
  if (!asset.chatId) return null
  const params = new URLSearchParams({ id: asset.chatId })
  if (asset.messageId) params.set('message', asset.messageId)
  return `/agentes?${params}`
}
