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
import { AccessibleIconButton } from "@/components/ui/accessible-icon-button"
import { fetchWithPresignRetry, isExpiredPresignUrl } from "@/lib/attachment-url"
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
function useMobileDrawer(): boolean {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const media = window.matchMedia("(max-width: 767px)")
    const sync = () => setIsMobile(media.matches)
    sync()
    if (typeof media.addEventListener === "function") media.addEventListener("change", sync)
    else media.addListener(sync)
    return () => {
      if (typeof media.removeEventListener === "function") media.removeEventListener("change", sync)
      else media.removeListener(sync)
    }
  }, [])

  return isMobile
}

function useDialogA11y(
  containerRef: React.RefObject<HTMLDivElement | null>,
  onClose: () => void,
  isModal: boolean,
) {
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return
    const previouslyFocused = (typeof document !== "undefined"
      ? (document.activeElement as HTMLElement | null)
      : null)

    const node = containerRef.current
    // The inline desktop split is part of the page, not a modal: do not steal
    // focus, lock scrolling or trap Tab there. Those behaviours belong only
    // to the full-screen mobile drawer.
    if (isModal && node) {
      const focusable = node.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      ;(focusable ?? node).focus({ preventScroll: true })
    }

    // Lock body scroll (mobile drawer behavior)
    const prevOverflow = document.body.style.overflow
    if (isModal) document.body.style.overflow = "hidden"

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (isModal && e.key === "Tab" && node) {
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
      if (isModal) document.body.style.overflow = prevOverflow
      if (isModal && previouslyFocused && typeof previouslyFocused.focus === "function") {
        try { previouslyFocused.focus({ preventScroll: true }) } catch { /* noop */ }
      }
    }
  }, [containerRef, isModal])
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
  const isMobileDrawer = useMobileDrawer()

  useDialogA11y(panelRef, close, isMobileDrawer)

  const srcDoc = useMemo(() => {
    if (isMermaid) return ""
    return toFullDocument(code, lang)
  }, [code, lang, isMermaid])

  const fileName = sanitizeFilename(title || "artefacto") + (isMermaid ? ".svg" : ".html")

  const onReset = () => setGeneration((g) => g + 1)

  const onDownload = async () => {
    if (/^https?:\/\//i.test(code) && (isExpiredPresignUrl(code) || code.includes("X-Amz-"))) {
      const res = await fetchWithPresignRetry(code)
      if (res.ok) {
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = fileName
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1500)
        return
      }
    }
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

  // The artifact document is agent-controlled; opening it top-level
  // would run it with the app's own origin. The tab instead gets a
  // static wrapper embedding the artifact in a sandboxed,
  // opaque-origin iframe — same contract as the inline preview.
  const onOpenNewTab = async () => {
    let innerDoc: string
    if (isMermaid) {
      const svg = (await renderMermaidSvg(code)) || code
      innerDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title || "Artefacto")}</title>
<style>html,body{margin:0;padding:24px;background:#fff;display:grid;place-items:center}</style>
</head><body>${svg}</body></html>`
    } else {
      innerDoc = srcDoc
    }
    const wrapper = buildTabWrapperDocument(innerDoc, escapeHtml(title || "Artefacto"))
    const url = URL.createObjectURL(new Blob([wrapper], { type: "text/html" }))
    window.open(url, "_blank", "noopener,noreferrer")
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }

  return (
    // Mobile: full-screen drawer overlay (fixed inset-0, z-40) so the
    // panel doesn't get squeezed into the unusable 30% width that the
    // resizable split assigns it on small viewports. Desktop (md+ / 768):
    // restore the inline split-pane behavior — the parent's
    // resizable divider continues to control width.
    <>
      {/* Mobile backdrop — tap to close. Hidden on desktop where the
          split-pane handles layout instead of an overlay. */}
      {isMobileDrawer ? (
        <div
          aria-hidden="true"
          data-focus-skip="true"
          onClick={close}
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[1px]"
        />
      ) : null}
    <div
      ref={panelRef}
      role={isMobileDrawer ? "dialog" : "region"}
      aria-modal={isMobileDrawer ? true : undefined}
      aria-label={title || "Panel de artefacto"}
      tabIndex={-1}
      data-open="true"
      data-presentation={isMobileDrawer ? "mobile-drawer" : "desktop-split"}
      className="fixed inset-0 z-40 flex h-full w-full min-w-0 flex-col bg-white dark:bg-zinc-900 border-l border-border/60 transition-transform duration-200 ease-out translate-x-full data-[open=true]:translate-x-0 md:relative md:inset-auto md:z-auto md:translate-x-0 md:transition-none"
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
              className={`grid h-11 w-14 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:h-7 ${view === "preview" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              aria-pressed={view === "preview"}
            >
              Vista
            </button>
            <button
              onClick={() => setView("code")}
              className={`grid h-11 w-14 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:h-7 ${view === "code" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              aria-pressed={view === "code"}
            >
              Código
            </button>
          </div>
          <IconButton label="Reiniciar" onClick={onReset}><RefreshCw className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Descargar" onClick={onDownload}><Download className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Abrir en nueva pestaña" onClick={onOpenNewTab}><ExternalLink className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Cerrar" onClick={close}><X className="h-4 w-4" aria-hidden="true" /></IconButton>
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

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <AccessibleIconButton
      onClick={onClick}
      label={label}
    >
      {children}
    </AccessibleIconButton>
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

// Static host document for "open in new tab". The agent-controlled
// artifact is embedded via srcDoc into a sandboxed iframe with an
// opaque origin, so scripts inside it can never touch the opener,
// the app origin, or localStorage['auth-token'].
function buildTabWrapperDocument(innerDoc: string, titleHtmlEscaped: string): string {
  // \u003c keeps any "</script>" inside the artifact from closing the
  // host document's own script block.
  const payload = JSON.stringify(innerDoc).replace(/</g, "\\u003c")
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${titleHtmlEscaped}</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;width:100%;height:100%;border:0}</style>
</head><body><iframe id="frame" sandbox="allow-scripts allow-forms allow-popups allow-modals" title="${titleHtmlEscaped}"></iframe>
<script>
(function(){
  var doc = ${payload};
  var f = document.getElementById('frame');
  f.srcdoc = doc;
})();
</script></body></html>`
}

function sanitizeFilename(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "artefacto"
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string))
}
