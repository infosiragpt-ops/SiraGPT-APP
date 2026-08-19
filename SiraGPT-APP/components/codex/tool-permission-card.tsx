"use client"

import React from "react"
import { Check, Loader2, ShieldAlert, X } from "lucide-react"

export interface ToolPermissionCardProps {
  toolName: string
  humanDescription: string
  argsPreview?: Record<string, unknown>
  decision?: "allow" | "deny"
  onResolve: (decision: "allow" | "deny") => Promise<void>
}

export function ToolPermissionCard({
  toolName,
  humanDescription,
  argsPreview,
  decision,
  onResolve,
}: ToolPermissionCardProps) {
  const [busy, setBusy] = React.useState<"allow" | "deny" | null>(null)

  const resolve = async (next: "allow" | "deny") => {
    setBusy(next)
    try {
      await onResolve(next)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="my-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] p-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-amber-200">
        <ShieldAlert className="h-4 w-4" />
        Aprobación de herramienta
      </div>
      <p className="mt-1 text-sm text-zinc-200">{humanDescription || `Ejecutar ${toolName}`}</p>
      <code className="mt-2 block truncate rounded bg-black/30 px-2 py-1 text-[11px] text-zinc-300">{toolName}</code>
      {argsPreview && Object.keys(argsPreview).length > 0 ? (
        <pre className="mt-2 max-h-28 overflow-auto rounded bg-black/30 p-2 text-[10px] text-zinc-400">
          {JSON.stringify(argsPreview, null, 2)}
        </pre>
      ) : null}

      {decision ? (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-zinc-300">
          {decision === "allow" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <X className="h-3.5 w-3.5 text-red-400" />}
          {decision === "allow" ? "Aprobada una vez" : "Denegada"}
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void resolve("deny")}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/10 px-3 text-xs text-zinc-200 hover:bg-white/5 disabled:opacity-50"
          >
            {busy === "deny" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
            Denegar
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void resolve("allow")}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-amber-500 px-3 text-xs font-medium text-black hover:bg-amber-400 disabled:opacity-50"
          >
            {busy === "allow" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Permitir una vez
          </button>
        </div>
      )}
    </div>
  )
}
