"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import {
  Activity,
  ArrowUpRight,
  Building2,
  CircleAlert,
  Layers3,
  Pause,
  Play,
  RotateCcw,
  Users,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import type { AgentOfficeModel, AgentOfficeWorker } from "@/lib/agent-office-model"
import { cn } from "@/lib/utils"

import { AgentOfficeScene } from "./agent-office-scene"

type AgentOfficeOverlayProps = {
  open: boolean
  companyName: string
  model: AgentOfficeModel
  onClose: () => void
  onOpenWorker: (worker: AgentOfficeWorker) => void
}

const ACTIVITY_LABELS = {
  coordination: "Coordinación",
  software: "Desarrollo",
  publishing: "Contenido",
  research: "Investigación",
  operations: "Operaciones",
  localization: "Localización",
  security: "Seguridad",
} as const

function relativeTime(timestamp: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "Sin actividad registrada"
  const diff = Math.max(0, Date.now() - timestamp)
  if (diff < 60_000) return "Ahora"
  if (diff < 3_600_000) return `Hace ${Math.max(1, Math.floor(diff / 60_000))} min`
  if (diff < 86_400_000) return `Hace ${Math.max(1, Math.floor(diff / 3_600_000))} h`
  return `Hace ${Math.max(1, Math.floor(diff / 86_400_000))} d`
}

function statusDot(worker: AgentOfficeWorker) {
  if (worker.statusTone === "active") return "bg-sky-400"
  if (worker.statusTone === "ready") return "bg-emerald-400"
  if (worker.statusTone === "attention") return "bg-amber-400"
  return "bg-zinc-400"
}

export function AgentOfficeOverlay({
  open,
  companyName,
  model,
  onClose,
  onOpenWorker,
}: AgentOfficeOverlayProps) {
  const [mounted, setMounted] = React.useState(false)
  const [paused, setPaused] = React.useState(false)
  const [activeOnly, setActiveOnly] = React.useState(false)
  const [departmentId, setDepartmentId] = React.useState("all")
  const [selectedWorkerId, setSelectedWorkerId] = React.useState<string | null>(null)
  const [rosterOpen, setRosterOpen] = React.useState(false)
  const [resetCameraKey, setResetCameraKey] = React.useState(0)

  React.useEffect(() => setMounted(true), [])

  React.useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [onClose, open])

  React.useEffect(() => {
    if (!open) {
      setSelectedWorkerId(null)
      setRosterOpen(false)
    }
  }, [open])

  React.useEffect(() => {
    if (departmentId !== "all" && !model.departments.some((department) => department.id === departmentId)) {
      setDepartmentId("all")
      setSelectedWorkerId(null)
    }
  }, [departmentId, model.departments])

  const visibleModel = React.useMemo<AgentOfficeModel>(() => {
    const departments = model.departments
      .filter((department) => departmentId === "all" || department.id === departmentId)
      .map((department) => {
        const workers = activeOnly
          ? department.workers.filter((worker) => worker.active)
          : department.workers
        return {
          ...department,
          workers,
          activeCount: workers.filter((worker) => worker.active).length,
        }
      })
      .filter((department) => !activeOnly || department.workers.length > 0 || departmentId === department.id)
    const workers = departments.flatMap((department) => department.workers)
    return {
      departments,
      workers,
      activeCount: workers.filter((worker) => worker.active).length,
      totalCount: workers.length,
    }
  }, [activeOnly, departmentId, model])

  const selectedWorker =
    model.workers.find((worker) => worker.id === selectedWorkerId) || null

  if (!mounted || !open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[140] isolate overflow-hidden bg-[#e8edf0] text-zinc-950"
      role="dialog"
      aria-modal="true"
      aria-label={`Oficina de agentes de ${companyName}`}
      data-testid="agent-office-overlay"
    >
      <AgentOfficeScene
        model={visibleModel}
        paused={paused}
        selectedWorkerId={selectedWorkerId}
        resetCameraKey={resetCameraKey}
        onSelectWorker={(workerId) => {
          setSelectedWorkerId(workerId)
          setRosterOpen(true)
        }}
        onSelectDepartment={(nextDepartmentId) => {
          setDepartmentId(nextDepartmentId)
          setSelectedWorkerId(null)
        }}
      />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex min-h-16 items-center gap-3 border-b border-white/55 bg-white/82 px-3 py-2 shadow-[0_10px_32px_-24px_rgba(15,23,42,0.7)] backdrop-blur-xl sm:px-5">
        <div className="pointer-events-auto flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-zinc-950 text-white">
            <Building2 className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold sm:text-base">{companyName}</span>
            <span className="block truncate text-[11px] text-zinc-500">Oficina de agentes</span>
          </span>
        </div>

        <div className="pointer-events-auto ml-auto hidden items-center gap-1.5 sm:flex">
          <span className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-200/80 bg-white/75 px-2.5 text-xs font-medium">
            <span className="h-2 w-2 rounded-full bg-sky-400" />
            {model.activeCount} activos
          </span>
          <span className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-200/80 bg-white/75 px-2.5 text-xs font-medium">
            <Users className="h-3.5 w-3.5 text-zinc-500" />
            {model.totalCount} agentes
          </span>
          <span className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-200/80 bg-white/75 px-2.5 text-xs font-medium">
            <Layers3 className="h-3.5 w-3.5 text-zinc-500" />
            {model.departments.length} departamentos
          </span>
        </div>

        <div className="pointer-events-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-md bg-white/70"
            onClick={() => setPaused((current) => !current)}
            aria-label={paused ? "Reanudar oficina" : "Pausar oficina"}
            title={paused ? "Reanudar oficina" : "Pausar oficina"}
          >
            {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="hidden h-9 w-9 rounded-md bg-white/70 sm:inline-flex"
            onClick={() => setResetCameraKey((current) => current + 1)}
            aria-label="Restablecer cámara"
            title="Restablecer cámara"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("h-9 w-9 rounded-md bg-white/70", rosterOpen && "bg-zinc-950 text-white hover:bg-zinc-800 hover:text-white")}
            onClick={() => setRosterOpen((current) => !current)}
            aria-label="Ver agentes"
            title="Ver agentes"
          >
            <Users className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-md bg-white/70"
            onClick={onClose}
            aria-label="Cerrar oficina"
            title="Cerrar oficina"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </header>

      <div className="pointer-events-none absolute left-3 right-3 top-[74px] z-20 flex flex-wrap items-center gap-2 sm:left-5 sm:right-auto">
        <div className="pointer-events-auto flex h-9 shrink-0 items-center rounded-md border border-white/75 bg-white/82 p-1 shadow-sm backdrop-blur-xl">
          <button
            type="button"
            className={cn(
              "h-7 rounded px-3 text-xs font-medium transition-colors",
              !activeOnly ? "bg-zinc-950 text-white" : "text-zinc-600 hover:bg-zinc-100",
            )}
            onClick={() => setActiveOnly(false)}
            aria-pressed={!activeOnly}
          >
            Todos
          </button>
          <button
            type="button"
            className={cn(
              "h-7 rounded px-3 text-xs font-medium transition-colors",
              activeOnly ? "bg-zinc-950 text-white" : "text-zinc-600 hover:bg-zinc-100",
            )}
            onClick={() => setActiveOnly(true)}
            aria-pressed={activeOnly}
          >
            Activos
          </button>
        </div>

        <select
          value={departmentId}
          onChange={(event) => {
            setDepartmentId(event.target.value)
            setSelectedWorkerId(null)
          }}
          className="pointer-events-auto h-9 max-w-[min(68vw,320px)] rounded-md border border-white/75 bg-white/82 px-3 text-xs font-medium shadow-sm outline-none backdrop-blur-xl focus:ring-2 focus:ring-zinc-950"
          aria-label="Filtrar por departamento"
        >
          <option value="all">Todos los departamentos</option>
          {model.departments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name} · {department.workers.length}
            </option>
          ))}
        </select>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 z-20 hidden items-center gap-3 rounded-md border border-white/70 bg-white/78 px-3 py-2 text-[11px] font-medium text-zinc-600 shadow-sm backdrop-blur-xl sm:flex">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-sky-400" />
          Trabajando
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          Listo
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-amber-400" />
          Revisión
        </span>
      </div>

      {rosterOpen ? (
        <aside
          className="absolute bottom-0 right-0 top-16 z-30 flex w-full flex-col border-l border-white/70 bg-white/88 shadow-[-18px_0_42px_-32px_rgba(15,23,42,0.6)] backdrop-blur-2xl sm:w-[360px]"
          data-testid="agent-office-roster"
        >
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200/75 px-4">
            <div>
              <p className="text-sm font-semibold">{selectedWorker ? "Actividad del agente" : "Agentes de la oficina"}</p>
              <p className="text-[11px] text-zinc-500">
                {selectedWorker ? selectedWorker.departmentName : `${visibleModel.totalCount} visibles`}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-md"
              onClick={() => setRosterOpen(false)}
              aria-label="Cerrar panel de agentes"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {selectedWorker ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
              <div className="flex items-start gap-3">
                <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-sm font-semibold text-white">
                  {selectedWorker.name.slice(0, 2).toUpperCase()}
                  <span className={cn("absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white", statusDot(selectedWorker))} />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold">{selectedWorker.name}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">{selectedWorker.statusLabel}</p>
                </div>
              </div>

              <dl className="mt-6 divide-y divide-zinc-200/75 border-y border-zinc-200/75">
                <div className="py-3">
                  <dt className="text-[10px] font-semibold uppercase text-zinc-500">Trabajo actual</dt>
                  <dd className="mt-1.5 text-sm leading-5 text-zinc-900">{selectedWorker.task}</dd>
                </div>
                <div className="grid grid-cols-2 gap-4 py-3">
                  <div>
                    <dt className="text-[10px] font-semibold uppercase text-zinc-500">Especialidad</dt>
                    <dd className="mt-1 text-sm font-medium">{ACTIVITY_LABELS[selectedWorker.activity]}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-semibold uppercase text-zinc-500">Fuente</dt>
                    <dd className="mt-1 text-sm font-medium">{selectedWorker.source === "run" ? "Ejecución" : "Sesión"}</dd>
                  </div>
                </div>
                <div className="py-3">
                  <dt className="text-[10px] font-semibold uppercase text-zinc-500">Última actividad</dt>
                  <dd className="mt-1 text-sm font-medium">{relativeTime(selectedWorker.updatedAt)}</dd>
                </div>
              </dl>

              <Button
                type="button"
                className="mt-5 h-10 w-full rounded-md bg-zinc-950 text-white hover:bg-zinc-800"
                onClick={() => onOpenWorker(selectedWorker)}
              >
                {selectedWorker.sessionId ? "Abrir sesión" : "Abrir departamento"}
                <ArrowUpRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          ) : visibleModel.workers.length > 0 ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {visibleModel.workers.map((worker) => (
                <button
                  key={worker.id}
                  type="button"
                  className="flex min-h-[68px] w-full items-center gap-3 border-b border-zinc-200/70 px-4 py-3 text-left hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-950"
                  onClick={() => setSelectedWorkerId(worker.id)}
                >
                  <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">
                    {worker.name.slice(0, 2).toUpperCase()}
                    <span className={cn("absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white", statusDot(worker))} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{worker.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-zinc-500">{worker.task}</span>
                  </span>
                  {worker.statusTone === "attention" ? (
                    <CircleAlert className="h-4 w-4 shrink-0 text-amber-500" />
                  ) : worker.active ? (
                    <Activity className="h-4 w-4 shrink-0 text-sky-500" />
                  ) : null}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
              <Users className="h-7 w-7 text-zinc-400" />
              <p className="mt-3 text-sm font-semibold">No hay agentes en este filtro</p>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                Los escritorios permanecen disponibles para nuevas sesiones y ejecuciones.
              </p>
            </div>
          )}
        </aside>
      ) : null}

      <div className="pointer-events-none absolute bottom-3 right-3 z-20 flex items-center gap-2 rounded-md border border-white/75 bg-white/82 px-3 py-2 text-[11px] font-medium shadow-sm backdrop-blur-xl sm:hidden">
        <span className="h-2 w-2 rounded-full bg-sky-400" />
        {model.activeCount} activos · {model.totalCount} agentes
      </div>
    </div>,
    document.body,
  )
}
