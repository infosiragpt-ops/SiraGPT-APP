/**
 * Install-surface detection for the /descargas install coach.
 *
 * Safari on iOS never fires `beforeinstallprompt`, so the only honest
 * install path there is teaching the user the Compartir → Añadir a
 * pantalla de inicio gesture. Chromium browsers (Android/desktop) do fire
 * the event and can show a real install prompt.
 */

export type InstallSurface = "ios-safari" | "ios-other-browser" | "android" | "other"

export function detectInstallSurface(userAgent: string): InstallSurface {
  const ua = userAgent || ""
  const isIos = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua))
  if (isIos) {
    // Chrome (CriOS), Firefox (FxiOS), Edge (EdgiOS)… all lack the native
    // share-sheet install flow wording; Añadir a pantalla de inicio only
    // lives in Safari's share sheet.
    const isAlternateBrowser = /CriOS|FxiOS|EdgiOS|OPT\/|DuckDuckGo/i.test(ua)
    return isAlternateBrowser ? "ios-other-browser" : "ios-safari"
  }
  if (/Android/i.test(ua)) return "android"
  return "other"
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return window.matchMedia?.("(display-mode: standalone)")?.matches === true || nav.standalone === true
}
