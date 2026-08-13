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

/** `null` only during SSR. Client components read the viewport on first paint. */
export function useResolvedMobile(): boolean | null {
  const [isMobile, setIsMobile] = React.useState<boolean | null>(() => {
    if (typeof window === "undefined") return null
    return window.innerWidth < MOBILE_BREAKPOINT
  })

  React.useEffect(() => subscribeMobile(setIsMobile), [])

  return isMobile
}
