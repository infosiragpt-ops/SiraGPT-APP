"use client"

/**
 * PlanViewer — renders a DXF string using the `dxf-viewer` library.
 *
 * The upstream API takes a URL, so we wrap the string in a blob and
 * hand over the object URL. Blob URLs are revoked on unmount and on
 * each new DXF to avoid leaks; the viewer instance is recreated on
 * each new DXF because `.Clear()` leaves the renderer DOM element in
 * a half-initialised state between loads.
 *
 * Critical detail: dxf-viewer's `clearColor` option expects a
 * `THREE.Color` instance (it calls `.getHex()` on it in the
 * constructor). Passing a plain `{r,g,b,a}` object throws silently
 * and the viewer renders a blank canvas. We build the Color from the
 * same `three` package the library consumes to avoid version drift.
 */

import * as React from "react"
import * as THREE from "three"

interface Props {
  dxf: string | null
  className?: string
}

export function PlanViewer({ dxf, className }: Props) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const viewerRef = React.useRef<any>(null)
  const urlRef = React.useRef<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  // Load/reload when the DXF changes. We recreate the viewer every
  // time — Clear() is not reliable enough across back-to-back loads
  // for our use case (re-renders triggered by chat re-mount).
  React.useEffect(() => {
    if (!dxf || !containerRef.current) return
    let cancelled = false
    setError(null)
    setLoading(true)

    // Revoke the previous blob URL.
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }

    // Dispose the previous viewer.
    if (viewerRef.current) {
      try { viewerRef.current.Destroy?.() } catch { /* */ }
      viewerRef.current = null
    }
    // Clear any stray canvases left by a previous mount.
    if (containerRef.current) {
      containerRef.current.innerHTML = ""
    }

    const blob = new Blob([dxf], { type: "application/dxf" })
    const url = URL.createObjectURL(blob)
    urlRef.current = url

    ;(async () => {
      try {
        const { DxfViewer } = await import("dxf-viewer")
        if (cancelled || !containerRef.current) return
        const viewer = new DxfViewer(containerRef.current, {
          clearColor: new THREE.Color("#ffffff"),
          clearAlpha: 1,
          autoResize: true,
          colorCorrection: true,
          blackWhiteInversion: false,
        })
        viewerRef.current = viewer
        await viewer.Load({ url })
        if (cancelled) return
        setLoading(false)
      } catch (e: any) {
        if (cancelled) return
        console.error("[plan-viewer] load error:", e)
        setError(e?.message || "No se pudo cargar el plano")
        setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [dxf])

  // Full cleanup on unmount.
  React.useEffect(() => {
    return () => {
      if (viewerRef.current) {
        try { viewerRef.current.Destroy?.() } catch { /* */ }
        viewerRef.current = null
      }
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
  }, [])

  return (
    <div className={`relative w-full h-full bg-white ${className || ""}`}>
      <div ref={containerRef} className="absolute inset-0" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/60 text-sm text-muted-foreground">
          Dibujando plano…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-destructive px-6 text-center">
          {error}
        </div>
      )}
      {!dxf && !loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Sin plano
        </div>
      )}
    </div>
  )
}
