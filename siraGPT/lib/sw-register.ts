/**
 * sw-register — scaffolded service worker bootstrap.
 *
 * This module is NOT auto-imported anywhere; CLAUDE.md rule #1
 * forbids modifying visual components (including app/layout.tsx).
 * When the team is ready, call `registerSiraServiceWorker()` from a
 * `useEffect` in any existing client component, e.g.:
 *
 *   useEffect(() => { registerSiraServiceWorker() }, [])
 *
 * It is a no-op in dev (NODE_ENV !== "production") and on environments
 * without the Service Worker API.
 */

const SW_URL = "/sw.js"

export function registerSiraServiceWorker(): void {
  if (typeof window === "undefined") return
  if (process.env.NODE_ENV !== "production") return
  if (!("serviceWorker" in navigator)) return

  // Defer to idle so we don't compete with first-paint critical work.
  const start = () => {
    navigator.serviceWorker
      .register(SW_URL, { scope: "/" })
      .catch(() => {
        // Registration failures are non-fatal; the app must keep working.
      })
  }

  if (document.readyState === "complete") {
    start()
  } else {
    window.addEventListener("load", start, { once: true })
  }
}

export function unregisterSiraServiceWorker(): void {
  if (typeof window === "undefined") return
  if (!("serviceWorker" in navigator)) return
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => r.unregister().catch(() => {}))
  })
}
