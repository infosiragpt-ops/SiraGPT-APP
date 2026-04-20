"use client"

/**
 * ArtifactPanel — right-side split-pane renderer for the active
 * artifact. Mounted once at the ChatInterfaceContent level; its
 * content is driven by the ArtifactPanelContext. Two views:
 *
 *   view === "preview" → sandboxed iframe with the rendered HTML
 *   view === "code"    → syntax-highlighted source block
 *
 * The panel deliberately fills whatever width its parent gives it
 * (the resizable split divider controls that) so we don't hard-
 * code widths here — the outer wrapper handles size.
 */

import React, { useMemo, useState } from "react"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { oneDark } from "react-syntax-highlighter/dist/cjs/styles/prism"
import {
  RefreshCw, FileCode, Download, ExternalLink, X, Eye, Check, Clipboard,
} from "lucide-react"
import { useArtifactPanel } from "@/lib/artifact-panel-context"

function toFullDocument(code: string, language: string): string {
  if (language === "svg") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;padding:16px;display:grid;place-items:center;background:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}svg{max-width:100%;max-height:100%;height:auto}</style>
</head><body>${code}</body></html>`
  }
  const trimmed = code.trimStart()
  if (/^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return code
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0">${code}</body></html>`
}

export function ArtifactPanel() {
  const { active, close, setView } = useArtifactPanel()
  const [generation, setGeneration] = useState(0)

  if (!active) return null

  const { code, language, title, view } = active
  const lang = (language || "").toLowerCase()
  const isMermaid = lang === "mermaid"

  const srcDoc = useMemo(() => {
    if (isMermaid) return ""
    return toFullDocument(code, lang)
  }, [code, lang, isMermaid])

  const fileName = sanitizeFilename(title || "artefacto") + (isMermaid ? ".svg" : ".html")

  const onReset = () => setGeneration((g) => g + 1)

  const onDownload = async () => {
    let blob: Blob
    if (isMermaid) {
      const svg = await renderMermaidSvg(code)
      blob = new Blob([svg || code], { type: "image/svg+xml" })
    } else {
      blob = new Blob([srcDoc], { type: "text/html" })
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  }

  const onOpenNewTab = async () => {
    let blob: Blob
    if (isMermaid) {
      const svg = (await renderMermaidSvg(code)) || code
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title || "Artefacto")}</title>
<style>html,body{margin:0;padding:24px;background:#fff;display:grid;place-items:center}</style>
</head><body>${svg}</body></html>`
      blob = new Blob([html], { type: "text/html" })
    } else {
      blob = new Blob([srcDoc], { type: "text/html" })
    }
    const url = URL.createObjectURL(blob)
    window.open(url, "_blank", "noopener,noreferrer")
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-white dark:bg-zinc-900 border-l border-border/60">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5 bg-white dark:bg-zinc-900">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="truncate text-sm font-semibold">{title || "Artefacto"}</h3>
        </div>
        <div className="flex items-center gap-1">
          {/* View toggle — preview / code */}
          <div className="mr-1 inline-flex rounded-full bg-muted p-0.5 text-xs font-medium">
            <button
              onClick={() => setView("preview")}
              className={`grid h-6 w-14 place-items-center rounded-full transition-colors ${view === "preview" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              aria-pressed={view === "preview"}
            >
              Vista
            </button>
            <button
              onClick={() => setView("code")}
              className={`grid h-6 w-14 place-items-center rounded-full transition-colors ${view === "code" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              aria-pressed={view === "code"}
            >
              Código
            </button>
          </div>
          <IconButton label="Reiniciar" onClick={onReset}><RefreshCw className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Descargar" onClick={onDownload}><Download className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Abrir en nueva pestaña" onClick={onOpenNewTab}><ExternalLink className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Cerrar" onClick={close}><X className="h-4 w-4" /></IconButton>
        </div>
      </div>

      {/* Content */}
      <div className="relative flex-1 min-h-0 bg-white">
        {view === "preview" ? (
          isMermaid ? (
            <MermaidFill code={code} key={`mermaid-${generation}`} />
          ) : (
            <iframe
              key={`iframe-${generation}`}
              title="artifact-panel"
              srcDoc={srcDoc}
              sandbox="allow-scripts"
              className="h-full w-full border-0 bg-white"
            />
          )
        ) : (
          <div className="h-full overflow-auto">
            <SyntaxHighlighter
              style={oneDark}
              language={lang === "mermaid" ? "mermaid" : "markup"}
              PreTag="div"
              customStyle={{ margin: 0, padding: "1.25rem", background: "#0f172a", fontSize: "13px", minHeight: "100%" }}
              wrapLongLines
              codeTagProps={{ style: { whiteSpace: "pre-wrap", wordBreak: "break-all" } }}
            >
              {code}
            </SyntaxHighlighter>
          </div>
        )}
      </div>
    </div>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  )
}

function MermaidFill({ code }: { code: string }) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  React.useEffect(() => {
    let cancelled = false
      ; (async () => {
        try {
          const mermaid = (await import("mermaid")).default
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" })
          const id = "panel-mermaid-" + Math.random().toString(36).slice(2, 9)
          const { svg } = await mermaid.render(id, code)
          if (cancelled || !ref.current) return
          ref.current.innerHTML = svg
          setErr(null)
        } catch (e: any) { setErr(e?.message || "Mermaid render failed") }
      })()
    return () => { cancelled = true }
  }, [code])
  return (
    <div className="h-full w-full grid place-items-center overflow-auto p-6">
      {err ? <pre className="text-xs text-rose-600 whitespace-pre-wrap">{err}</pre> : <div ref={ref} className="max-w-full [&_svg]:max-w-full [&_svg]:h-auto" />}
    </div>
  )
}

async function renderMermaidSvg(code: string): Promise<string | null> {
  try {
    const mermaid = (await import("mermaid")).default
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" })
    const id = "export-mermaid-" + Math.random().toString(36).slice(2, 9)
    const { svg } = await mermaid.render(id, code)
    return svg
  } catch { return null }
}

function sanitizeFilename(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "artefacto"
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string))
}
