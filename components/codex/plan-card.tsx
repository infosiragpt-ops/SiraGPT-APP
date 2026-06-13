"use client"

// codex/plan-card — the approvable plan (feature 11). Renders architecture,
// pages, components and tasks from a plan_proposed item. "Aprobar y construir"
// creates the build run; "Ajustar" focuses the composer for feedback. Collapses
// with a check once approved.

import React, { useState } from "react"
import clsx from "clsx"
import { Check, ChevronDown, ChevronRight, Hammer, Pencil, Loader2 } from "lucide-react"

export interface PlanCardProps {
  architecture: string
  pages: any[]
  components: any[]
  tasks: any[]
  approved: boolean
  waiting?: boolean
  onApprove?: () => Promise<void> | void
  onAdjust?: () => void
}

function label(x: any): string {
  if (typeof x === "string") return x
  return x?.title || x?.name || x?.label || JSON.stringify(x)
}

export function PlanCard({ architecture, pages, components, tasks, approved, waiting, onApprove, onAdjust }: PlanCardProps) {
  const [open, setOpen] = useState(!approved)
  const [busy, setBusy] = useState(false)

  async function approve() {
    if (!onApprove) return
    setBusy(true)
    try { await onApprove() } finally { setBusy(false) }
  }

  return (
    <div className={clsx("my-2 rounded-xl border bg-violet-500/[0.04] p-3", approved ? "border-emerald-500/20" : "border-violet-500/25")}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        {approved ? <Check className="h-4 w-4 text-emerald-400" /> : (open ? <ChevronDown className="h-4 w-4 text-violet-300" /> : <ChevronRight className="h-4 w-4 text-violet-300" />)}
        <span className="text-sm font-semibold text-violet-100">Plan propuesto</span>
        {waiting && !approved && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300">esperando aprobación</span>}
        {approved && <span className="ml-1 text-xs text-emerald-400">aprobado</span>}
      </button>

      {open && (
        <div className="mt-2 space-y-2 text-sm text-zinc-200">
          <p className="text-zinc-300">{architecture}</p>
          {pages?.length > 0 && <Section title="Páginas" items={pages.map(label)} />}
          {components?.length > 0 && <Section title="Componentes" items={components.map(label)} />}
          {tasks?.length > 0 && (
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Tareas</div>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-zinc-300">
                {tasks.map((t, i) => <li key={i}>{label(t)}</li>)}
              </ol>
            </div>
          )}

          {!approved && (
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={approve} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hammer className="h-3.5 w-3.5" />} Aprobar y construir
              </button>
              <button type="button" onClick={onAdjust} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5">
                <Pencil className="h-3.5 w-3.5" /> Ajustar
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {items.map((it, i) => <span key={i} className="rounded-md bg-white/5 px-1.5 py-0.5 text-xs text-zinc-300">{it}</span>)}
      </div>
    </div>
  )
}
