"use client"

/**
 * PublishPipeline — animates the 5-step publish flow returned by
 * deploymentsApi.publish(): provision → security_scan → build → bundle → promote.
 *
 * The backend returns the phases already resolved (done/failed); we replay them
 * with a small stagger so the user sees the pipeline "run".
 */

import * as React from "react"
import { AlertTriangle, Check, Clock3, Loader2, MessageSquare, X } from "lucide-react"

import { cn } from "@/lib/utils"
import type { PublishPhase } from "@/lib/deployments/deployments-api"

const STEP_ORDER = ["provision", "security_scan", "build", "bundle", "promote"] as const
type StepName = (typeof STEP_ORDER)[number]

const STEP_LABEL: Record<StepName, string> = {
  provision: "Provision",
  security_scan: "Security Scan",
  build: "Build",
  bundle: "Bundle",
  promote: "Promote",
}

type StepState = "pending" | "running" | "done" | "failed"

export function PublishPipeline({
  phases,
  deployment,
  failureMessage,
  resolved = true,
  onDone,
  onViewLogs,
}: {
  phases: PublishPhase[]
  deployment?: { id: string; name: string; defaultDomain?: string | null }
  failureMessage?: string | null
  resolved?: boolean
  onDone?: () => void
  onViewLogs?: () => void
}) {
  // Resolve each known step against the returned phases (order-independent).
  const phaseByName = React.useMemo(() => {
    const map = new Map<string, PublishPhase>()
    for (const phase of phases) map.set(phase.name, phase)
    return map
  }, [phases])

  const [activeIndex, setActiveIndex] = React.useState(0)
  const onDoneRef = React.useRef(onDone)
  onDoneRef.current = onDone
  const failedPhase = React.useMemo(() => phases.find((phase) => phase.status === "failed") ?? null, [phases])
  const failedStepIndex = failedPhase ? STEP_ORDER.findIndex((step) => step === failedPhase.name) : -1
  const isFailed = failedStepIndex >= 0

  React.useEffect(() => {
    setActiveIndex(0)
    if (!resolved) return
    let cancelled = false
    let index = 0
    let timer = 0

    const tick = () => {
      if (cancelled) return
      const step = STEP_ORDER[index]
      if (phaseByName.get(step)?.status === "failed") return
      if (index >= STEP_ORDER.length - 1) {
        timer = window.setTimeout(() => {
          if (!cancelled) onDoneRef.current?.()
        }, 650)
        return
      }
      index += 1
      setActiveIndex(index)
      timer = window.setTimeout(tick, 520)
    }

    timer = window.setTimeout(tick, 520)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [phaseByName, resolved])

  const stateFor = (index: number): StepState => {
    if (!resolved) return index === 0 ? "running" : "pending"
    const step = STEP_ORDER[index]
    if (index === activeIndex && phaseByName.get(step)?.status === "failed") return "failed"
    if (index < activeIndex) return phaseByName.get(step)?.status === "failed" ? "failed" : "done"
    if (index === activeIndex) return "running"
    return "pending"
  }

  const askAgent = () => {
    if (typeof window === "undefined") return
    const failedLabel = failedPhase && STEP_LABEL[failedPhase.name as StepName] ? STEP_LABEL[failedPhase.name as StepName] : "Publishing"
    const logs = phases
      .flatMap((phase) => phase.logs.map((line) => `${STEP_LABEL[phase.name as StepName] || phase.name}: ${line}`))
      .join("\n")
    const prompt = [
      "Revisa este fallo de Publishing y diagnostica la causa raiz.",
      "",
      `Deployment: ${deployment?.name || "sin nombre"} (${deployment?.id || "sin id"})`,
      deployment?.defaultDomain ? `URL publicada: ${deployment.defaultDomain}` : null,
      `Fase fallida: ${failedLabel}`,
      `Error: ${failureMessage || failedPhase?.logs?.[0] || "sin mensaje"}`,
      "",
      "Tareas para el agente:",
      "1. Revisa los logs de publicacion y runtime del deployment.",
      "2. Revisa si la base de datos tiene errores relacionados con este deployment/version.",
      "3. Explica por que no se pudo publicar y dime el cambio exacto para corregirlo.",
      "",
      "Logs relevantes:",
      logs || "sin logs disponibles",
    ]
      .filter(Boolean)
      .join("\n")
    try {
      window.sessionStorage.setItem("publishing-debug-prefill", prompt)
    } catch {
      /* ignore blocked storage; navigation still works */
    }
    window.location.assign("/chat")
  }

  return (
    <div className="rounded-md border border-[#cfcac0] bg-[#f4f2ed] p-4 text-[13px] text-foreground">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {isFailed ? (
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
          ) : (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#0b84ef]" />
          )}
          <div className="min-w-0">
            <p className="font-semibold">{isFailed ? "Publishing failed" : "Publishing"}</p>
            <p className="truncate text-[12px] text-muted-foreground">
              {isFailed ? failureMessage || failedPhase?.logs?.[0] || "Stopped before promote." : "Started less than a minute ago"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isFailed ? (
            <button
              type="button"
              onClick={askAgent}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#d8b4b4] bg-white px-2.5 text-[12px] font-semibold text-rose-700 shadow-none transition-colors hover:bg-rose-50"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              ASK AGENTE
            </button>
          ) : (
            <button
              type="button"
              onClick={onDone}
              className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2.5 text-[12px] font-medium text-foreground shadow-none transition-colors hover:bg-muted"
            >
              Cancel
            </button>
          )}
          {onViewLogs ? (
            <button
              type="button"
              onClick={onViewLogs}
              className="inline-flex h-7 items-center rounded-md px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              View logs
            </button>
          ) : null}
        </div>
      </div>

      <ol className="grid grid-cols-5 overflow-hidden rounded-full bg-[#ddd9ce]">
        {STEP_ORDER.map((step, index) => {
          const state = stateFor(index)
          return (
            <li
              key={step}
              className={cn(
                "flex h-7 min-w-0 items-center justify-center gap-1 border-r border-background/70 px-2 text-center text-[12px] font-medium last:border-r-0",
                state === "done" && "bg-emerald-600 text-white",
                state === "failed" && "bg-rose-600 text-white",
                state === "running" && "bg-[#0b84ef] text-white",
                state === "pending" && "bg-[#d7d4ca] text-[#817b71]",
              )}
            >
              <span
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                  state === "pending" && "text-[#817b71]",
                )}
              >
                {state === "done" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : state === "failed" ? (
                  <X className="h-3.5 w-3.5" />
                ) : state === "running" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Clock3 className="h-3.5 w-3.5" />
                )}
              </span>
              <span className="min-w-0 truncate">{STEP_LABEL[step]}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
