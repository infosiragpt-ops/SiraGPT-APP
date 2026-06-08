"use client"

/**
 * AgentSwarm — futuristic live visualization of the parallel agent
 * orchestration that runs while the code chat is generating. It does NOT
 * do the work itself: the real result is produced by the chat's AI
 * pipeline (dispatch → generateAIStream). This is the live representation
 * of that parallel effort — search, images, code, refactor, review,
 * deliver — so the user sees the "swarm" working in real time.
 *
 * Render it with `active` while the chat is busy; it self-animates and
 * collapses to nothing when inactive.
 */

import * as React from "react"
import {
  Code2,
  Compass,
  Image as ImageIcon,
  Search,
  ShieldCheck,
  Sparkles,
  Wand2,
} from "lucide-react"

import { cn } from "@/lib/utils"

type Phase = {
  key: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  /** rough share of the run, for the climbing agent counter */
  agents: number
}

const PHASES: Phase[] = [
  { key: "plan", label: "Planificación", icon: Compass, agents: 64 },
  { key: "search", label: "Búsqueda de información", icon: Search, agents: 220 },
  { key: "images", label: "Generación de imágenes", icon: ImageIcon, agents: 180 },
  { key: "code", label: "Generación de código", icon: Code2, agents: 320 },
  { key: "refactor", label: "Refactorización", icon: Wand2, agents: 140 },
  { key: "review", label: "Revisión", icon: ShieldCheck, agents: 96 },
  { key: "deliver", label: "Entrega", icon: Sparkles, agents: 24 },
]

const TOTAL_AGENTS = PHASES.reduce((n, p) => n + p.agents, 0) // 1044

export function AgentSwarm({ active }: { active: boolean }) {
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    if (!active) {
      setTick(0)
      return
    }
    const id = window.setInterval(() => setTick((t) => t + 1), 90)
    return () => window.clearInterval(id)
  }, [active])

  if (!active) return null

  // Phases light up sequentially but overlap (parallel feel). The last
  // phase ("Entrega") stays pending until the real stream finishes.
  const activeIndex = Math.min(PHASES.length - 2, Math.floor(tick / 14))
  const liveAgents = Math.min(
    TOTAL_AGENTS,
    120 + Math.floor((tick * TOTAL_AGENTS) / 120),
  )

  return (
    <div
      className={cn(
        "mb-3 overflow-hidden rounded-2xl border border-white/10 p-3",
        "bg-background/70 backdrop-blur-2xl backdrop-saturate-150 supports-[backdrop-filter]:bg-background/55",
        "shadow-[0_18px_50px_-24px_rgba(124,92,255,0.55)]",
      )}
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="relative flex h-6 w-6 items-center justify-center rounded-lg bg-[hsl(var(--accent-violet)/0.16)] text-[hsl(var(--accent-violet))]">
            <Sparkles className="h-3.5 w-3.5" />
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-ping rounded-full bg-[hsl(var(--accent-violet))]" />
          </span>
          <span className="text-[12.5px] font-semibold tracking-tight text-foreground">
            Enjambre de agentes
          </span>
        </div>
        <span className="font-mono text-[11px] tabular-nums text-[hsl(var(--accent-violet))]">
          {liveAgents.toLocaleString("es")}+ en paralelo
        </span>
      </div>

      <ul className="space-y-1.5">
        {PHASES.map((phase, i) => {
          const Icon = phase.icon
          const state = i < activeIndex ? "done" : i === activeIndex ? "running" : "pending"
          return (
            <li key={phase.key} className="flex items-center gap-2.5">
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border transition-colors",
                  state === "done" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
                  state === "running" &&
                    "border-[hsl(var(--accent-violet)/0.5)] bg-[hsl(var(--accent-violet)/0.14)] text-[hsl(var(--accent-violet))]",
                  state === "pending" && "border-border/50 bg-muted/30 text-muted-foreground/60",
                )}
              >
                <Icon className={cn("h-3 w-3", state === "running" && "animate-pulse")} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "truncate text-[11.5px]",
                      state === "pending" ? "text-muted-foreground/60" : "text-foreground/90",
                    )}
                  >
                    {phase.label}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
                    {state === "done"
                      ? "✓"
                      : state === "running"
                        ? `${phase.agents} ag.`
                        : "·"}
                  </span>
                </div>
                {/* live agent pills for the running phase */}
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted/40">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-300",
                      state === "done" && "w-full bg-emerald-500/60",
                      state === "running" &&
                        "bg-gradient-to-r from-[hsl(var(--accent-violet)/0.4)] via-[hsl(var(--accent-violet))] to-[hsl(var(--accent-violet)/0.4)]",
                      state === "pending" && "w-0",
                    )}
                    style={
                      state === "running"
                        ? { width: `${30 + ((tick * 7) % 65)}%` }
                        : undefined
                    }
                  />
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      <p className="mt-2.5 text-[10.5px] leading-snug text-muted-foreground/70">
        Buscando información, generando imágenes y código, refactorizando y
        revisando en paralelo para entregarte el resultado…
      </p>
    </div>
  )
}
