"use client"

import * as React from "react"

/** Shared by live and completed answers, so narrow tables keep their natural width. */
export function ChatTable({ children, controls, label = "Tabla del mensaje" }: {
  children: React.ReactNode
  controls?: React.ReactNode
  label?: string
}) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const tableRef = React.useRef<HTMLTableElement>(null)
  const hintId = React.useId()
  const [hasOverflow, setHasOverflow] = React.useState(false)
  const measure = React.useCallback(() => {
    const viewport = viewportRef.current
    if (viewport) setHasOverflow(viewport.scrollWidth > viewport.clientWidth + 1)
  }, [])

  React.useEffect(() => {
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    if (viewportRef.current) observer?.observe(viewportRef.current)
    if (tableRef.current) observer?.observe(tableRef.current)
    window.addEventListener("resize", measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [measure])

  // A streamed cell can change scrollWidth without changing the viewport size.
  React.useEffect(measure, [children, measure])

  return (
    <div className="not-prose my-4 w-full min-w-0 max-w-full overflow-hidden rounded-xl border border-border/70 bg-background font-sans">
      {controls}
      <div
        ref={viewportRef}
        role={hasOverflow ? "region" : undefined}
        aria-label={hasOverflow ? label : undefined}
        aria-describedby={hasOverflow ? hintId : undefined}
        tabIndex={hasOverflow ? 0 : undefined}
        className="w-full min-w-0 overflow-x-auto overscroll-x-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <table ref={tableRef} className="m-0 w-full border-collapse text-sm [&_tbody_tr:last-child_td]:border-b-0">
          {children}
        </table>
      </div>
      {hasOverflow && (
        <p id={hintId} data-copy-exclude="" className="m-0 border-t border-border/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
          Desplázate horizontalmente para ver todas las columnas.
        </p>
      )}
    </div>
  )
}
