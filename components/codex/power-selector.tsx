"use client"

// codex/power-selector — the "Power" mode dropdown (feature 12). Maps to the
// Eco/Estándar/Power tiers; shows the relative cost; the chosen tier travels in
// the run creation. Eco is marked free.

import React, { useState } from "react"
import clsx from "clsx"
import { Zap, ChevronDown } from "lucide-react"
import { TIERS, TIER_ORDER, type CodexTier } from "@/lib/codex/model-tiers"

export function PowerSelector({ value, onChange }: { value: CodexTier; onChange: (t: CodexTier) => void }) {
  const [open, setOpen] = useState(false)
  const current = TIERS[value]

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[44px] items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-xs text-zinc-300 hover:bg-white/5 sm:min-h-0"
      >
        <Zap className="h-3.5 w-3.5 text-violet-400" />
        <span>{current.label}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-1 w-56 rounded-lg border border-white/10 bg-zinc-900 p-1 shadow-xl">
            {TIER_ORDER.map((id) => {
              const t = TIERS[id]
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => { onChange(id); setOpen(false) }}
                  className={clsx("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-white/5", value === id && "bg-white/5")}
                >
                  <Zap className={clsx("mt-0.5 h-3.5 w-3.5", id === "eco" ? "text-emerald-400" : id === "power" ? "text-violet-400" : "text-amber-400")} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs text-zinc-100">
                      {t.label}
                      <span className={clsx("rounded px-1 py-0.5 text-[9px]", t.free ? "bg-emerald-500/15 text-emerald-300" : "bg-white/10 text-zinc-400")}>{t.free ? "gratis" : t.cost}</span>
                    </div>
                    <div className="text-[10px] text-zinc-500">{t.description}</div>
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
