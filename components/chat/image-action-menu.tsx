"use client"

/* eslint-disable @next/next/no-img-element -- Renders arbitrary user/generated chat image URLs directly without Next Image re-encoding. */

import * as React from "react"
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Film,
  Forward,
  Maximize2,
  MessageSquarePlus,
  Paintbrush,
  Pin,
  PinOff,
  Reply,
  Send,
  Share2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { cn, downloadBlob } from "@/lib/utils"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import {
  type ChatImageActionPayload,
  VIDEO_DURATION_PRESETS,
  dispatchImageForward,
  dispatchImagePrecisionEdit,
  dispatchImageReply,
  dispatchImageToVideo,
  formatVideoDurationEs,
  parseCustomVideoDuration,
} from "@/lib/chat/image-actions"
import {
  PINNED_IMAGES_EVENT,
  type PinnedChatImage,
  isImagePinned,
  togglePinnedImage,
} from "@/lib/chat/pinned-images"

export interface ImageActionMenuProps {
  image: ChatImageActionPayload
  onOpen?: () => void
  onDownload?: () => void | Promise<void>
  /** When true (left-aligned assistant images), opens cleanly beside the right
   *  edge of the image whenever viewport width permits so the photo stays
   *  unobstructed. Falls back inside-right on narrow screens or wide images. */
  preferOutsideRight?: boolean
  className?: string
}

type MenuPanel = "root" | "video" | "forward"

export function ImageActionMenu({ image, onOpen, onDownload, preferOutsideRight = false, className }: ImageActionMenuProps) {
  const [open, setOpen] = React.useState(false)
  const [openOutsideRight, setOpenOutsideRight] = React.useState(false)
  const [panel, setPanel] = React.useState<MenuPanel>("root")
  const [customValue, setCustomValue] = React.useState("30")
  const [customUnit, setCustomUnit] = React.useState<"seconds" | "minutes">("seconds")
  const [copied, setCopied] = React.useState(false)
  const [pinned, setPinned] = React.useState(() => isImagePinned(image.chatId, image.fileId || image.id))
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)

  const pinKey = image.fileId || image.id

  React.useEffect(() => {
    setPinned(isImagePinned(image.chatId, pinKey))
    const onPinChanged = () => setPinned(isImagePinned(image.chatId, pinKey))
    window.addEventListener(PINNED_IMAGES_EVENT, onPinChanged)
    return () => window.removeEventListener(PINNED_IMAGES_EVENT, onPinChanged)
  }, [image.chatId, pinKey])

  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setPanel("root")
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        if (panel !== "root") {
          setPanel("root")
        } else {
          setOpen(false)
          triggerRef.current?.focus()
        }
      }
    }
    document.addEventListener("mousedown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [open, panel])

  const closeMenu = () => {
    setOpen(false)
    setPanel("root")
  }

  const handleReply = () => {
    closeMenu()
    dispatchImageReply(image)
  }

  const handlePrecisionEdit = () => {
    closeMenu()
    dispatchImagePrecisionEdit(image)
  }

  const handleConvertToVideo = (durationSeconds: number) => {
    closeMenu()
    dispatchImageToVideo({ ...image, durationSeconds })
  }

  const handleCustomVideoSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const parsed = parseCustomVideoDuration(customValue, customUnit)
    if (!parsed) {
      toast.error("Indica una duración válida (de 4 segundos hasta 5 minutos).")
      return
    }
    handleConvertToVideo(parsed)
  }

  const handleTogglePin = () => {
    if (!image.chatId) {
      toast.error("Abre o guarda la conversación para fijar esta imagen.")
      closeMenu()
      return
    }
    const result = togglePinnedImage(image.chatId, {
      id: pinKey,
      fileId: image.fileId,
      url: image.url,
      name: image.name,
      prompt: image.prompt,
      aspectRatio: image.aspectRatio,
      messageId: image.messageId,
    })
    setPinned(result.pinned)
    closeMenu()
    toast.success(result.pinned ? "Imagen fijada en este chat" : "Imagen desfijada")
  }

  const handleCopyImage = async () => {
    try {
      const response = await authenticatedFetch(image.url, { credentials: "include" })
      if (!response.ok) throw new Error("fetch failed")
      const blob = await response.blob()
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        const pngBlob = blob.type === "image/png" ? blob : new Blob([await blob.arrayBuffer()], { type: "image/png" })
        await navigator.clipboard.write([new ClipboardItem({ [pngBlob.type]: pngBlob })])
        setCopied(true)
        toast.success("Imagen copiada al portapapeles")
        setTimeout(() => setCopied(false), 1800)
        closeMenu()
        return
      }
      await navigator.clipboard?.writeText(image.url)
      toast.success("Enlace de imagen copiado")
      closeMenu()
    } catch {
      try {
        await navigator.clipboard?.writeText(image.url)
        toast.success("Enlace de imagen copiado")
      } catch {
        toast.error("No se pudo copiar la imagen en este navegador.")
      }
      closeMenu()
    }
  }

  const handleNativeShare = async () => {
    try {
      const response = await authenticatedFetch(image.url, { credentials: "include" })
      if (!response.ok) throw new Error("fetch failed")
      const blob = await response.blob()
      const file = new File([blob], image.name || "imagen.png", { type: blob.type || "image/png" })
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: image.name || "Imagen" })
        closeMenu()
        return
      }
      if (navigator.share) {
        await navigator.share({ title: image.name || "Imagen", url: image.url })
        closeMenu()
        return
      }
      await handleCopyImage()
    } catch (error: any) {
      if (error?.name !== "AbortError") {
        await handleCopyImage()
      } else {
        closeMenu()
      }
    }
  }

  const handleDownload = async () => {
    closeMenu()
    if (onDownload) {
      await onDownload()
      return
    }
    try {
      const response = await authenticatedFetch(image.url, { credentials: "include" })
      if (!response.ok) throw new Error("download failed")
      downloadBlob(await response.blob(), image.name || "imagen.png")
      toast.success("Descarga iniciada")
    } catch {
      toast.error("No se pudo descargar la imagen")
    }
  }

  return (
    <>
      {pinned && (
        <span
          data-testid="image-pinned-badge"
          title="Imagen fijada"
          className="pointer-events-none absolute left-2.5 top-2.5 z-20 inline-flex items-center gap-1 rounded-full bg-zinc-950/70 px-2 py-0.5 text-[11px] font-medium text-white shadow-sm backdrop-blur-sm"
        >
          <Pin className="h-3 w-3" />
          <span>Fijada</span>
        </span>
      )}

      {/* Subtle WhatsApp-style top-right gradient scrim on hover so the chevron
          stays legible on bright and dark images alike. */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute right-0 top-0 z-10 h-16 w-20 rounded-tr-xl bg-gradient-to-bl from-black/50 via-black/15 to-transparent transition-opacity duration-150",
          open
            ? "opacity-100"
            : "opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/image:opacity-100 group-focus-within/image:opacity-100",
        )}
      />

      <div
        ref={containerRef}
        className={cn(
          "absolute right-2 top-2 z-30 transition-opacity duration-150",
          open
            ? "opacity-100"
            : "opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/image:opacity-100 focus-within:opacity-100",
          className,
        )}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          ref={triggerRef}
          type="button"
          data-testid="image-action-chevron"
          aria-label="Opciones de imagen"
          aria-haspopup="menu"
          aria-expanded={open}
          title="Opciones de imagen"
          onClick={(event) => {
            event.stopPropagation()
            setOpen((prev) => {
              const next = !prev
              if (next) {
                if (preferOutsideRight && typeof window !== "undefined" && triggerRef.current) {
                  const rect = triggerRef.current.getBoundingClientRect()
                  const scrollParent = triggerRef.current.closest("[data-radix-scroll-area-viewport], main")
                  const parentRight = scrollParent?.getBoundingClientRect().right ?? 0
                  const rightBound = parentRight > 0 ? Math.min(window.innerWidth, parentRight) : window.innerWidth
                  setOpenOutsideRight(rect.right + 310 < rightBound)
                } else {
                  setOpenOutsideRight(false)
                }
              } else {
                setPanel("root")
              }
              return next
            })
          }}
          className="image-action-liquid-trigger flex h-8 w-8 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/90"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform duration-150", open && "rotate-180")} />
        </button>

        {open && (
          <div
            role="menu"
            aria-label="Acciones para esta imagen"
            data-testid="image-action-menu"
            data-placement={openOutsideRight ? "outside-right" : "inside-right"}
            className={cn(
              "image-action-liquid-menu absolute z-50 w-[276px] overflow-hidden rounded-[20px] p-1.5",
              openOutsideRight ? "left-[calc(100%+18px)] top-0" : "right-0 top-10",
            )}
          >
            {panel === "root" && (
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleReply}
                  className="image-action-liquid-item flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-[13px] focus-visible:outline-none"
                >
                  <span className="image-action-liquid-icon" aria-hidden="true">
                    <Reply className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium leading-tight text-zinc-950 dark:text-zinc-50">Responder a esta imagen</span>
                    <span className="block text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">Llévala al chat para describir cambios</span>
                  </span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={handlePrecisionEdit}
                  className="image-action-liquid-item flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-[13px] focus-visible:outline-none"
                >
                  <span className="image-action-liquid-icon" aria-hidden="true">
                    <Paintbrush className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium leading-tight text-zinc-950 dark:text-zinc-50">Editar algo en concreto</span>
                    <span className="block text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">Edición milimétrica con pincel o zona</span>
                  </span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setPanel("video")}
                  className="image-action-liquid-item flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-[13px] focus-visible:outline-none"
                >
                  <span className="image-action-liquid-icon" aria-hidden="true">
                    <Film className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium leading-tight text-zinc-950 dark:text-zinc-50">Convertir en video</span>
                    <span className="block text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">Elige segundos o minutos</span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500 dark:text-zinc-400" />
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setPanel("forward")}
                  className="image-action-liquid-item flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-[13px] focus-visible:outline-none"
                >
                  <span className="image-action-liquid-icon" aria-hidden="true">
                    <Forward className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 font-medium leading-tight text-zinc-950 dark:text-zinc-50">Reenviar</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500 dark:text-zinc-400" />
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={handleTogglePin}
                  className="image-action-liquid-item flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-[13px] focus-visible:outline-none"
                >
                  <span className="image-action-liquid-icon" aria-hidden="true">
                    {pinned ? (
                      <PinOff className="h-3.5 w-3.5" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 font-medium leading-tight text-zinc-950 dark:text-zinc-50">
                    {pinned ? "Desfijar imagen" : "Fijar imagen"}
                  </span>
                </button>

                <div className="image-action-liquid-sep" />

                <div className="grid grid-cols-2 gap-1 px-0.5 pt-0.5">
                  {onOpen && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        closeMenu()
                        onOpen()
                      }}
                      className="image-action-liquid-item flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-medium text-zinc-900 dark:text-zinc-100 focus-visible:outline-none"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                      <span>Ampliar</span>
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleDownload()}
                    className={cn(
                      "image-action-liquid-item flex items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-medium text-zinc-900 dark:text-zinc-100 focus-visible:outline-none",
                      !onOpen && "col-span-2",
                    )}
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Descargar</span>
                  </button>
                </div>
              </div>
            )}

            {panel === "video" && (
              <div className="flex flex-col gap-2 p-1" data-testid="image-action-video-panel">
                <button
                  type="button"
                  onClick={() => setPanel("root")}
                  className="image-action-liquid-item flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-300"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  <span>Duración del video</span>
                </button>

                <div className="grid grid-cols-4 gap-1">
                  {VIDEO_DURATION_PRESETS.map((preset) => (
                    <button
                      key={preset.seconds}
                      type="button"
                      onClick={() => handleConvertToVideo(preset.seconds)}
                      className="rounded-lg border border-zinc-200/90 bg-white/80 px-1.5 py-1.5 text-center text-[12px] font-medium tabular-nums text-zinc-900 shadow-xs transition hover:border-zinc-900 hover:bg-zinc-900 hover:text-white dark:border-zinc-700/80 dark:bg-zinc-900/80 dark:text-zinc-100 dark:hover:border-white dark:hover:bg-white dark:hover:text-zinc-950"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <form onSubmit={handleCustomVideoSubmit} className="mt-0.5 flex flex-col gap-1.5 border-t border-zinc-200/70 pt-2 dark:border-zinc-800">
                  <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">Duración personalizada (hasta 5 min)</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={1}
                      max={customUnit === "minutes" ? 5 : 300}
                      step={customUnit === "minutes" ? "0.5" : "1"}
                      value={customValue}
                      aria-label="Duración personalizada del video"
                      onChange={(event) => setCustomValue(event.target.value)}
                      className="h-8 w-16 rounded-lg border border-zinc-300/90 bg-white px-2 text-xs tabular-nums text-zinc-900 outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-white"
                    />
                    <div className="inline-flex h-8 rounded-lg border border-zinc-300/90 bg-white/80 p-0.5 text-[11px] dark:border-zinc-700 dark:bg-zinc-900/80">
                      <button
                        type="button"
                        onClick={() => {
                          setCustomUnit("seconds")
                          if (Number(customValue) <= 5) setCustomValue("30")
                        }}
                        className={cn(
                          "rounded-md px-2 font-medium transition",
                          customUnit === "seconds" ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-950" : "text-zinc-600 dark:text-zinc-400",
                        )}
                      >
                        seg
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCustomUnit("minutes")
                          if (Number(customValue) > 5) setCustomValue("1")
                        }}
                        className={cn(
                          "rounded-md px-2 font-medium transition",
                          customUnit === "minutes" ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-950" : "text-zinc-600 dark:text-zinc-400",
                        )}
                      >
                        min
                      </button>
                    </div>
                    <button
                      type="submit"
                      className="ml-auto inline-flex h-8 items-center justify-center rounded-lg bg-zinc-900 px-2.5 text-xs font-medium text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                    >
                      Usar
                    </button>
                  </div>
                </form>
              </div>
            )}

            {panel === "forward" && (
              <div className="flex flex-col gap-0.5 p-0.5" data-testid="image-action-forward-panel">
                <button
                  type="button"
                  onClick={() => setPanel("root")}
                  className="image-action-liquid-item mb-0.5 flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-300"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  <span>Reenviar imagen</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu()
                    dispatchImageForward({ ...image, mode: "new-chat" })
                  }}
                  className="image-action-liquid-item flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-[13px] focus-visible:outline-none"
                >
                  <span className="image-action-liquid-icon" aria-hidden="true">
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                  </span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-50">Nuevo chat con esta imagen</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu()
                    dispatchImageForward({ ...image, mode: "pick-chat" })
                  }}
                  className="image-action-liquid-item flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-[13px] focus-visible:outline-none"
                >
                  <span className="image-action-liquid-icon" aria-hidden="true">
                    <Send className="h-3.5 w-3.5" />
                  </span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-50">Enviar a otro chat…</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleCopyImage()}
                  className="image-action-liquid-item flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-[13px] focus-visible:outline-none"
                >
                  <span className="image-action-liquid-icon" aria-hidden="true">
                    {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                  </span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-50">Copiar imagen</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleNativeShare()}
                  className="image-action-liquid-item flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-[13px] focus-visible:outline-none"
                >
                  <span className="image-action-liquid-icon" aria-hidden="true">
                    <Share2 className="h-3.5 w-3.5" />
                  </span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-50">Compartir…</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

export interface ComposerImageReplyTarget extends ChatImageActionPayload {
  intent: "edit" | "video"
  videoDurationSeconds?: number
}

export function ImageReplyBanner({
  target,
  onClear,
  onPrecisionEdit,
}: {
  target: ComposerImageReplyTarget
  onClear: () => void
  onPrecisionEdit?: () => void
}) {
  const isVideo = target.intent === "video"
  const durationLabel = isVideo && target.videoDurationSeconds
    ? formatVideoDurationEs(target.videoDurationSeconds)
    : null
  const subtitle = target.prompt?.trim()
    ? target.prompt.trim().slice(0, 96)
    : (target.name || "Imagen seleccionada")

  return (
    <div
      data-testid="composer-image-reply-banner"
      className="mb-2 flex items-center gap-2.5 rounded-xl border border-zinc-200/90 bg-zinc-50/90 px-2.5 py-2 text-left dark:border-zinc-800 dark:bg-zinc-900/75"
    >
      <div className="h-9 w-1 shrink-0 rounded-full bg-zinc-900 dark:bg-zinc-100" aria-hidden="true" />
      <img
        src={target.url}
        alt={target.name || "Imagen referenciada"}
        className="h-10 w-10 shrink-0 rounded-lg border border-zinc-200/80 object-cover dark:border-zinc-700"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
          {isVideo ? <Film className="h-3.5 w-3.5 shrink-0" /> : <Reply className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">
            {isVideo
              ? `Convertir esta imagen en video${durationLabel ? ` · ${durationLabel}` : ""}`
              : "Respondiendo a esta imagen"}
          </span>
        </div>
        <p className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
          {subtitle}
        </p>
      </div>
      {!isVideo && onPrecisionEdit && (
        <button
          type="button"
          onClick={onPrecisionEdit}
          title="Abrir edición milimétrica con pincel"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 text-[11px] font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <Paintbrush className="h-3 w-3" />
          <span className="hidden sm:inline">Pincel</span>
        </button>
      )}
      <button
        type="button"
        onClick={onClear}
        aria-label="Cancelar respuesta a imagen"
        title="Quitar referencia"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function PinnedImagesBar({
  items,
  onReply,
  onUnpin,
}: {
  items: PinnedChatImage[]
  onReply: (item: PinnedChatImage) => void
  onUnpin: (imageId: string) => void
}) {
  if (!items.length) return null
  return (
    <div
      data-testid="pinned-images-bar"
      aria-label="Imágenes fijadas en esta conversación"
      className="mb-2 flex items-center gap-2 overflow-x-auto rounded-xl border border-zinc-200/80 bg-white/80 px-2.5 py-1.5 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80"
    >
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
        <Pin className="h-3 w-3" />
        <span>Fijadas ({items.length})</span>
      </span>
      <div className="flex items-center gap-1.5">
        {items.map((item) => (
          <div
            key={item.id}
            className="group/pin inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200/80 bg-zinc-50/80 p-1 pr-1.5 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <button
              type="button"
              onClick={() => onReply(item)}
              title={`Usar imagen fijada: ${item.name}`}
              className="flex items-center gap-1.5 text-left focus-visible:outline-none"
            >
              <img
                src={item.url}
                alt={item.name}
                className="h-6 w-6 rounded object-cover"
              />
              <span className="max-w-[110px] truncate text-[11.5px] font-medium text-zinc-800 dark:text-zinc-200">
                {item.prompt ? item.prompt.slice(0, 28) : item.name}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onUnpin(item.id)}
              aria-label={`Desfijar ${item.name}`}
              className="inline-flex h-4 w-4 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
