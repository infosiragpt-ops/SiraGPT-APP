"use client"

import { useEffect, useState } from "react"
import { getMyCredits, isLowBalance, type Credits } from "@/lib/credits-service"

/**
 * F3 PR11 — Sidebar badge showing the authenticated user's credit
 * balance + a low-balance warning highlight. Polls every 30 seconds
 * while mounted, with an opportunistic refresh on tab focus so the
 * number is accurate after a paraphrase / image-generation spend.
 *
 * Visually conservative — reuses the existing sidebar token colours
 * via the className-only API so the shell layout stays unchanged.
 */
export function CreditsBadge({ className = "" }: { className?: string }) {
  const [credits, setCredits] = useState<Credits | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const data = await getMyCredits()
        if (!cancelled) {
          setCredits(data)
          setLoading(false)
        }
      } catch (_err) {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const interval = window.setInterval(load, 30_000)
    const onFocus = () => load()
    window.addEventListener("focus", onFocus)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener("focus", onFocus)
    }
  }, [])

  if (loading) {
    return (
      <span
        className={`inline-flex items-center text-xs text-zinc-400 ${className}`}
        aria-label="Cargando créditos"
        data-testid="credits-badge-loading"
      >
        …
      </span>
    )
  }

  if (!credits) return null

  const low = isLowBalance(credits)
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        low
          ? "bg-amber-500/10 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300"
          : "bg-zinc-500/10 text-zinc-600 dark:bg-zinc-500/20 dark:text-zinc-300"
      } ${className}`}
      aria-label={`${credits.balance} créditos disponibles${low ? ", saldo bajo" : ""}`}
      title={`Saldo: ${credits.balance} créditos`}
      data-testid="credits-badge"
    >
      <span aria-hidden="true">◐</span>
      <span>{credits.balance}</span>
    </span>
  )
}

export default CreditsBadge
