"use client"

import React from "react"
import { Loader2, X, AlertCircle, Download, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * DocumentPreview — right-pane viewer for .pdf / .doc / .docx files
 * produced by the AI. Runs entirely client-side so it works against
 * a local backend (previously it tried view.officeapps.live.com which
 * requires a publicly reachable URL — hence the "No podemos procesar
 * esta solicitud" error on localhost).
 *
 * Strategy:
 *   - PDF: stream through a same-origin <iframe> (the backend already
 *     serves the right Content-Type, so browsers render it natively).
 *   - DOCX/DOC: fetch as ArrayBuffer, run mammoth.js in the browser
 *     to convert to HTML, and render inside a typography wrapper.
 *     Mammoth covers the common subset (headings, paragraphs, lists,
 *     tables, bold/italic). Good enough for AI-generated reports.
 *
 * If either path throws (404, network, corrupt file), we surface a
 * clear error card with a direct Download button so the user always
 * has a path to the file.
 */
interface DocumentPreviewProps {
  url: string
  onClose: () => void
}

type State =
  | { kind: "loading" }
  | { kind: "pdf" }
  | { kind: "html"; html: string; warnings: string[] }
  | { kind: "error"; message: string }

export function DocumentPreview({ url, onClose }: DocumentPreviewProps) {
  const [state, setState] = React.useState<State>({ kind: "loading" })

  const filename = React.useMemo(() => {
    try {
      const clean = url.split("?")[0].split("#")[0]
      return decodeURIComponent(clean.split("/").pop() || "documento")
    } catch {
      return "documento"
    }
  }, [url])

  React.useEffect(() => {
    if (!url) return
    const lower = url.toLowerCase().split("?")[0]

    if (lower.endsWith(".pdf")) {
      setState({ kind: "pdf" })
      return
    }

    if (!lower.endsWith(".docx") && !lower.endsWith(".doc")) {
      setState({ kind: "error", message: "Formato no soportado para previsualización." })
      return
    }

    let cancelled = false
    setState({ kind: "loading" })

    ;(async () => {
      try {
        const resp = await fetch(url, { credentials: "include" })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const buffer = await resp.arrayBuffer()
        if (cancelled) return

        // Dynamic import so mammoth lands in the preview chunk only
        // (it pulls JSZip with it — ~120 KB gzipped).
        const mammoth = await import("mammoth/mammoth.browser")
        const result = await mammoth.convertToHtml(
          { arrayBuffer: buffer },
          {
            styleMap: [
              "p[style-name='Heading 1'] => h1:fresh",
              "p[style-name='Heading 2'] => h2:fresh",
              "p[style-name='Heading 3'] => h3:fresh",
            ],
          },
        )
        if (cancelled) return
        setState({
          kind: "html",
          html: result.value,
          warnings: (result.messages || []).map((m: { message?: string }) => m.message || "").filter(Boolean),
        })
      } catch (err: unknown) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : "No se pudo abrir el documento."
        setState({ kind: "error", message })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [url])

  return (
    <div className="relative flex h-full w-full flex-col bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium" title={filename}>
            {filename}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => window.open(url, "_blank", "noopener")}
            className="h-8 w-8"
            title="Descargar"
            aria-label="Descargar"
          >
            <Download className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8"
            title="Cerrar"
            aria-label="Cerrar previsualización"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="scroll-contain min-h-0 flex-1 overflow-auto">
        {state.kind === "loading" && (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando vista previa…
          </div>
        )}

        {state.kind === "pdf" && (
          <iframe src={url} className="h-full w-full" title={`Vista previa ${filename}`} />
        )}

        {state.kind === "html" && (
          <div className="px-4 py-6 md:px-6 md:py-8">
            <article
              style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
              className="docx-preview mx-auto max-w-[780px] text-[15px] leading-relaxed text-foreground [&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_table]:my-3 [&_table]:block [&_table]:w-full [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5 [&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_strong]:font-semibold [&_em]:italic [&_img]:max-w-full [&_img]:h-auto"
              dangerouslySetInnerHTML={{ __html: state.html }}
            />
          </div>
        )}

        {state.kind === "error" && (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
              <AlertCircle className="mx-auto mb-3 h-8 w-8 text-destructive" />
              <p className="mb-1 font-medium">No se pudo previsualizar</p>
              <p className="mb-4 text-sm text-muted-foreground">{state.message}</p>
              <Button size="sm" onClick={() => window.open(url, "_blank", "noopener")}>
                <Download className="mr-1.5 h-4 w-4" />
                Descargar archivo
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
