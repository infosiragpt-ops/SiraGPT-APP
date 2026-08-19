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

import React, { useMemo, useState, useEffect, useRef } from "react"
import {
  RefreshCw, FileCode, Download, ExternalLink, X, Eye, Check, Clipboard,
} from "lucide-react"
import { useArtifactPanel } from "@/lib/artifact-panel-context"
import dynamic from "next/dynamic"
const ShikiCodeView = dynamic(
  () => import("@/components/ui/shiki-code-view").then(m => ({ default: m.ShikiCodeView })),
  { ssr: false, loading: () => <div className="h-full w-full animate-pulse bg-muted/30" aria-hidden="true" /> }
)

/**
 * Focus-trap + body-scroll-lock helper for the mobile drawer. Saves the
 * previously focused element on mount, moves focus into the panel,
 * keeps Tab within the panel while open on small screens, and restores
 * focus on unmount. Body scroll is locked while the panel is mounted on
 * mobile so the underlying chat doesn't bleed through.
 */
function useDialogA11y(
  containerRef: React.RefObject<HTMLDivElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    const previouslyFocused = (typeof document !== "undefined"
      ? (document.activeElement as HTMLElement | null)
      : null)

    // Move focus into the panel (first focusable, else the container itself)
    const node = containerRef.current
    if (node) {
      const focusable = node.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      ;(focusable ?? node).focus({ preventScroll: true })
    }

    // Lock body scroll (mobile drawer behavior)
    const prevOverflow = typeof document !== "undefined" ? document.body.style.overflow : ""
    if (typeof document !== "undefined") {
      document.body.style.overflow = "hidden"
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === "Tab" && node) {
        const focusables = Array.from(
          node.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute("data-focus-skip"))
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey && active === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener("keydown", onKey, true)

    return () => {
      window.removeEventListener("keydown", onKey, true)
      if (typeof document !== "undefined") {
        document.body.style.overflow = prevOverflow
      }
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        try { previouslyFocused.focus({ preventScroll: true }) } catch { /* noop */ }
      }
    }
    // We intentionally only run this on mount/unmount — containerRef / onClose
    // identity is stable enough for the lifetime of one open instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

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
  if (!active) return null
  return <ArtifactPanelMounted close={close} setView={setView} active={active} />
}

function ArtifactPanelMounted({
  active,
  close,
  setView,
}: {
  active: NonNullable<ReturnType<typeof useArtifactPanel>["active"]>
  close: () => void
  setView: (v: "preview" | "code") => void
}) {
  const [generation, setGeneration] = useState(0)
  const { code = "", language = "", title = "", view = "preview" } = active
  const lang = (language || "").toLowerCase()
  const isMermaid = lang === "mermaid"
  const panelRef = useRef<HTMLDivElement | null>(null)

  useDialogA11y(panelRef, close)

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
    // Mobile: full-screen drawer overlay (fixed inset-0, z-40) so the
    // panel doesn't get squeezed into the unusable 30% width that the
    // resizable split assigns it on small viewports. Desktop (sm+):
    // restore the inline split-pane behavior — the parent's
    // resizable divider continues to control width.
    <>
      {/* Mobile backdrop — tap to close. Hidden on desktop where the
          split-pane handles layout instead of an overlay. */}
      <div
        aria-hidden="true"
        data-focus-skip="true"
        onClick={close}
        className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[1px] sm:hidden"
      />
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={title || "Panel de artefacto"}
      tabIndex={-1}
      data-open="true"
      className="fixed inset-0 z-40 flex h-full w-full min-w-0 flex-col bg-white dark:bg-zinc-900 border-l border-border/60 transition-transform duration-200 ease-out translate-x-full data-[open=true]:translate-x-0 sm:relative sm:inset-auto sm:z-auto sm:translate-x-0 sm:transition-none"
    >
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
          <IconButton label="Cerrar" onClick={close} large><X className="h-4 w-4" /></IconButton>
        </div>
      </div>

      {/* Content */}
      <div className="relative flex-1 min-h-0 bg-white dark:bg-card">
        {view === "preview" ? (
          isMermaid ? (
            <MermaidFill code={code} key={`mermaid-${generation}`} />
          ) : (
            <iframe
              key={`iframe-${generation}`}
              title="artifact-panel"
              srcDoc={srcDoc}
              sandbox="allow-scripts"
              className="h-full w-full border-0 bg-white dark:bg-card"
            />
          )
        ) : (
          <div className="h-full overflow-auto">
            <ShikiCodeView
              code={code}
              language={lang === "mermaid" ? "mermaid" : "html"}
              wrapLongLines
              className="min-h-full bg-[#0f172a]"
              codeClassName="[&_pre]:min-h-full [&_pre]:p-5"
            />
          </div>
        )}
      </div>
    </div>
    </>
  )
}

function IconButton({ label, onClick, children, large = false }: { label: string; onClick: () => void; children: React.ReactNode; large?: boolean }) {
  // `large` enlarges the touch target on mobile (h-10 w-10) while keeping
  // the compact desktop size (h-8 w-8). Used for the close button so it
  // meets the 44px touch-target guideline on small screens.
  const sizeClass = large
    ? "h-10 w-10 sm:h-8 sm:w-8"
    : "h-8 w-8"
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid ${sizeClass} place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50`}
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
