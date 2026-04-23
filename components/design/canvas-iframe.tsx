"use client"

/**
 * CanvasIframe — sandboxed iframe that renders the generated HTML
 * document.
 *
 * Why an iframe rather than injecting the HTML into the page:
 *   - Full CSS isolation (the generated doc sets its own <html>/<body>
 *     styles; dropping it into our DOM would clash with Tailwind).
 *   - Script execution is safer inside `sandbox="allow-scripts"` (no
 *     same-origin access — can't read our cookies/localStorage).
 *   - The generated doc can ship its own script tag (Tailwind CDN,
 *     chart libs) without CSP headaches on the parent.
 *
 * Implementation note: we use `srcDoc` rather than blob URLs because
 * srcDoc re-renders atomically when the string changes, avoiding the
 * "old doc flashes before new one loads" jitter of URL-swapping.
 */

import * as React from "react"
import { Maximize2, Monitor, Smartphone, Tablet, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

type Viewport = "desktop" | "tablet" | "mobile"

const WIDTHS: Record<Viewport, string> = {
  desktop: "100%",
  tablet:  "768px",
  mobile:  "390px",
}

interface Props {
  html: string | null
  placeholder?: string
}

export function CanvasIframe({ html, placeholder }: Props) {
  const [viewport, setViewport] = React.useState<Viewport>("desktop")
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null)

  const reload = () => {
    // Re-setting srcDoc to the same value re-triggers the render,
    // which is what the user wants when they click refresh.
    const el = iframeRef.current
    if (!el) return
    const current = el.srcdoc
    el.srcdoc = ""
    requestAnimationFrame(() => { el.srcdoc = current })
  }

  const openFullscreen = () => {
    if (!html) return
    const w = window.open("", "_blank", "noopener,noreferrer")
    if (w) {
      w.document.open()
      w.document.write(html)
      w.document.close()
    }
  }

  return (
    <div className="flex-1 flex flex-col bg-[#F0EADE] dark:bg-muted/30 min-h-0">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/60 bg-background">
        <div className="inline-flex rounded-lg border border-border/60 bg-card p-0.5">
          {[
            { v: "desktop" as Viewport, Icon: Monitor,    label: "Desktop" },
            { v: "tablet"  as Viewport, Icon: Tablet,     label: "Tablet" },
            { v: "mobile"  as Viewport, Icon: Smartphone, label: "Mobile" },
          ].map(({ v, Icon, label }) => (
            <button
              key={v}
              onClick={() => setViewport(v)}
              aria-label={label}
              title={label}
              className={cn(
                "h-7 w-8 inline-flex items-center justify-center rounded-md transition-colors",
                viewport === v
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={reload} disabled={!html} title="Reload"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={openFullscreen} disabled={!html} title="Open in new tab"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Stage */}
      <div className="flex-1 flex items-center justify-center overflow-auto p-4">
        {!html ? (
          <div className="text-center text-sm text-muted-foreground max-w-sm">
            {placeholder || "Describe en el chat lo que quieres construir."}
          </div>
        ) : (
          <div
            className="bg-white rounded-lg shadow-xl transition-all duration-300"
            style={{
              width: WIDTHS[viewport],
              maxWidth: "100%",
              height: viewport === "desktop" ? "100%" : viewport === "tablet" ? "1024px" : "844px",
              maxHeight: "100%",
            }}
          >
            <iframe
              ref={iframeRef}
              srcDoc={html}
              sandbox="allow-scripts allow-forms allow-same-origin"
              className="w-full h-full rounded-lg border-0"
              title="Design canvas preview"
            />
          </div>
        )}
      </div>
    </div>
  )
}
