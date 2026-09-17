"use client"

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ImageModal, type ImageViewerEditRequest } from '@/components/ui/image-modal'
import { apiClient } from '@/lib/api'
import { authenticatedFetch } from '@/lib/authenticated-fetch'
import { downloadBlob } from '@/lib/utils'
import { imageAssetsFromMessages, imageOriginalChatHref, resolveImageWorkspaceModel, type WorkspaceImage } from '@/lib/image-workspace'

interface ImageWorkspaceProps {
  assets: WorkspaceImage[]
  initialAssetId: string
  selectedModel?: { name: string; provider: string }
  onClose: () => void
  onChanged?: () => void | Promise<void>
  onViewChat?: (asset: WorkspaceImage) => void
}

/** Both entry points use the same source-bound requests and persisted versions. */
export default function ImageWorkspace({ assets, initialAssetId, selectedModel, onClose, onChanged, onViewChat }: ImageWorkspaceProps) {
  const router = useRouter()
  const [images, setImages] = useState(assets)
  const [activeId, setActiveId] = useState(initialAssetId)
  const inFlight = useRef(false)
  const hiddenIds = useRef(new Set<string>())
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    setImages(previous => {
      const next = new Map(assets.filter(asset => !hiddenIds.current.has(asset.id)).map(asset => [asset.id, asset]))
      // A server reload can arrive before the new version's message is visible.
      for (const asset of previous) if (!next.has(asset.id) && !hiddenIds.current.has(asset.id)) next.set(asset.id, asset)
      return [...next.values()]
    })
  }, [assets])

  const changed = async () => { try { await onChanged?.() } catch { /* persisted result stays visible */ } }
  const persist = async (asset: WorkspaceImage, edit: ImageViewerEditRequest) => {
    if (inFlight.current) throw new Error('Espera a que termine la edición actual.')
    if (!asset.fileId || !asset.chatId) throw new Error('Abre el chat original para recuperar la referencia de esta imagen.')
    inFlight.current = true
    try {
      let response: any
      if (edit.operation === 'annotate' || edit.operation === 'comment' || (edit.operation === 'resize' && edit.width && edit.height)) {
        response = await apiClient.saveImageAsset(asset.fileId, {
          chatId: asset.chatId, messageId: asset.messageId,
          operation: edit.operation as 'annotate' | 'comment' | 'resize',
          sourceImageDataUrl: edit.sourceImageDataUrl, comments: edit.comments,
          width: edit.width, height: edit.height,
        })
      } else {
        const choice = resolveImageWorkspaceModel(asset, selectedModel)
        response = await apiClient.generateImage({
          ...choice, chatId: asset.chatId, fileId: asset.fileId,
          operation: edit.operation === 'resize' ? 'reframe' : 'edit',
          prompt: edit.prompt,
          aspectRatio: edit.aspectRatio || (/^(1:1|3:4|4:3|9:16|16:9)$/.test(asset.aspectRatio || '') ? asset.aspectRatio : undefined),
          background: edit.operation === 'remove-background' ? 'transparent' : undefined,
          quality: edit.quality || asset.quality,
          imageCount: 1, selection: edit.selection, maskDataUrl: edit.maskDataUrl,
        })
        if (!response?.files?.length && response?.recoveredFromChat) {
          // Recovery currently supplies only a boolean. A previous edit of
          // this parent would also match a library lookup, so it cannot prove
          // that THIS request completed. Refresh the host, never invent success
          // or automatically issue another paid generation.
          await changed()
          throw new Error('La conexión se interrumpió y no se pudo identificar el resultado de esta edición. Revisa el chat original antes de volver a generar para evitar duplicados.')
        }
      }
      if (!response?.files?.length) throw new Error('La edición no devolvió un archivo verificable. Revisa el chat antes de reintentar.')
      const results = imageAssetsFromMessages([{
        chatId: response.chatId || asset.chatId,
        id: response.messageId || (edit.operation === 'comment' ? asset.messageId : undefined),
        files: response.files.map((file: any) => {
          const previous = images.find(item => item.fileId === (file.fileId || file.id))
          // Comment responses may return only changed metadata. Retain the
          // same asset's source/model identity without inheriting it for a new
          // version, whose identity must come from the generation result.
          return previous ? { ...previous, ...file } : file
        }),
      }]).filter(item => item.fileId && !hiddenIds.current.has(item.id))
      if (!results.length || (edit.operation === 'comment' && !results.some(item => item.id === asset.id))) {
        throw new Error('La edición no devolvió un archivo verificable. Revisa el chat antes de reintentar.')
      }
      if (alive.current) {
        setImages(previous => {
          const next = new Map(previous.map(item => [item.id, item]))
          for (const item of results) next.set(item.id, item)
          return [...next.values()]
        })
        setActiveId(edit.operation === 'comment' ? asset.id : results[0].id)
      }
      await changed()
    } finally { inFlight.current = false }
  }

  const readBlob = async (asset: WorkspaceImage) => {
    const response = await authenticatedFetch(asset.url, { credentials: 'include' })
    if (!response.ok) throw new Error('No se pudo descargar esta imagen.')
    const blob = await response.blob()
    if (!blob.type.startsWith('image/')) throw new Error('El archivo recibido no es una imagen.')
    return blob
  }

  return <ImageModal
    isOpen onClose={onClose}
    images={images}
    selectedIndex={Math.max(0, images.findIndex(asset => asset.id === activeId))}
    onSelect={index => setActiveId(images[index].id)}
    onEdit={persist}
    onDownload={async asset => downloadBlob(await readBlob(asset), asset.name || 'Imagen.png')}
    onShare={async asset => {
      const blob = await readBlob(asset)
      const file = new File([blob], asset.name || 'Imagen.png', { type: blob.type })
      if (!navigator.share || !navigator.canShare?.({ files: [file] })) throw new Error('Este navegador no permite compartir archivos. Usa Descargar para compartir la imagen.')
      try { await navigator.share({ files: [file], title: asset.name }) } catch (error: any) {
        if (error?.name !== 'AbortError') throw new Error('No se pudo compartir la imagen.')
      }
    }}
    onDelete={async asset => {
      if (!asset.fileId || !asset.chatId || !asset.messageId) throw new Error('No se pudo identificar la imagen que quieres eliminar.')
      await apiClient.hideImageAsset(asset.fileId, { chatId: asset.chatId, messageId: asset.messageId })
      hiddenIds.current.add(asset.id)
      const remaining = images.filter(item => item.id !== asset.id)
      setImages(remaining)
      if (!remaining.length) onClose()
      else setActiveId(remaining[0].id)
      await changed()
    }}
    onViewChat={asset => {
      if (onViewChat) { onViewChat(asset); return }
      const href = imageOriginalChatHref(asset)
      if (!href) throw new Error('Esta imagen no tiene un chat de origen disponible.')
      onClose()
      router.push(href)
    }}
  />
}
