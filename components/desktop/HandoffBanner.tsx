"use client"

/**
 * F7.4 — takeover chrome on SiraComputer.
 * Spanish copy only. Never prints a model id. The member types on the
 * live desktop; this banner does not capture keystrokes or passwords.
 */

import * as React from "react"
import { cn } from "@/lib/utils"

export type HandoffState =
  | "AGENT_CONTROL"
  | "HANDOFF_REQUESTED"
  | "HUMAN_CONTROL"
  | "RESUMING"
  | string

export type HandoffBannerProps = {
  state?: HandoffState | null
  onGrant?: () => void
  onReturn?: () => void
  className?: string
}

const COPY = {
  agent: "El agente controla",
  human: "Tú controlas",
  overlay: "El agente no verá lo que escribas",
  request: "El agente espera a que tomes el control. Inicia sesión aquí.",
  humanHint: "Escribe en el escritorio. El agente no verá lo que escribas.",
  take: "Tomar control",
  give: "Devolver control",
} as const

export function isHumanHandoff(state?: HandoffState | null) {
  return state === "HUMAN_CONTROL" || state === "HANDOFF_REQUESTED"
}

export function HandoffBanner({
  state,
  onGrant,
  onReturn,
  className,
}: HandoffBannerProps) {
  const human = isHumanHandoff(state)
  const requested = state === "HANDOFF_REQUESTED"
  const controlling = state === "HUMAN_CONTROL"

  return (
    <div
      className={cn(
        "z-20 flex w-full shrink-0 items-center gap-3 border-b border-white/10 bg-[#161618] px-3 py-2 text-zinc-100",
        className,
      )}
      data-testid="desktop-handoff-banner"
      data-handoff-state={state || "AGENT_CONTROL"}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        data-testid="desktop-handoff-toggle"
        aria-pressed={human}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
          human
            ? "bg-amber-400/20 text-amber-100"
            : "bg-white/10 text-zinc-200",
        )}
        onClick={() => {
          if (human) onReturn?.()
          else onGrant?.()
        }}
      >
        <span>{human ? COPY.human : COPY.agent}</span>
        <span aria-hidden className="text-[10px] font-normal text-zinc-400">
          ↔
        </span>
        <span className="font-normal text-zinc-400">{human ? COPY.agent : COPY.human}</span>
      </button>
      <p className="min-w-0 flex-1 truncate text-[11px] text-zinc-300" data-testid="desktop-handoff-copy">
        {requested ? COPY.request : controlling ? COPY.humanHint : COPY.overlay}
      </p>
      {human ? (
        <button
          type="button"
          data-testid="desktop-handoff-return"
          className="h-8 shrink-0 rounded-md bg-white/15 px-3 text-[11px] font-semibold text-white hover:bg-white/25"
          onClick={() => onReturn?.()}
        >
          {COPY.give}
        </button>
      ) : (
        <button
          type="button"
          data-testid="desktop-handoff-grant"
          className="h-8 shrink-0 rounded-md bg-white/15 px-3 text-[11px] font-semibold text-white hover:bg-white/25"
          onClick={() => onGrant?.()}
        >
          {COPY.take}
        </button>
      )}
    </div>
  )
}

export function HandoffOverlay({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <div
      className="pointer-events-none absolute left-3 top-3 z-20 rounded-md bg-black/70 px-2.5 py-1.5 text-[11px] font-medium text-amber-100 shadow"
      data-testid="desktop-handoff-overlay"
      role="status"
    >
      {COPY.overlay}
    </div>
  )
}

export { COPY as HANDOFF_COPY }
