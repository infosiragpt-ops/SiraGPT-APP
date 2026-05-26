"use client"

import { useCallback, useEffect, useState } from "react"
import {
  deleteImage,
  isTerminalStatus,
  listImageHistory,
  requestUpscale,
  requestVariation,
  type GeneratedImage,
} from "@/lib/images-service"

/**
 * F3 PR16 — Paginated history panel for /api/images/* jobs.
 *
 * Renders a responsive grid of the user's image generations + a per-
 * tile action bar (variation / upscale / delete). Cursor pagination
 * via "Cargar más". Visual: only utility classes, no shell layout
 * touched.
 */
export interface ImageHistoryPanelProps {
  className?: string
  pageSize?: number
  onSelect?: (image: GeneratedImage) => void
}

export function ImageHistoryPanel({
  className = "",
  pageSize = 24,
  onSelect,
}: ImageHistoryPanelProps) {
  const [images, setImages] = useState<GeneratedImage[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchPage = useCallback(
    async (nextCursor: string | null) => {
      try {
        const res = await listImageHistory({ cursor: nextCursor, limit: pageSize })
        setImages((prev) => (nextCursor ? [...prev, ...res.images] : res.images))
        setCursor(res.nextCursor)
      } catch (e) {
        setError(e instanceof Error ? e.message : "No se pudo cargar el historial")
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [pageSize],
  )

  useEffect(() => {
    setLoading(true)
    fetchPage(null)
  }, [fetchPage])

  const handleVariation = async (image: GeneratedImage) => {
    setBusyId(image.id)
    try {
      const result = await requestVariation(image.id, 1)
      setImages((prev) => [result.image, ...prev])
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo crear la variación")
    } finally {
      setBusyId(null)
    }
  }

  const handleUpscale = async (image: GeneratedImage, factor: 2 | 4) => {
    setBusyId(image.id)
    try {
      const result = await requestUpscale(image.id, factor)
      setImages((prev) => [result.image, ...prev])
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo hacer upscale")
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (image: GeneratedImage) => {
    if (!window.confirm("¿Eliminar esta imagen? (Se puede recuperar dentro de 30 días)")) return
    setBusyId(image.id)
    try {
      const updated = await deleteImage(image.id)
      setImages((prev) => prev.filter((i) => i.id !== updated.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo eliminar")
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <div className={`p-6 text-sm text-zinc-500 ${className}`}>
        Cargando historial…
      </div>
    )
  }

  if (!images.length) {
    return (
      <div className={`p-6 text-sm text-zinc-500 ${className}`}>
        Aún no has generado imágenes.
      </div>
    )
  }

  return (
    <section
      aria-label="Historial de imágenes generadas"
      className={`flex flex-col gap-4 ${className}`}
    >
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {images.map((image) => (
          <ImageTile
            key={image.id}
            image={image}
            busy={busyId === image.id}
            onSelect={onSelect}
            onVariation={handleVariation}
            onUpscale={handleUpscale}
            onDelete={handleDelete}
          />
        ))}
      </div>
      {cursor ? (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            onClick={() => {
              setLoadingMore(true)
              fetchPage(cursor)
            }}
            disabled={loadingMore}
            aria-label="Cargar más imágenes"
          >
            {loadingMore ? "Cargando…" : "Cargar más"}
          </button>
        </div>
      ) : null}
    </section>
  )
}

interface TileProps {
  image: GeneratedImage
  busy: boolean
  onSelect?: (image: GeneratedImage) => void
  onVariation: (image: GeneratedImage) => void
  onUpscale: (image: GeneratedImage, factor: 2 | 4) => void
  onDelete: (image: GeneratedImage) => void
}

function ImageTile({ image, busy, onSelect, onVariation, onUpscale, onDelete }: TileProps) {
  const previewUrl = image.assetIds?.[0] || null
  const terminal = isTerminalStatus(image.status)
  return (
    <figure
      className="group relative overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-900"
      data-testid="image-tile"
      data-image-id={image.id}
    >
      <button
        type="button"
        className="block aspect-square w-full bg-zinc-200 dark:bg-zinc-800"
        onClick={() => onSelect?.(image)}
        aria-label={`Abrir imagen: ${image.prompt.slice(0, 60)}`}
      >
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={image.prompt}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <span className="flex h-full items-center justify-center text-xs text-zinc-500">
            {image.status === "FAILED"
              ? "Falló"
              : image.status === "MODERATED"
                ? "Moderado"
                : `Generando…`}
          </span>
        )}
      </button>
      <figcaption className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
        <span
          className="truncate text-zinc-600 dark:text-zinc-400"
          title={image.prompt}
        >
          {image.prompt}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
            image.status === "READY"
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
              : image.status === "FAILED" || image.status === "MODERATED"
                ? "bg-red-500/15 text-red-700 dark:text-red-400"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
          }`}
        >
          {image.status}
        </span>
      </figcaption>
      {terminal ? (
        <div
          className="absolute bottom-9 left-0 right-0 flex items-center justify-center gap-1 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5 opacity-0 transition-opacity group-hover:opacity-100"
          role="toolbar"
          aria-label={`Acciones para imagen ${image.id}`}
        >
          <TileButton onClick={() => onVariation(image)} disabled={busy} label="Variation">
            ✦
          </TileButton>
          <TileButton onClick={() => onUpscale(image, 2)} disabled={busy} label="Upscale 2x">
            2×
          </TileButton>
          <TileButton onClick={() => onUpscale(image, 4)} disabled={busy} label="Upscale 4x">
            4×
          </TileButton>
          <TileButton onClick={() => onDelete(image)} disabled={busy} label="Eliminar">
            ✕
          </TileButton>
        </div>
      ) : null}
    </figure>
  )
}

function TileButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled: boolean
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded bg-white/90 px-2 py-1 text-xs font-semibold text-zinc-900 hover:bg-white disabled:opacity-50 dark:bg-zinc-900/90 dark:text-zinc-100 dark:hover:bg-zinc-900"
    >
      {children}
    </button>
  )
}

export default ImageHistoryPanel
