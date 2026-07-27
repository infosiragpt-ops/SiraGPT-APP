"use client"

import * as React from "react"
import { CheckCircle2, Cpu, Download, Laptop, ShieldAlert } from "lucide-react"
import type { DesktopReleaseAsset, DesktopReleasePlatform } from "@/lib/desktop-releases"

type ReleaseCatalog = Record<DesktopReleasePlatform, DesktopReleaseAsset | null>

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ""
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

function DownloadButton({ release, label }: { release: DesktopReleaseAsset; label: string }) {
  return (
    <a
      href={`/api/desktop/download?platform=${release.platform}&channel=beta`}
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-neutral-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/30 focus-visible:ring-offset-2 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200"
    >
      <Download className="h-4 w-4" aria-hidden="true" />
      {label}
    </a>
  )
}

export function DesktopDownloadCard({ platform }: { platform: "macos" | "windows" }) {
  const [catalog, setCatalog] = React.useState<ReleaseCatalog | null>(null)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    const controller = new AbortController()
    fetch("/api/desktop/releases?channel=beta", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("release_lookup_failed")
        return response.json()
      })
      .then((payload) => setCatalog(payload.releases))
      .catch((error) => {
        if (error?.name !== "AbortError") setFailed(true)
      })
    return () => controller.abort()
  }, [])

  const releases = platform === "macos"
    ? [catalog?.["macos-arm64"], catalog?.["macos-x64"]].filter(Boolean) as DesktopReleaseAsset[]
    : [catalog?.["windows-x64"]].filter(Boolean) as DesktopReleaseAsset[]
  const currentRelease = releases[0]

  return (
    <section
      id={platform === "macos" ? "mac" : "windows"}
      className="scroll-mt-24 border border-neutral-200 p-5 dark:border-white/10"
      style={{ borderRadius: 8 }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-neutral-100 dark:bg-white/10">
            <Laptop className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-lg font-bold">{platform === "macos" ? "SiraGPT para Mac" : "SiraGPT para Windows"}</h2>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {platform === "macos" ? "macOS 11 o posterior" : "Windows 10/11 de 64 bits"}
            </p>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300">
          Beta
        </span>
      </div>

      {!catalog && !failed ? (
        <div className="mt-6 h-[112px] animate-pulse rounded-lg bg-neutral-100 dark:bg-white/5" aria-label="Consultando versión disponible" />
      ) : null}

      {currentRelease ? (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" />Versión {currentRelease.version}</span>
            <span className="inline-flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5" />{formatBytes(currentRelease.sizeBytes)}</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {platform === "macos" ? (
              releases.map((release) => (
                <DownloadButton
                  key={release.platform}
                  release={release}
                  label={release.platform === "macos-arm64" ? "Apple Silicon" : "Mac Intel"}
                />
              ))
            ) : (
              <DownloadButton release={currentRelease} label="Descargar instalador" />
            )}
          </div>
          <div className="mt-5 flex gap-2.5 border-t border-neutral-200 pt-4 text-xs leading-relaxed text-neutral-500 dark:border-white/10 dark:text-neutral-400">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <p>
              Versión de evaluación. El sistema puede mostrar una advertencia porque la firma pública del instalador aún está en proceso.
            </p>
          </div>
        </>
      ) : null}

      {failed || (catalog && releases.length === 0) ? (
        <div className="mt-5 rounded-lg bg-neutral-100 p-4 text-sm text-neutral-600 dark:bg-white/5 dark:text-neutral-300">
          El instalador no está disponible temporalmente. Puedes continuar usando SiraGPT desde el navegador.
        </div>
      ) : null}
    </section>
  )
}
