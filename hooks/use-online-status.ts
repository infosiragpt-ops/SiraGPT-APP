"use client"

/**
 * useOnlineStatus — single source of truth for browser connectivity.
 *
 * Reads `navigator.onLine` on the server render (always `true` there, so
 * SSR markup matches the common case and hydration stays stable) and then
 * tracks the browser's `online`/`offline` events on the client.
 *
 * Why a shared hook instead of every component wiring its own listeners:
 * the offline banner, the composer send buttons, and the /code composer
 * all need the same answer; one hook keeps them consistent and keeps the
 * listener wiring in one place.
 */

import * as React from "react"

export function useOnlineStatus(): boolean {
  // Server + first client render: assume online (navigator.onLine is not
  // available during SSR and hydration mismatch on a transient network
  // state is worse than a one-tick-late banner).
  const [online, setOnline] = React.useState(true)

  React.useEffect(() => {
    setOnline(navigator.onLine)
    const goOffline = () => setOnline(false)
    const goOnline = () => setOnline(true)
    window.addEventListener("offline", goOffline)
    window.addEventListener("online", goOnline)
    return () => {
      window.removeEventListener("offline", goOffline)
      window.removeEventListener("online", goOnline)
    }
  }, [])

  return online
}
