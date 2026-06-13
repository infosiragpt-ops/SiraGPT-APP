"use client"

// codex/action-required-card — "Acción requerida de su parte 🔴" (feature 11).
// Blocking, so NOT collapsed by default: the raw error in a copyable code block,
// the list of blocked capabilities, and a remediation link.

import React, { useState } from "react"
import { useTranslations } from "next-intl"
import { Copy, Check, ExternalLink } from "lucide-react"

export interface ActionRequiredCardProps {
  title: string
  rawError: string
  blockedCapabilities: string[]
  remediationUrl?: string
}

export function ActionRequiredCard({ title, rawError, blockedCapabilities, remediationUrl }: ActionRequiredCardProps) {
  const t = useTranslations("codex")
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(rawError)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked */ }
  }

  const isInternal = remediationUrl?.startsWith("/")

  return (
    <div className="my-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
      <div className="text-sm font-semibold text-red-300">🔴 {t("actionRequired.title")}</div>
      <div className="mt-1 text-sm text-zinc-200">{title}</div>

      <div className="relative mt-2">
        <button type="button" onClick={copy} className="absolute right-2 top-2 flex items-center gap-1 rounded border border-white/10 bg-zinc-900/80 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800">
          {copied ? <><Check className="h-3 w-3 text-emerald-400" /> {t("actionRequired.copied")}</> : <><Copy className="h-3 w-3" /> {t("actionRequired.copy")}</>}
        </button>
        <pre className="max-h-48 overflow-auto rounded-lg bg-black/50 p-2.5 pr-16 text-[11px] leading-relaxed text-zinc-300">{rawError}</pre>
      </div>

      {blockedCapabilities.length > 0 && (
        <div className="mt-2 text-xs text-zinc-400">
          <span className="font-medium text-zinc-300">{t("actionRequired.blockedCapabilities")}</span>
          <ul className="mt-0.5 list-disc pl-5">{blockedCapabilities.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </div>
      )}

      {remediationUrl && (
        <a
          href={remediationUrl}
          target={isInternal ? undefined : "_blank"}
          rel={isInternal ? undefined : "noopener noreferrer"}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
        >
          {t("actionRequired.remediate")} <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  )
}
