"use client"

// codex/web-tab — full-screen webview of the live sandbox URL (feature 13): a
// chromeless iframe with a thin URL bar + open-in-new-tab.

import React from "react"
import { useTranslations } from "next-intl"
import { ExternalLink, Globe } from "lucide-react"

export function WebTab({ url }: { url: string | null }) {
  const t = useTranslations("codex")
  if (!url) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-500">
        <Globe className="h-6 w-6 opacity-50" />
        {t("panel.webUnavailable")}
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-2 py-1.5">
        <Globe className="h-3.5 w-3.5 text-zinc-500" />
        <code className="flex-1 truncate text-xs text-zinc-400">{url}</code>
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-zinc-400 hover:text-zinc-200" aria-label={t("panel.openInTab")}><ExternalLink className="h-3.5 w-3.5" /></a>
      </div>
      <iframe src={url} title={t("tabs.preview")} className="flex-1 border-0 bg-white" sandbox="allow-scripts allow-same-origin allow-forms" />
    </div>
  )
}
