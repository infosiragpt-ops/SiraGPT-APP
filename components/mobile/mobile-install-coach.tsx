"use client"

import * as React from "react"
import { PlusSquare, Share, X } from "lucide-react"
import PWAInstallPrompt from "@/components/PWAInstallPrompt"
import { detectInstallSurface, isStandaloneDisplay, type InstallSurface } from "@/lib/mobile-install"

const IOS_DISMISS_KEY = "siragpt.pwa.iosInstallCoach.dismissed"

function readIosDismissed(): boolean {
  try {
    return window.localStorage?.getItem(IOS_DISMISS_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * Install coach for /descargas.
 *
 * - iOS Safari has NO `beforeinstallprompt`, so a prompt() flow is
 *   impossible: we show a persistent, dismissible "Instalar en iPhone"
 *   sheet teaching the Compartir → Añadir a pantalla de inicio gesture.
 * - Chromium (Android/desktop Chrome/Edge) does fire the event, so there
 *   we reuse PWAInstallPrompt with a real install button. On this page the
 *   visitor explicitly came to install, so the anti-spam thresholds are
 *   relaxed (no interaction count, short delay) while dismissal memory is
 *   kept.
 */
export function MobileInstallCoach() {
  const [surface, setSurface] = React.useState<InstallSurface | null>(null)
  const [iosDismissed, setIosDismissed] = React.useState(true)

  React.useEffect(() => {
    if (isStandaloneDisplay()) return
    setSurface(detectInstallSurface(window.navigator.userAgent))
    setIosDismissed(readIosDismissed())
  }, [])

  const dismissIos = React.useCallback(() => {
    try {
      window.localStorage?.setItem(IOS_DISMISS_KEY, "1")
    } catch {
      /* ignore */
    }
    setIosDismissed(true)
  }, [])

  if (surface === "ios-safari" || surface === "ios-other-browser") {
    if (iosDismissed) return null
    return (
      <div
        role="dialog"
        aria-label="Instalar SiraGPT en iPhone"
        className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-2xl border border-neutral-200 bg-white p-4 shadow-lg dark:border-white/10 dark:bg-neutral-900 sm:bottom-6"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-neutral-950 dark:text-white">Instalar en iPhone</p>
            {surface === "ios-safari" ? (
              <ol className="mt-2 space-y-1.5 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
                <li className="flex items-center gap-1.5">
                  <span className="font-semibold">1.</span>
                  Toca
                  <Share className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="font-medium">Compartir</span> en la barra de Safari.
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="font-semibold">2.</span>
                  Elige
                  <PlusSquare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="font-medium">Añadir a pantalla de inicio</span>.
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="font-semibold">3.</span>
                  Confirma con <span className="font-medium">Añadir</span>.
                </li>
              </ol>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
                Este navegador no puede instalar la app en iPhone. Abre siragpt.com en Safari y usa Compartir →
                Añadir a pantalla de inicio.
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Cerrar guía de instalación"
            onClick={dismissIos}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-neutral-500 transition hover:bg-neutral-100 dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    )
  }

  // Chromium path: only renders after `beforeinstallprompt` actually fires,
  // so on unsupported browsers this stays invisible.
  return <PWAInstallPrompt minInteractions={0} minDelayMs={2_500} />
}
