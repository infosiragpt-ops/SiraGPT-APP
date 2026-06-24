"use client"

/**
 * /documents — "Mis documentos": galería de archivos generados o editados
 * por la IA (Word/Excel/PowerPoint/PDF…). Estilo Cowork: ver, descargar y
 * volver al chat de origen para seguir iterando. Minimalista: una grilla
 * de tarjetas con la misma gramática visual de las ArtifactCard del chat.
 */

import * as React from "react"
import { FileText, Download, Eye, MessageSquare, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

type ArtifactRow = {
  id: string
  filename: string
  format?: string | null
  mime?: string | null
  sizeBytes?: number | null
  createdAt: string
  chatId?: string | null
  downloadUrl: string
}

function authHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {}
  const token = window.localStorage.getItem("auth-token")
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function formatLabel(row: ArtifactRow): string {
  const explicit = String(row.format || "").toLowerCase()
  if (explicit) return explicit.toUpperCase()
  const ext = row.filename.includes(".") ? row.filename.split(".").pop() || "" : ""
  return ext ? ext.toUpperCase() : "DOC"
}

function formatIconSrc(row: ArtifactRow): string | null {
  const f = formatLabel(row).toLowerCase()
  if (f === "docx" || f === "doc") return "/icons/Word.png"
  if (f === "xlsx" || f === "xls" || f === "csv") return "/icons/Excel.png"
  if (f === "pptx" || f === "ppt") return "/icons/Bigger P powerpoint.png"
  if (f === "pdf") return "/icons/pdf.png"
  return null
}

function sizeLabel(bytes?: number | null): string {
  const n = Number(bytes || 0)
  if (!n) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function dateLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" })
  } catch {
    return ""
  }
}

export default function DocumentsPage() {
  const [artifacts, setArtifacts] = React.useState<ArtifactRow[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)

  const load = React.useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const resp = await fetch(`${API_ROOT}/agent/artifacts?limit=100`, {
        credentials: "include",
        headers: authHeaders(),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      setArtifacts(Array.isArray(data?.artifacts) ? data.artifacts : [])
    } catch (err: any) {
      setError(err?.message || "No se pudieron cargar los documentos")
      setArtifacts((prev) => prev ?? [])
    } finally {
      setRefreshing(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const download = React.useCallback(async (row: ArtifactRow) => {
    const href = row.downloadUrl.startsWith("http")
      ? row.downloadUrl
      : `${API_ROOT.replace(/\/api$/, "")}${row.downloadUrl}`
    try {
      const resp = await fetch(href, { credentials: "include", headers: authHeaders() })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const blob = await resp.blob()
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = row.filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000)
    } catch {
      window.open(href, "_blank", "noopener,noreferrer")
    }
  }, [])

  const preview = React.useCallback((row: ArtifactRow) => {
    const href = row.downloadUrl.startsWith("http")
      ? row.downloadUrl
      : `${API_ROOT.replace(/\/api$/, "")}${row.downloadUrl}`
    window.open(href, "_blank", "noopener,noreferrer")
  }, [])

  const openChat = React.useCallback((row: ArtifactRow) => {
    if (!row.chatId) {
      toast.info("Este documento no tiene un chat asociado.")
      return
    }
    window.location.href = `/chat?chatId=${encodeURIComponent(row.chatId)}`
  }, [])

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Documentos</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Archivos generados y editados por la IA. Ábrelos, descárgalos o vuelve al chat para seguir editándolos.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={refreshing}
          className="inline-flex h-9 items-center gap-2 rounded-full border border-border/60 px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-60"
        >
          {refreshing ? <ThinkingIndicator size="xs" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Actualizar
        </button>
      </div>

      {artifacts === null && (
        <div className="flex items-center justify-center py-24">
          <ThinkingIndicator size="lg" label="Cargando documentos" />
        </div>
      )}

      {artifacts !== null && error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </div>
      )}

      {artifacts !== null && artifacts.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border/60 py-20 text-center">
          <FileText className="h-10 w-10 text-muted-foreground/40" />
          <div className="text-sm font-medium text-foreground/80">Aún no hay documentos</div>
          <p className="max-w-sm text-sm text-muted-foreground">
            Pídele a la IA en el chat que cree o edite un documento — aparecerá aquí automáticamente.
          </p>
        </div>
      )}

      {artifacts !== null && artifacts.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {artifacts.map((row) => {
            const icon = formatIconSrc(row)
            return (
              <div
                key={row.id}
                className={cn(
                  "group flex items-center gap-3.5 rounded-2xl border border-border/60 bg-background p-4",
                  "transition-shadow hover:shadow-[0_8px_24px_-16px_rgba(15,23,42,0.25)]",
                )}
              >
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted/30">
                  {icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={icon} alt="" className="h-9 w-9 object-contain" />
                  ) : (
                    <FileText className="h-7 w-7 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground" title={row.filename}>
                    {row.filename}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatLabel(row)}</span>
                    {sizeLabel(row.sizeBytes) && <span>· {sizeLabel(row.sizeBytes)}</span>}
                    <span>· {dateLabel(row.createdAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => preview(row)}
                    title="Ver"
                    aria-label="Ver documento"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  >
                    <Eye className="h-[18px] w-[18px]" />
                  </button>
                  <button
                    type="button"
                    onClick={() => download(row)}
                    title="Descargar"
                    aria-label="Descargar documento"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  >
                    <Download className="h-[18px] w-[18px]" />
                  </button>
                  {row.chatId && (
                    <button
                      type="button"
                      onClick={() => openChat(row)}
                      title="Abrir chat de origen"
                      aria-label="Abrir chat de origen"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                    >
                      <MessageSquare className="h-[18px] w-[18px]" />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
