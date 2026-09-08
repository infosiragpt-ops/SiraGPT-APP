"use client"

import * as React from "react"
import { CheckCircle2, Cpu, Download, MonitorSmartphone, ShieldAlert } from "lucide-react"
import type { MobileReleaseAsset, MobileReleasePlatform } from "@/lib/mobile-releases"

type ReleaseCatalog = Partial<Record<MobileReleasePlatform, MobileReleaseAsset | null>>

const PLAY_STORE_ISSUE_URL = "https://github.com/infosiragpt-ops/SiraGPT-APP/issues/5"

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ""
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Android card: a real APK download (served via /api/mobile/download, which
 * resolves the latest GitHub QA release and falls back to a known public
 * asset) plus the Chrome PWA install path. The Play Store note is honest:
 * publishing is blocked on owner Play Console enrollment (issue #5).
 */
export function AndroidDownloadCard() {
  const [release, setRelease] = React.useState<MobileReleaseAsset | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    fetch("/api/mobile/releases", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("release_lookup_failed")
        return response.json()
      })
      .then((payload: { releases?: ReleaseCatalog }) => {
        setRelease(payload.releases?.["android-apk"] ?? null)
      })
      .catch(() => {
        // The download button below does not depend on this metadata fetch:
        // /api/mobile/download always resolves or falls back server-side.
      })
    return () => controller.abort()
  }, [])

  return (
    <article id="android" className="scroll-mt-24 border border-neutral-200 p-5 dark:border-white/10" style={{ borderRadius: 8 }}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-neutral-100 dark:bg-white/10">
            <MonitorSmartphone className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-lg font-bold">SiraGPT para Android</h2>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">APK instalable o app web desde Chrome</p>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold uppercase text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300">
          Disponible hoy
        </span>
      </div>

      {release ? (
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-500 dark:text-neutral-400">
          <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" />Versión {release.version}</span>
          <span className="inline-flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5" />{formatBytes(release.sizeBytes)}</span>
        </div>
      ) : null}

      <div className="mt-4">
        <a
          href="/api/mobile/download?platform=android"
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-neutral-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/30 focus-visible:ring-offset-2 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Descargar APK
        </a>
      </div>

      <div className="mt-4 flex gap-2.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <p>
          APK de evaluación (QA). Android pedirá permitir la instalación desde el navegador porque aún no viene de
          Play Store. La publicación en Google Play está pendiente de que el propietario complete el alta en Play
          Console (<a href={PLAY_STORE_ISSUE_URL} className="underline underline-offset-2" target="_blank" rel="noopener noreferrer">issue #5</a>).
        </p>
      </div>

      <div className="mt-5 border-t border-neutral-200 pt-4 dark:border-white/10">
        <h3 className="text-sm font-semibold">¿Prefieres no instalar el APK?</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          <li>Abre siragpt.com en Chrome.</li>
          <li>Toca el menú ⋮ y elige “Instalar aplicación” (o acepta el aviso de instalación).</li>
          <li>SiraGPT queda en tu pantalla de inicio como app.</li>
        </ol>
      </div>
    </article>
  )
}
