"use client"

import * as React from "react"
import { Globe, ArrowRight } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { getSameOriginApiBaseUrl } from "@/lib/api-base-url"
import { sanitizeNavigateUrl } from "@/lib/computer-navigate"

export type IntegratedBrowserBarProps = {
  conversationId?: string | null
  initialUrl?: string
  compact?: boolean
  onNavigated?: (url: string) => void
}

export function IntegratedBrowserBar({
  conversationId,
  initialUrl = "",
  compact = false,
  onNavigated,
}: IntegratedBrowserBarProps) {
  const [value, setValue] = React.useState(initialUrl)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (initialUrl) setValue(initialUrl)
  }, [initialUrl])

  const go = async (event?: React.FormEvent) => {
    event?.preventDefault()
    const parsed = sanitizeNavigateUrl(value)
    if (!parsed.ok) {
      toast.error(parsed.error)
      return
    }
    setBusy(true)
    try {
      const res = await authenticatedFetch(
        `${getSameOriginApiBaseUrl().replace(/\/+$/, "")}/agent-computer/navigate`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: parsed.url,
            ...(conversationId ? { conversationId } : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        },
      )
      const body = await res.json().catch(() => ({})) as { message?: string; error?: string }
      if (!res.ok) throw new Error(body.message || body.error || "No se pudo abrir la página")
      setValue(parsed.url)
      onNavigated?.(parsed.url)
    } catch (error: any) {
      toast.error(error?.message || "No se pudo abrir la página")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(event) => void go(event)}
      data-testid="integrated-browser-bar"
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-black/10 bg-white/80 shadow-inner dark:border-white/10 dark:bg-white/[0.06]",
        compact ? "h-8 px-2" : "h-7 px-2.5",
      )}
    >
      <Globe className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden="true" />
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Buscar o pegar una URL…"
        aria-label="Dirección del navegador"
        data-testid="integrated-browser-url"
        disabled={busy}
        className={cn(
          "min-w-0 flex-1 bg-transparent font-mono text-zinc-700 outline-none placeholder:font-sans placeholder:text-zinc-400 dark:text-zinc-200",
          compact ? "text-[12px]" : "text-[11px]",
        )}
      />
      <button
        type="submit"
        disabled={busy || !value.trim()}
        aria-label="Ir"
        data-testid="integrated-browser-go"
        className="inline-grid h-6 w-6 shrink-0 place-items-center rounded-full text-zinc-500 hover:bg-black/5 hover:text-zinc-800 disabled:opacity-40 dark:hover:bg-white/10 dark:hover:text-zinc-100"
      >
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </form>
  )
}
