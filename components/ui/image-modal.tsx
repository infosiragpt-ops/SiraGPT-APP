"use client"

/* eslint-disable @next/next/no-img-element -- Viewer uses original image pixels, arbitrary attachment URLs and canvas editing; Next image transforms would change the source. */

import * as React from "react"
import { createPortal } from "react-dom"
import { ArrowUp, Check, ChevronDown, Download, Eraser, MessageSquarePlus, Mic, MoreHorizontal, Pencil, RotateCcw, Scan, Share2, Trash2, Undo2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { getSpeechRecognitionCtor, resolveDictationLanguage } from "@/lib/chat/composer-dictation"
import { clampImagePan, imageFitScale, imagePoint, imageSelection, imageSelectionMask, rasterizeImageAnnotations, readImageViewerBlob, type ImageViewerComment, type ImageViewerPoint, type ImageViewerSelection, type ImageViewerStroke } from "@/lib/image-viewer"

export type { ImageViewerComment, ImageViewerSelection, ImageViewerStroke } from "@/lib/image-viewer"
export type ImageViewerOperation = "edit" | "erase" | "remove-background" | "resize" | "annotate" | "comment"
export type ImageViewerQuality = "1K" | "2K" | "4K"

export interface ImageViewerAsset {
  id: string
  url: string
  name: string
  chatId?: string
  messageId?: string
  fileId?: string
  width?: number
  height?: number
  parentFileId?: string
  rootFileId?: string
  model?: string
  provider?: string
  quality?: string
  aspectRatio?: string
  version?: number
  comments?: ImageViewerComment[]
}

export interface ImageViewerEditRequest {
  prompt: string
  operation?: ImageViewerOperation
  aspectRatio?: string
  quality?: ImageViewerQuality
  width?: number
  height?: number
  selection?: ImageViewerSelection
  /** PNG: transparent inside the edit selection, opaque outside. */
  maskDataUrl?: string
  /** Annotated original bytes. Persist as a new asset without AI regeneration. */
  sourceImageDataUrl?: string
  annotations?: ImageViewerStroke[]
  /** Comments are metadata and must not invoke image generation. */
  comments?: ImageViewerComment[]
}

export interface ImageModalProps {
  isOpen: boolean
  onClose: () => void
  imageUrl?: string
  altText?: string
  images?: ImageViewerAsset[]
  selectedIndex?: number
  onSelect?: (index: number) => void
  onEdit?: (asset: ImageViewerAsset, request: ImageViewerEditRequest) => void | Promise<void>
  onDownload?: (asset: ImageViewerAsset) => void | Promise<void>
  onShare?: (asset: ImageViewerAsset) => void | Promise<void>
  onDelete?: (asset: ImageViewerAsset) => void | Promise<void>
  onViewChat?: (asset: ImageViewerAsset) => void | Promise<void>
  onAddReference?: (asset: ImageViewerAsset) => void
  initialQuality?: ImageViewerQuality
  unavailableOperations?: Partial<Record<ImageViewerOperation, string>>
}

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]
const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]
const iconButton = "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-zinc-700 transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
const actionButton = "inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap rounded-full px-3 text-[13px] font-medium transition hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-40 sm:text-sm"
interface Draft { prompt: string; strokes: ImageViewerStroke[]; selection?: ImageViewerSelection; commentPoint?: ImageViewerPoint }
const EMPTY_DRAFT: Draft = { prompt: "", strokes: [] }
const qualityForAsset = (quality: string | undefined, fallback: ImageViewerQuality): ImageViewerQuality => quality === "1K" || quality === "2K" || quality === "4K" ? quality : fallback

/** Existing public entry point; imageUrl/altText callers remain supported. */
export function ImageModal(props: ImageModalProps) {
  if (!props.isOpen || typeof document === "undefined") return null
  const images = props.images?.length ? props.images : props.imageUrl ? [{ id: props.imageUrl, url: props.imageUrl, name: props.altText || "Imagen" }] : []
  if (!images.length) return null
  return createPortal(<ImageViewerSession {...props} images={images} />, document.body)
}

function ImageViewerSession({ images, selectedIndex, onSelect, onClose, onEdit, onDownload, onShare, onDelete, onViewChat, onAddReference, initialQuality = "2K", unavailableOperations }: ImageModalProps & { images: ImageViewerAsset[] }) {
  const [localIndex, setLocalIndex] = React.useState(selectedIndex ?? 0)
  const index = Math.max(0, Math.min(images.length - 1, selectedIndex ?? localIndex))
  const asset = images[index]
  const [mode, setMode] = React.useState<ImageViewerOperation>("edit")
  const [quality, setQuality] = React.useState<ImageViewerQuality>(() => qualityForAsset(asset.quality, initialQuality))
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({})
  const draft = drafts[asset.id] || EMPTY_DRAFT
  const [zoom, setZoom] = React.useState<number | "fit">("fit")
  const [pan, setPan] = React.useState<ImageViewerPoint>({ x: 0, y: 0 })
  const [viewport, setViewport] = React.useState({ width: 1, height: 1 })
  const [naturalSize, setNaturalSize] = React.useState({ width: asset.width || 0, height: asset.height || 0 })
  const [dimensions, setDimensions] = React.useState({ width: asset.width || 1024, height: asset.height || 1024 })
  const [aspectRatio, setAspectRatio] = React.useState<string>()
  const [menu, setMenu] = React.useState<"zoom" | "more" | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [feedback, setFeedback] = React.useState<{ text: string; error?: boolean } | null>(null)
  const [imageError, setImageError] = React.useState(false)
  const [recording, setRecording] = React.useState(false)
  const [comments, setComments] = React.useState<Record<string, ImageViewerComment[]>>({})
  const [annotationColor, setAnnotationColor] = React.useState("#f97316")
  const dialogRef = React.useRef<HTMLDivElement>(null)
  const closeRef = React.useRef<HTMLButtonElement>(null)
  const deleteRef = React.useRef<HTMLDivElement>(null)
  const moreRef = React.useRef<HTMLButtonElement>(null)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const imageRef = React.useRef<HTMLImageElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const gesture = React.useRef<{ kind: "pan" | "erase" | "annotate"; start: ImageViewerPoint; pan: ImageViewerPoint; pointerId: number } | null>(null)
  const speechRef = React.useRef<SpeechRecognition | null>(null)
  const busyRef = React.useRef(false)
  const mounted = React.useRef(true)
  const titleId = React.useId()
  const imageReady = naturalSize.width > 0 && naturalSize.height > 0 && !imageError
  const scale = zoom === "fit" ? imageFitScale(naturalSize.width, naturalSize.height, viewport.width, viewport.height) : zoom
  const displayedWidth = naturalSize.width * scale
  const displayedHeight = naturalSize.height * scale
  const savedComments = comments[asset.id] || asset.comments || []

  const updateDraft = React.useCallback((update: Partial<Draft> | ((previous: Draft) => Draft)) => {
    setDrafts(previous => {
      const current = previous[asset.id] || EMPTY_DRAFT
      return { ...previous, [asset.id]: typeof update === "function" ? update(current) : { ...current, ...update } }
    })
  }, [asset.id])

  React.useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    closeRef.current?.focus()
    mounted.current = true
    return () => {
      mounted.current = false
      document.body.style.overflow = previousOverflow
      speechRef.current?.abort()
      previousFocus?.focus?.()
    }
  }, [])

  React.useEffect(() => {
    setZoom("fit")
    setPan({ x: 0, y: 0 })
    setNaturalSize({ width: asset.width || 0, height: asset.height || 0 })
    setDimensions({ width: asset.width || 1024, height: asset.height || 1024 })
    setAspectRatio(undefined)
    setMode("edit")
    setMenu(null)
    setFeedback(null)
    setImageError(false)
    setConfirmDelete(false)
    gesture.current = null
    speechRef.current?.abort()
  }, [asset.id, asset.url, asset.width, asset.height])

  React.useEffect(() => { setQuality(qualityForAsset(asset.quality, initialQuality)) }, [asset.id, asset.quality, initialQuality])

  React.useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setViewport({ width: Math.max(1, rect.width - 32), height: Math.max(1, rect.height - 32) })
    }
    measure()
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null
    observer?.observe(element)
    window.addEventListener("resize", measure)
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure) }
  }, [])

  React.useEffect(() => { setPan(previous => clampImagePan(previous, displayedWidth, displayedHeight, viewport.width, viewport.height)) }, [displayedWidth, displayedHeight, viewport.width, viewport.height])

  const select = React.useCallback((next: number) => {
    if (busyRef.current || next < 0 || next >= images.length) return
    setLocalIndex(next)
    onSelect?.(next)
  }, [images.length, onSelect])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        if (confirmDelete) { setConfirmDelete(false); moreRef.current?.focus() }
        else if (menu) setMenu(null)
        else onClose()
        return
      }
      if (event.key === "Tab") {
        const scope = confirmDelete ? deleteRef.current : dialogRef.current
        const focusable = Array.from(scope?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]') || [])
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && (document.activeElement === first || !scope?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || !scope?.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
        return
      }
      const target = event.target as HTMLElement | null
      if (confirmDelete || target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === "ArrowLeft") { event.preventDefault(); select(index - 1) }
      if (event.key === "ArrowRight") { event.preventDefault(); select(index + 1) }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [confirmDelete, menu, onClose, index, select])

  React.useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setZoom(current => Math.min(2, Math.max(0.25, (current === "fit" ? scale : current) * Math.exp(-event.deltaY * 0.002))))
    }
    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [scale])

  const runAction = async (action: () => void | Promise<void>, success?: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setFeedback(null)
    try {
      await action()
      if (mounted.current && success) setFeedback({ text: success })
    } catch (error) {
      if (mounted.current) setFeedback({ text: error instanceof Error ? error.message : "No se pudo completar la acción. Inténtalo de nuevo.", error: true })
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const supports = (operation: ImageViewerOperation) => {
    const reason = unavailableOperations?.[operation] || (!onEdit ? "La edición no está disponible para esta imagen. Puedes descargarla y volver a adjuntarla en el chat." : null)
    if (reason) { setFeedback({ text: reason, error: true }); return false }
    return true
  }

  const activate = (next: ImageViewerOperation) => {
    if (!supports(next) || busy) return
    setFeedback(null)
    setMode(previous => previous === next ? "edit" : next)
    setMenu(null)
    if (next === "comment" || next === "edit") textareaRef.current?.focus()
  }

  const submit = async (operation = mode) => {
    if (!supports(operation) || !onEdit || busyRef.current) return
    const prompt = draft.prompt.trim()
    if ((operation === "edit" || operation === "comment") && !prompt) { textareaRef.current?.focus(); return }
    if (operation === "erase" && (!draft.selection || draft.selection.width < 0.5 || draft.selection.height < 0.5)) { setFeedback({ text: "Marca en la imagen la zona que quieres borrar.", error: true }); return }
    if (operation === "annotate" && !draft.strokes.length) { setFeedback({ text: "Dibuja sobre la imagen antes de guardar las anotaciones.", error: true }); return }
    if (!imageReady) { setFeedback({ text: "Espera a que termine de cargar la imagen.", error: true }); return }
    if (operation === "resize" && (!Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) || dimensions.width < 64 || dimensions.height < 64 || dimensions.width > 8192 || dimensions.height > 8192 || dimensions.width * dimensions.height > 16_777_216)) { setFeedback({ text: "Usa dimensiones entre 64 y 8192 píxeles, con un máximo de 16 megapíxeles.", error: true }); return }
    const target = asset
    await runAction(async () => {
      const request: ImageViewerEditRequest = { operation, quality, prompt }
      if (operation === "erase") {
        request.prompt = prompt || "Elimina el contenido de la zona seleccionada y reconstruye el fondo. Conserva intacto el resto de la imagen."
        request.selection = draft.selection
        request.maskDataUrl = imageSelectionMask(naturalSize.width, naturalSize.height, draft.selection!)
      } else if (operation === "remove-background") {
        request.prompt = "Quita el fondo y conserva el sujeto original con transparencia real."
      } else if (operation === "resize") {
        request.prompt = prompt || "Ajusta el tamaño conservando todo el contenido y sus proporciones."
        request.width = dimensions.width
        request.height = dimensions.height
        request.aspectRatio = aspectRatio || `${dimensions.width}:${dimensions.height}`
      } else if (operation === "annotate") {
        request.prompt = prompt || "Guardar una copia con las anotaciones."
        request.annotations = draft.strokes
        request.sourceImageDataUrl = await rasterizeImageAnnotations(target.url, draft.strokes)
      } else if (operation === "comment") {
        request.comments = [...savedComments, { id: globalThis.crypto?.randomUUID?.() || `comment-${Date.now()}`, text: prompt, ...(draft.commentPoint || { x: 50, y: 50 }) }]
      }
      await onEdit(target, request)
      if (!mounted.current) return
      if (request.comments) setComments(previous => ({ ...previous, [target.id]: request.comments! }))
      setDrafts(previous => ({ ...previous, [target.id]: EMPTY_DRAFT }))
      setMode("edit")
    }, operation === "comment" ? "Comentario guardado." : operation === "annotate" ? "Copia con anotaciones guardada." : undefined)
  }

  const startGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (busy || !imageReady || event.button !== 0) return
    const rect = imageRef.current?.getBoundingClientRect()
    if (!rect) return
    if (mode !== "edit" && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) return
    const point = imagePoint(event.clientX, event.clientY, rect)
    if (mode === "comment") { updateDraft({ commentPoint: point }); textareaRef.current?.focus(); return }
    const kind = mode === "annotate" ? "annotate" : mode === "erase" ? "erase" : "pan"
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    gesture.current = { kind, start: kind === "pan" ? { x: event.clientX, y: event.clientY } : point, pan, pointerId: event.pointerId }
    if (kind === "erase") updateDraft({ selection: { ...point, width: 0, height: 0 } })
    if (kind === "annotate") updateDraft(previous => ({ ...previous, strokes: [...previous.strokes, { points: [point], color: annotationColor, width: 0.3 }] }))
  }

  const moveGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = gesture.current
    if (!active || active.pointerId !== event.pointerId) return
    if (active.kind === "pan") { setPan(clampImagePan({ x: active.pan.x + event.clientX - active.start.x, y: active.pan.y + event.clientY - active.start.y }, displayedWidth, displayedHeight, viewport.width, viewport.height)); return }
    const rect = imageRef.current?.getBoundingClientRect()
    if (!rect) return
    const point = imagePoint(event.clientX, event.clientY, rect)
    if (active.kind === "erase") updateDraft({ selection: imageSelection(active.start, point) })
    else updateDraft(previous => ({ ...previous, strokes: previous.strokes.map((stroke, i) => i === previous.strokes.length - 1 ? { ...stroke, points: [...stroke.points, point] } : stroke) }))
  }

  const dictate = () => {
    if (recording) { speechRef.current?.stop(); return }
    const Ctor = getSpeechRecognitionCtor(window as unknown as Parameters<typeof getSpeechRecognitionCtor>[0])
    if (!Ctor) { setFeedback({ text: "El dictado no está disponible en este navegador. Puedes escribir la edición.", error: true }); return }
    try {
      const recognition = new Ctor() as SpeechRecognition
      const targetId = asset.id
      recognition.lang = resolveDictationLanguage({ language: navigator.language, languages: navigator.languages })
      recognition.interimResults = false
      recognition.onresult = event => {
        const transcript = Array.from(event.results).map(result => result[0].transcript).join(" ").trim()
        if (!transcript || !mounted.current) return
        setDrafts(previous => { const current = previous[targetId] || EMPTY_DRAFT; return { ...previous, [targetId]: { ...current, prompt: [current.prompt, transcript].filter(Boolean).join(" ") } } })
      }
      recognition.onend = () => { if (mounted.current) setRecording(false) }
      recognition.onerror = event => {
        if (!mounted.current || event.error === "aborted") return
        setRecording(false)
        setFeedback({ text: event.error === "not-allowed" ? "Permite el micrófono en tu navegador para dictar una edición." : "No se pudo escuchar el dictado. Vuelve a intentarlo o escribe la edición.", error: true })
      }
      speechRef.current = recognition
      recognition.start()
      setRecording(true)
    } catch { setFeedback({ text: "No se pudo iniciar el micrófono. Puedes escribir la edición.", error: true }) }
  }

  const download = () => runAction(async () => {
    if (onDownload) { await onDownload(asset); return }
    const url = URL.createObjectURL(await readImageViewerBlob(asset.url))
    const link = document.createElement("a")
    link.href = url
    link.download = asset.name || "imagen.png"
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1500)
  })

  const modeLabel = mode === "annotate" ? "Guardar anotaciones" : mode === "comment" ? "Guardar comentario" : mode === "resize" ? "Aplicar tamaño" : mode === "erase" ? "Borrar selección" : "Enviar edición"
  const modeHint = mode === "annotate" ? "Dibuja sobre la imagen. Se guardará una copia y conservarás el original." : mode === "comment" ? "Marca un punto y escribe tu comentario." : mode === "erase" ? "Arrastra sobre la zona que quieres borrar. El resto de la imagen se conserva." : mode === "resize" ? "Ajustar tamaño conserva todo el contenido; puede añadir transparencia para mantener las proporciones." : null

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="image-viewer" className="fixed inset-0 z-[10000] flex flex-col overflow-hidden bg-white text-zinc-900" style={{ height: "100dvh", colorScheme: "light" }} onClick={() => { if (menu) setMenu(null) }}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-100 px-2 sm:h-16 sm:gap-3 sm:px-5">
        <button ref={closeRef} type="button" className={iconButton} onClick={onClose} aria-label="Cerrar imagen"><X className="h-5 w-5" /></button>
        <span className="hidden text-sm text-zinc-400 sm:inline">Biblioteca</span><span className="hidden text-zinc-300 sm:inline">/</span>
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-medium">{asset.name}</h2>
        <button type="button" className="inline-flex h-10 items-center gap-2 rounded-full bg-zinc-950 px-3 text-sm font-medium text-white transition hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-40 sm:px-4" disabled={busy} onClick={() => onShare ? void runAction(() => onShare(asset)) : setFeedback({ text: "Esta imagen todavía no admite enlaces para compartir. Puedes descargarla.", error: true })} aria-label="Compartir imagen"><Share2 className="h-4 w-4" /><span className="hidden sm:inline">Compartir</span></button>
        <button type="button" className={iconButton} disabled={busy} onClick={() => void download()} aria-label="Descargar imagen"><Download className="h-5 w-5" /></button>
        <div className="relative" onClick={event => event.stopPropagation()}>
          <button ref={moreRef} type="button" className={iconButton} aria-label="Más opciones de imagen" aria-expanded={menu === "more"} aria-controls={`${titleId}-more`} onClick={() => setMenu(current => current === "more" ? null : "more")}><MoreHorizontal className="h-5 w-5" /></button>
          {menu === "more" && <div id={`${titleId}-more`} className="absolute right-0 top-12 z-40 w-56 rounded-2xl border border-zinc-200 bg-white p-2 shadow-lg">
            <button type="button" className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm hover:bg-zinc-100" disabled={busy} onClick={() => { setMenu(null); if (onViewChat) void runAction(() => onViewChat(asset)); else setFeedback({ text: "Esta imagen no tiene un chat original disponible.", error: true }) }}><RotateCcw className="h-4 w-4" />Ver chat original</button>
            <div className="mx-2 my-1 border-t border-zinc-100" />
            <button type="button" className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm text-red-600 hover:bg-red-50" disabled={busy} onClick={() => { setMenu(null); if (onDelete) setConfirmDelete(true); else setFeedback({ text: "No se puede eliminar esta imagen desde esta vista.", error: true }) }}><Trash2 className="h-4 w-4" />Eliminar imagen</button>
          </div>}
        </div>
      </header>

      <div className="relative flex shrink-0 flex-col items-center gap-2 px-2 pt-3 sm:px-5 sm:pt-4">
        <div role="toolbar" aria-label="Herramientas de imagen" className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-zinc-200 bg-white px-1 py-1 shadow-sm sm:gap-1 sm:px-2">
          <button type="button" className={cn(actionButton, mode === "annotate" && "bg-zinc-100")} disabled={busy} aria-pressed={mode === "annotate"} onClick={() => activate("annotate")}><Pencil className="h-4 w-4" />Anotar</button>
          <button type="button" className={cn(actionButton, mode === "comment" && "bg-zinc-100")} disabled={busy} aria-pressed={mode === "comment"} onClick={() => activate("comment")}><MessageSquarePlus className="h-4 w-4" />Comentar</button>
          <button type="button" className={actionButton} disabled={busy} onClick={() => void submit("remove-background")}><Scan className="h-4 w-4" /><span>Quitar fondo</span></button>
          <button type="button" className={cn(actionButton, mode === "erase" && "bg-zinc-100")} disabled={busy} aria-pressed={mode === "erase"} onClick={() => activate("erase")}><Eraser className="h-4 w-4" />Borrar</button>
          <button type="button" className={cn(actionButton, mode === "resize" && "bg-zinc-100")} disabled={busy} aria-pressed={mode === "resize"} onClick={() => activate("resize")}><Scan className="h-4 w-4" />Tamaño</button>
        </div>
        <div className="flex w-full items-center justify-between gap-2 lg:absolute lg:right-5 lg:top-4 lg:w-auto" onClick={event => event.stopPropagation()}>
          <span className="text-xs text-zinc-400 lg:hidden">{imageReady ? `${naturalSize.width} × ${naturalSize.height}` : "Cargando imagen…"}</span>
          <div className="relative">
            <button type="button" className="flex h-10 min-w-20 items-center justify-center gap-2 rounded-full border border-zinc-200 bg-white px-3 text-sm tabular-nums shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" aria-label={`Zoom: ${Math.round(scale * 100)} %${zoom === "fit" ? ", ajustar" : ""}`} aria-expanded={menu === "zoom"} aria-controls={`${titleId}-zoom`} onClick={() => setMenu(current => current === "zoom" ? null : "zoom")}><span>{Math.round(scale * 100)} %</span><ChevronDown className="h-4 w-4" /></button>
            {menu === "zoom" && <div id={`${titleId}-zoom`} className="absolute right-0 top-12 z-40 w-36 rounded-2xl border border-zinc-200 bg-white p-2 shadow-lg" role="group" aria-label="Nivel de zoom">
              {["fit" as const, ...ZOOMS].map(value => <button key={value} type="button" aria-pressed={zoom === value} className="flex min-h-10 w-full items-center justify-between rounded-lg px-3 text-sm hover:bg-zinc-100" onClick={() => { setZoom(value); setPan({ x: 0, y: 0 }); setMenu(null) }}>{value === "fit" ? "Ajustar" : `${value * 100} %`}{zoom === value && <Check className="h-4 w-4" />}</button>)}
            </div>}
          </div>
        </div>
        {modeHint && <p className="max-w-2xl px-2 text-center text-xs text-zinc-500" role="status">{modeHint}</p>}
        {mode === "annotate" && <div className="flex items-center gap-2" aria-label="Opciones de anotación">
          {["#f97316", "#ef4444", "#38bdf8", "#18181b"].map(color => <button key={color} type="button" aria-label={`Color ${color}`} aria-pressed={annotationColor === color} className={cn("h-7 w-7 rounded-full border-2 border-white ring-1 ring-zinc-200", annotationColor === color && "ring-2 ring-zinc-700")} style={{ backgroundColor: color }} onClick={() => setAnnotationColor(color)} />)}
          <button type="button" className={iconButton} disabled={!draft.strokes.length || busy} aria-label="Deshacer último trazo" onClick={() => updateDraft(previous => ({ ...previous, strokes: previous.strokes.slice(0, -1) }))}><Undo2 className="h-4 w-4" /></button>
        </div>}
        {mode === "resize" && <div className="flex max-w-3xl flex-wrap items-center justify-center gap-2 rounded-2xl border border-zinc-200 bg-white p-2 text-xs">
          {RATIOS.map(ratio => <button type="button" key={ratio} className={cn("min-h-9 rounded-lg px-2.5 hover:bg-zinc-100", aspectRatio === ratio && "bg-zinc-950 text-white hover:bg-zinc-800")} aria-pressed={aspectRatio === ratio} onClick={() => { const [w, h] = ratio.split(":").map(Number); setAspectRatio(ratio); setDimensions({ width: Math.round(Math.sqrt(naturalSize.width * naturalSize.height * w / h)), height: Math.round(Math.sqrt(naturalSize.width * naturalSize.height * h / w)) }) }}>{ratio}</button>)}
          <label className="flex items-center gap-1">Ancho<input aria-label="Ancho en píxeles" type="number" min={64} max={8192} value={dimensions.width || ""} className="h-9 w-20 rounded-lg border border-zinc-200 px-2 text-base sm:text-sm" onChange={event => { setAspectRatio(undefined); setDimensions(previous => ({ ...previous, width: Number(event.target.value) })) }} /></label>
          <span aria-hidden="true">×</span><label className="flex items-center gap-1">Alto<input aria-label="Alto en píxeles" type="number" min={64} max={8192} value={dimensions.height || ""} className="h-9 w-20 rounded-lg border border-zinc-200 px-2 text-base sm:text-sm" onChange={event => { setAspectRatio(undefined); setDimensions(previous => ({ ...previous, height: Number(event.target.value) })) }} /></label><span className="text-zinc-400">px</span>
        </div>}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col sm:flex-row">
        {images.length > 1 && <nav aria-label="Imágenes del chat" className="order-2 flex shrink-0 items-center gap-2 overflow-x-auto px-3 py-2 sm:absolute sm:inset-y-0 sm:left-0 sm:z-10 sm:order-none sm:w-24 sm:flex-col sm:justify-start sm:overflow-y-auto sm:overflow-x-hidden sm:pt-6">
          {images.map((item, i) => <button type="button" key={item.id} disabled={busy} className={cn("relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 bg-zinc-100 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 sm:h-16 sm:w-16", index === i ? "border-zinc-800" : "border-transparent opacity-55 hover:opacity-100")} aria-label={`Ver imagen ${i + 1}: ${item.name}`} aria-current={index === i ? "true" : undefined} onClick={() => select(i)}><img src={item.url} alt="" loading="lazy" className="h-full w-full object-cover" /><span className="absolute bottom-0 right-0 rounded-tl bg-white/90 px-1 text-[10px]">{i + 1}</span></button>)}
        </nav>}
        <div ref={viewportRef} data-testid="image-viewer-canvas" className={cn("relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden", images.length > 1 && "sm:mx-24")} style={{ touchAction: "none", cursor: mode === "annotate" || mode === "erase" || mode === "comment" ? "crosshair" : scale > imageFitScale(naturalSize.width, naturalSize.height, viewport.width, viewport.height) ? "grab" : "default" }} onPointerDown={startGesture} onPointerMove={moveGesture} onPointerUp={event => { moveGesture(event); gesture.current = null; event.currentTarget.releasePointerCapture?.(event.pointerId) }} onPointerCancel={() => { gesture.current = null }} onDoubleClick={() => { if (mode === "edit") { setZoom(current => current === "fit" ? 1 : "fit"); setPan({ x: 0, y: 0 }) } }}>
          {imageError ? <div role="alert" className="max-w-sm p-6 text-center text-sm text-zinc-600">No se pudo cargar la imagen. Cierra esta vista y vuelve a abrirla.</div> : <div className="relative shrink-0 shadow-[0_8px_28px_rgba(0,0,0,0.09)]" style={{ width: imageReady ? displayedWidth : undefined, height: imageReady ? displayedHeight : undefined, transform: `translate(${pan.x}px, ${pan.y}px)` }}>
            <img ref={imageRef} key={asset.url} src={asset.url} alt={asset.name} draggable={false} data-testid="image-viewer-image" data-scale={scale} style={{ width: imageReady ? displayedWidth : undefined, height: imageReady ? displayedHeight : undefined, maxWidth: imageReady ? "none" : "100%", maxHeight: imageReady ? "none" : "100%", imageRendering: "auto" }} className="block select-none object-contain" onLoad={event => { const { naturalWidth: width, naturalHeight: height } = event.currentTarget; if (width > 0 && height > 0) { setNaturalSize({ width, height }); setDimensions({ width, height }) } }} onError={() => setImageError(true)} />
            <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${Math.max(1, naturalSize.width)} ${Math.max(1, naturalSize.height)}`} preserveAspectRatio="none">
              {draft.strokes.map((stroke, i) => <polyline key={i} points={stroke.points.map(point => `${point.x * naturalSize.width / 100},${point.y * naturalSize.height / 100}`).join(" ")} fill="none" stroke={stroke.color} strokeWidth={Math.max(1, stroke.width * naturalSize.width / 100)} strokeLinecap="round" strokeLinejoin="round" />)}
              {mode === "erase" && draft.selection && <rect data-testid="image-viewer-selection" x={draft.selection.x * naturalSize.width / 100} y={draft.selection.y * naturalSize.height / 100} width={draft.selection.width * naturalSize.width / 100} height={draft.selection.height * naturalSize.height / 100} fill="rgba(56,189,248,0.18)" stroke="#0284c7" strokeWidth="2" strokeDasharray="6 3" vectorEffect="non-scaling-stroke" />}
            </svg>
            {savedComments.map((comment, i) => <button key={comment.id} type="button" title={comment.text} aria-label={`Comentario ${i + 1}: ${comment.text}`} className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-zinc-900 text-xs text-white shadow" style={{ left: `${comment.x}%`, top: `${comment.y}%` }} onPointerDown={event => event.stopPropagation()} onClick={() => setFeedback({ text: comment.text })}>{i + 1}</button>)}
            {mode === "comment" && draft.commentPoint && <span className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-sky-500 shadow" style={{ left: `${draft.commentPoint.x}%`, top: `${draft.commentPoint.y}%` }} />}
          </div>}
        </div>
      </div>

      <footer className="shrink-0 px-3 pb-3 pt-2 sm:px-6 sm:pb-6" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
        {feedback && !confirmDelete && <p role={feedback.error ? "alert" : "status"} className={cn("mx-auto mb-2 max-w-3xl text-center text-sm", feedback.error ? "text-red-700" : "text-zinc-600")}>{feedback.text}</p>}
        {busy && <p role="status" className="mb-2 text-center text-xs text-zinc-500">Aplicando a esta imagen…</p>}
        <form className="mx-auto flex max-w-4xl items-center gap-1 rounded-[28px] border border-zinc-200 bg-white px-2 py-2 shadow-[0_3px_18px_rgba(0,0,0,0.05)] sm:gap-2 sm:px-3" onSubmit={event => { event.preventDefault(); void submit() }}>
          {onAddReference && <button type="button" className={iconButton} disabled={busy} aria-label="Añadir imagen de referencia" onClick={() => onAddReference(asset)}><span className="text-2xl leading-none">+</span></button>}
          <textarea ref={textareaRef} value={draft.prompt} aria-label={mode === "comment" ? "Escribir comentario" : "Describir ediciones"} placeholder={mode === "comment" ? "Escribir comentario" : mode === "annotate" ? "Describe tus anotaciones (opcional)" : "Describir ediciones"} rows={1} disabled={busy} className="min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-base leading-6 text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-50" onChange={event => updateDraft({ prompt: event.target.value })} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} />
          <select aria-label="Calidad de imagen" value={quality} disabled={busy} className="h-10 max-w-24 rounded-lg bg-transparent px-1 text-xs text-zinc-500 outline-none focus-visible:ring-2 focus-visible:ring-sky-500 sm:max-w-32 sm:text-sm" onChange={event => setQuality(event.target.value as ImageViewerQuality)}><option value="1K">Estándar</option><option value="2K">Alta</option><option value="4K">Muy alta</option></select>
          <button type="button" className={cn(iconButton, recording && "bg-red-50 text-red-600")} disabled={busy} aria-label={recording ? "Detener dictado" : "Dictar edición"} aria-pressed={recording} onClick={dictate}><Mic className="h-5 w-5" /></button>
          <button type="submit" aria-label={modeLabel} title={modeLabel} disabled={busy || ((mode === "edit" || mode === "comment") && !draft.prompt.trim())} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-white transition hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:bg-zinc-200 disabled:text-zinc-400"><ArrowUp className="h-5 w-5" /></button>
        </form>
      </footer>

      {confirmDelete && <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/20 p-5" onClick={() => { if (!busy) { setConfirmDelete(false); moreRef.current?.focus() } }}><div ref={deleteRef} role="alertdialog" aria-modal="true" aria-labelledby={`${titleId}-delete`} className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl" onClick={event => event.stopPropagation()}><h3 id={`${titleId}-delete`} className="text-lg font-semibold">Eliminar imagen</h3><p className="mt-2 text-sm text-zinc-500">Se eliminará «{asset.name}» de la biblioteca. El original se conserva.</p>{feedback?.error && <p role="alert" className="mt-3 text-sm text-red-700">{feedback.text}</p>}<div className="mt-5 flex justify-end gap-2"><button type="button" autoFocus className={actionButton} disabled={busy} onClick={() => { setConfirmDelete(false); moreRef.current?.focus() }}>Cancelar</button><button type="button" disabled={busy} className="rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" onClick={() => void runAction(async () => { await onDelete?.(asset); if (mounted.current) { setConfirmDelete(false); moreRef.current?.focus() } })}>Eliminar</button></div></div></div>}
    </div>
  )
}
