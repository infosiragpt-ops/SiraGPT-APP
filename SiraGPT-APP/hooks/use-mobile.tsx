"use client"

import * as React from "react"

const MOBILE_BREAKPOINT = 768

function subscribeMobile(onChange: (isMobile: boolean) => void) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  const update = () => onChange(window.innerWidth < MOBILE_BREAKPOINT)
  mql.addEventListener("change", update)
  update()
  return () => mql.removeEventListener("change", update)
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => subscribeMobile(setIsMobile), [])

  return !!isMobile
}

/**
 * Chat split mins are 420px (transcript) + 460px (preview). Below this
 * width the right pane is clipped off-screen, so generated documents
 * must open as a full-screen overlay instead of a desktop split.
 */
export const DOCUMENT_PREVIEW_OVERLAY_MAX_PX = 879

function subscribeMaxWidth(maxPx: number, onChange: (matches: boolean) => void) {
  const mql = window.matchMedia(`(max-width: ${maxPx}px)`)
  const update = () => onChange(mql.matches)
  if (typeof mql.addEventListener === "function") mql.addEventListener("change", update)
  else mql.addListener(update)
  update()
  return () => {
    if (typeof mql.removeEventListener === "function") mql.removeEventListener("change", update)
    else mql.removeListener(update)
  }
}

export function useCompactViewport(maxPx: number): boolean {
  const [matches, setMatches] = React.useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
    return window.matchMedia(`(max-width: ${maxPx}px)`).matches
  })

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    return subscribeMaxWidth(maxPx, setMatches)
  }, [maxPx])

  return matches
}

/** True on phones / small tablets where the document split cannot fit. */
export function useDocumentPreviewOverlay(): boolean {
  return useCompactViewport(DOCUMENT_PREVIEW_OVERLAY_MAX_PX)
}

/** `null` only during SSR. Client components read the viewport on first paint. */
export function useResolvedMobile(): boolean | null {
  const [isMobile, setIsMobile] = React.useState<boolean | null>(() => {
    if (typeof window === "undefined") return null
    return window.innerWidth < MOBILE_BREAKPOINT
  })

  React.useEffect(() => subscribeMobile(setIsMobile), [])

  return isMobile
}
