"use client"

/**
 * ArtifactCard — inline Meta-AI-style renderer for executable code
 * blocks (HTML / SVG / Mermaid). Replaces the static CodeBlock when
 * the model emits self-contained visual content.
 *
 * Three surfaces in one component:
 *   (1) Inline preview: a sandboxed iframe (html/svg) or a native
 *       Mermaid render, with an "Abrir" overlay button pinned to
 *       the bottom-right that pops the artifact into (3).
 *   (2) Action rail: 4 icon-only buttons below the preview —
 *       Reiniciar / Ver código / Descargar / Abrir en nueva pestaña.
 *       The "Ver código" toggle slides the source down under the card.
 *   (3) Expanded mode: full-viewport modal with the artifact filling
 *       the available space, reusing the 4 actions in its header.
 *
 * Mermaid is rendered via the installed `mermaid@11` lib (dynamic
 * import so the iframe path doesn't pay the cost when not needed).
 */

import React, { useEffect, useMemo, useRef, useState } from "react"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { oneDark } from "react-syntax-highlighter/dist/cjs/styles/prism"
import {
  RefreshCw, FileCode, Download, ExternalLink, X, Maximize2, Minimize2,
  Check, Clipboard,
} from "lucide-react"

export type ArtifactCardProps = {
  code: string
  language: "html" | "svg" | "mermaid" | string
  title?: string
}

// ────────────────────────────────────────────────────────────
// Detection — exported so the markdown renderer can ask
// "should I mount an ArtifactCard instead of the CodeBlock?".
// ────────────────────────────────────────────────────────────
export function isExecutableArtifact(language: string | null | undefined, code: string): boolean {
  if (!code) return false
  const lang = (language || "").toLowerCase()
  if (lang === "mermaid") return true
  if (lang === "svg") return true
  if (lang === "html") {
    const src = code.slice(0, 800).toLowerCase()
    if (/<!doctype/i.test(src)) return true
    if (/<html[\s>]/i.test(src)) return true
    if (/<style[\s>]/i.test(src) && /<script[\s>]/i.test(src)) return true
    if (/<canvas[\s>]/i.test(src)) return true
    if (/<svg[^>]*viewbox/i.test(src)) return true
  }
  return false
}

// Wraps raw HTML / SVG fragments in a full document so the iframe
// has valid context. Full documents (with <!DOCTYPE or <html>) pass
// through untouched. Mermaid never goes through the iframe.
function toFullDocument(code: string, language: string): string {
  if (language === "svg") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;padding:16px;display:grid;place-items:center;background:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}svg{max-width:100%;max-height:100%;height:auto}</style>
</head><body>${code}</body></html>`
  }
  const trimmed = code.trimStart()
  if (/^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return code
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${code}</body></html>`
}

export function ArtifactCard({ code, language, title }: ArtifactCardProps) {
  const lang = (language || "").toLowerCase()
  const isMermaid = lang === "mermaid"
  const [showCode, setShowCode] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // Generation counter — bumping this re-keys the iframe / mermaid
  // div, forcing a re-render/reset without reloading the page.
  const [generation, setGeneration] = useState(0)

  const artifactTitle = title || deriveTitle(code) || (isMermaid ? "Diagrama" : "Artefacto")
  const fileName = useMemo(() => sanitizeFilename(artifactTitle) + (isMermaid ? ".svg" : ".html"), [artifactTitle, isMermaid])

  // ── Reset / reload ─────────────────────────────────────────
  const onReset = () => setGeneration((g) => g + 1)

  // ── Download ───────────────────────────────────────────────
  const onDownload = async () => {
    let blob: Blob
    if (isMermaid) {
      const svg = await renderMermaidSvg(code)
      blob = new Blob([svg || code], { type: "image/svg+xml" })
    } else {
      blob = new Blob([toFullDocument(code, lang)], { type: "text/html" })
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

  // ── Open in a new tab ──────────────────────────────────────
  const onOpenNewTab = async () => {
    let blob: Blob
    if (isMermaid) {
      const svg = await renderMermaidSvg(code) || code
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(artifactTitle)}</title>
<style>html,body{margin:0;padding:24px;background:#fff;display:grid;place-items:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}</style>
</head><body>${svg}</body></html>`
      blob = new Blob([html], { type: "text/html" })
    } else {
      blob = new Blob([toFullDocument(code, lang)], { type: "text/html" })
    }
    const url = URL.createObjectURL(blob)
    window.open(url, "_blank", "noopener,noreferrer")
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }

  return (
    <>
      <div className="my-4 overflow-hidden rounded-xl border border-border bg-white dark:bg-zinc-900 shadow-sm">
        {/* Preview surface */}
        <div className="relative bg-white" style={{ minHeight: 240 }}>
          <ArtifactPreview
            key={`preview-${generation}`}
            code={code}
            language={lang}
            heightClass="h-[400px]"
          />

          {/* Absolute overlay button — "Abrir" to pop the artifact out. */}
          <div className="pointer-events-none absolute inset-0 flex items-end justify-end p-3">
            <button
              onClick={() => setExpanded(true)}
              className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-white/90 backdrop-blur-sm px-4 py-1.5 text-sm font-medium text-foreground shadow-md ring-1 ring-black/10 hover:bg-white transition-colors"
              title="Abrir el artefacto a pantalla amplia"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              Abrir
            </button>
          </div>
        </div>

        {/* Action rail */}
        <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-muted/30 px-3 py-2">
          <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {artifactTitle}
          </div>
          <ActionRail
            onReset={onReset}
            onToggleCode={() => setShowCode((s) => !s)}
            showCode={showCode}
            onDownload={onDownload}
            onOpenNewTab={onOpenNewTab}
          />
        </div>

        {/* Source code — collapsed by default, slides down on toggle. */}
        <div
          className="grid transition-[grid-template-rows] duration-300 ease-out"
          style={{ gridTemplateRows: showCode ? "1fr" : "0fr" }}
        >
          <div className="min-h-0 overflow-hidden">
            {showCode && (
              <InlineSource code={code} language={lang === "mermaid" ? "mermaid" : lang === "svg" ? "markup" : "markup"} />
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <ArtifactModal
          code={code}
          language={lang}
          title={artifactTitle}
          onClose={() => setExpanded(false)}
          generation={generation}
          onReset={onReset}
          onToggleCode={() => setShowCode((s) => !s)}
          showCode={showCode}
          onDownload={onDownload}
          onOpenNewTab={onOpenNewTab}
        />
      )}
    </>
  )
}

// ────────────────────────────────────────────────────────────
// Preview surface — iframe for html/svg, Mermaid div otherwise.
// ────────────────────────────────────────────────────────────
function ArtifactPreview({ code, language, heightClass, fillHeight }: {
  code: string; language: string; heightClass?: string; fillHeight?: boolean
}) {
  if (language === "mermaid") return <MermaidRender code={code} heightClass={heightClass} fillHeight={fillHeight} />
  const srcDoc = useMemo(() => toFullDocument(code, language), [code, language])
  return (
    <iframe
      title="artifact"
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
      className={`w-full border-0 bg-white ${fillHeight ? "h-full" : heightClass || "h-[400px]"}`}
      style={{ aspectRatio: fillHeight ? undefined : "16 / 9" }}
    />
  )
}

function MermaidRender({ code, heightClass, fillHeight }: { code: string; heightClass?: string; fillHeight?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
      ; (async () => {
        try {
          const mermaid = (await import("mermaid")).default
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" })
          const id = "artifact-mermaid-" + Math.random().toString(36).slice(2, 9)
          const { svg } = await mermaid.render(id, code)
          if (cancelled || !ref.current) return
          ref.current.innerHTML = svg
          setErr(null)
        } catch (e: any) {
          setErr(e?.message || "Mermaid render failed")
        }
      })()
    return () => { cancelled = true }
  }, [code])

  return (
    <div className={`grid place-items-center overflow-auto bg-white p-4 ${fillHeight ? "h-full" : heightClass || "h-[400px]"}`}>
      {err ? (
        <pre className="text-xs text-rose-600 whitespace-pre-wrap">{err}</pre>
      ) : (
        <div ref={ref} className="max-w-full [&_svg]:max-w-full [&_svg]:h-auto" />
      )}
    </div>
  )
}

async function renderMermaidSvg(code: string): Promise<string | null> {
  try {
    const mermaid = (await import("mermaid")).default
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" })
    const id = "artifact-export-" + Math.random().toString(36).slice(2, 9)
    const { svg } = await mermaid.render(id, code)
    return svg
  } catch {
    return null
  }
}

// ────────────────────────────────────────────────────────────
// 4-button action rail (reused in-card and in the expanded modal).
// ────────────────────────────────────────────────────────────
function ActionRail({ onReset, onToggleCode, showCode, onDownload, onOpenNewTab }: {
  onReset: () => void
  onToggleCode: () => void
  showCode: boolean
  onDownload: () => void
  onOpenNewTab: () => void
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-white dark:bg-zinc-800 shadow-sm ring-1 ring-black/10 px-1.5 py-1">
      <IconButton label="Reiniciar artefacto" onClick={onReset}>
        <RefreshCw className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton label="Ver código fuente" active={showCode} onClick={onToggleCode}>
        <FileCode className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton label="Descargar" onClick={onDownload}>
        <Download className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton label="Abrir en una pestaña nueva" onClick={onOpenNewTab}>
        <ExternalLink className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  )
}

function IconButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid h-7 w-7 place-items-center rounded-full transition-colors ${active
        ? "bg-primary text-primary-foreground"
        : "text-muted-foreground hover:bg-muted hover:text-foreground"
        }`}
    >
      {children}
    </button>
  )
}

// ────────────────────────────────────────────────────────────
// Inline source block — used when the user toggles "Ver código
// fuente". Pared-down version of CustomCodeBlock with copy.
// ────────────────────────────────────────────────────────────
function InlineSource({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <div className="relative border-t border-border/60 bg-gray-900/80">
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-gray-700/60">
        <span className="text-xs font-sans text-gray-400">{language}</span>
        <button onClick={copy} className="text-xs text-gray-400 hover:text-white transition-colors inline-flex items-center gap-1">
          {copied ? <Check size={12} /> : <Clipboard size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <SyntaxHighlighter
        style={oneDark}
        language={language}
        PreTag="div"
        customStyle={{ margin: 0, padding: "1rem", background: "transparent", fontSize: "13px", maxHeight: 320, overflow: "auto" }}
        wrapLongLines
        codeTagProps={{ style: { whiteSpace: "pre-wrap", wordBreak: "break-all" } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// Full-viewport modal with the artifact maximised and the same
// 4 actions in the header. Closed by X or Esc.
// ────────────────────────────────────────────────────────────
function ArtifactModal({
  code, language, title, onClose, generation, onReset, onToggleCode, showCode, onDownload, onOpenNewTab,
}: {
  code: string; language: string; title: string; onClose: () => void; generation: number
  onReset: () => void; onToggleCode: () => void; showCode: boolean
  onDownload: () => void; onOpenNewTab: () => void
}) {
  // Esc closes; reset body scroll on mount+unmount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[100] flex items-stretch justify-center bg-black/60 backdrop-blur-sm p-4 sm:p-8">
      <div className="relative flex w-full max-w-[1200px] flex-col overflow-hidden rounded-2xl bg-white dark:bg-zinc-900 shadow-2xl ring-1 ring-black/10">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5 bg-white dark:bg-zinc-900">
          <div className="min-w-0 flex items-center gap-2">
            <Minimize2 className="h-4 w-4 text-muted-foreground shrink-0" />
            <h3 className="truncate text-sm font-semibold">{title}</h3>
          </div>
          <div className="flex items-center gap-2">
            <ActionRail
              onReset={onReset}
              onToggleCode={onToggleCode}
              showCode={showCode}
              onDownload={onDownload}
              onOpenNewTab={onOpenNewTab}
            />
            <button
              onClick={onClose}
              title="Cerrar"
              aria-label="Cerrar"
              className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="relative flex-1 bg-white">
          <ArtifactPreview key={`modal-preview-${generation}`} code={code} language={language} fillHeight />
        </div>

        {showCode && (
          <div className="max-h-[40vh] overflow-auto">
            <InlineSource code={code} language={language === "mermaid" ? "mermaid" : "markup"} />
          </div>
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────
function deriveTitle(code: string): string | null {
  const m = code.match(/<title[^>]*>([^<]{1,80})<\/title>/i)
  if (m && m[1].trim()) return m[1].trim()
  const h = code.match(/<h1[^>]*>([^<]{1,80})<\/h1>/i)
  if (h && h[1].trim()) return h[1].trim().replace(/<[^>]+>/g, "")
  return null
}

function sanitizeFilename(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "artefacto"
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string))
}
