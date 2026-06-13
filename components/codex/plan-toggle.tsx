"use client"

// codex/plan-toggle — the "Plan" pill (feature 12). When on, every run created
// is mode:'plan' (never build) — planning only. When off, the normal flow:
// first run is plan, subsequent runs build after approval.

import React from "react"
import clsx from "clsx"
import { ClipboardList } from "lucide-react"

export function PlanToggle({ active, onToggle }: { active: boolean; onToggle: (next: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!active)}
      aria-pressed={active}
      title="Plan: restringe la corrida a solo planificación, sin ejecutar nada."
      className={clsx(
        "flex items-center gap-1 rounded-full border px-2 py-1 text-xs transition-colors",
        active ? "border-violet-500/40 bg-violet-500/15 text-violet-200" : "border-white/10 text-zinc-400 hover:bg-white/5",
      )}
    >
      <ClipboardList className="h-3.5 w-3.5" /> Plan
    </button>
  )
}
