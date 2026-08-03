"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import {
  Activity,
  ArrowUpRight,
  BadgeCheck,
  Building2,
  CircleAlert,
  CircleDollarSign,
  CloudSun,
  Clock3,
  FileWarning,
  Layers3,
  Loader2,
  Moon,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  Sun,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import type { AgentOfficeDepartment, AgentOfficeModel, AgentOfficeWorker } from "@/lib/agent-office-model"
import {
  nextOfficeTimeMode,
  officeTimePhaseModeLabel,
  resolveOfficeTimeOfDay,
  resolveOfficeTimePhase,
  type OfficeTimeMode,
} from "@/lib/agent-office-environment"
import { cn } from "@/lib/utils"

import { AgentOfficeScene } from "./agent-office-scene"
import { useOfficeSoundscape } from "./use-office-soundscape"

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

const COMMAND_STATUS_LABELS: Record<AgentOfficeDepartment["commandStatus"], string> = {
  planned: "Planificado",
  active: "Activo",
  queued: "En cola",
  waiting_approval: "Esperando aprobación",
  paused: "En pausa",
  cancelling: "Cancelando",
  blocked: "Bloqueado",
  failed: "Fallido",
  completed: "Completado",
  cancelled: "Cancelado",
  idle: "Sin ejecución",
}

function relativeTime(timestamp: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "Sin actividad registrada"
  const diff = Math.max(0, Date.now() - timestamp)
  if (diff < 60_000) return "Ahora"
  if (diff < 3_600_000) return `Hace ${Math.max(1, Math.floor(diff / 60_000))} min`
  if (diff < 86_400_000) return `Hace ${Math.max(1, Math.floor(diff / 3_600_000))} h`
  return `Hace ${Math.max(1, Math.floor(diff / 86_400_000))} d`
}

function statusDot(worker: AgentOfficeWorker) {
  if (worker.blocker) return "bg-amber-400"
  if (worker.statusTone === "active") return "bg-sky-400"
  if (worker.statusTone === "ready") return "bg-emerald-400"
  if (worker.statusTone === "attention") return "bg-amber-400"
  return "bg-zinc-400"
}

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return `$${value.toFixed(value >= 10 ? 2 : 3)}`
}

function evidenceLabel(status: AgentOfficeWorker["evidenceReview"]): string {
  switch (status) {
    case "pending":
      return "Pendiente de CEO"
    case "approved":
      return "Aprobada"
    case "changes_requested":
      return "Cambios pedidos"
    case "rejected":
      return "Rechazada"
    case "blocked":
      return "Bloqueada"
    default:
      return "Sin evidencia"
  }
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
  const [timeMode, setTimeMode] = React.useState<OfficeTimeMode>("auto")
  const [localClock, setLocalClock] = React.useState(() => new Date())
  const timeOfDay = resolveOfficeTimeOfDay(timeMode, localClock)
  // The clock below re-reads the real local time every minute, so on "auto" the
  // office moves through dawn → day → dusk → night on its own.
  const timePhase = resolveOfficeTimePhase(timeMode, localClock)
  const timeLabel = officeTimePhaseModeLabel(timeMode, timePhase)

  React.useEffect(() => setMounted(true), [])

  React.useEffect(() => {
    if (!open) return
    setLocalClock(new Date())
    const interval = window.setInterval(() => setLocalClock(new Date()), 60_000)
    return () => window.clearInterval(interval)
  }, [open])

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
      // Keep company-wide operational truth even when the roster is filtered.
      truth: model.truth,
    }
  }, [activeOnly, departmentId, model])
  const sound = useOfficeSoundscape({
    active: open,
    timeOfDay,
    paused,
    activeCount: visibleModel.activeCount,
  })

  React.useEffect(() => {
    if (!open) {
      setSelectedWorkerId(null)
      setRosterOpen(false)
    }
  }, [open])

  const selectedWorker =
    model.workers.find((worker) => worker.id === selectedWorkerId) || null
  const truth = model.truth
  const focusedDepartment =
    departmentId === "all"
      ? null
      : model.departments.find((department) => department.id === departmentId) || null

  if (!mounted || !open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[140] isolate overflow-hidden bg-[#dce5e9] text-zinc-950"
      role="dialog"
      aria-modal="true"
      aria-label={`Oficina de agentes de ${companyName}`}
      data-testid="agent-office-overlay"
      data-office-time={timeOfDay}
      data-office-phase={timePhase}
      data-office-sound={sound.state}
    >
      <AgentOfficeScene
        model={visibleModel}
        paused={paused}
        timeOfDay={timeOfDay}
        timePhase={timePhase}
        selectedWorkerId={selectedWorkerId}
        resetCameraKey={resetCameraKey}
        className={cn(rosterOpen && "sm:w-[calc(100%_-_360px)]")}
        onSelectWorker={(workerId) => {
          setSelectedWorkerId(workerId)
          setRosterOpen(true)
          window.setTimeout(() => setResetCameraKey((current) => current + 1), 50)
        }}
        onSelectDepartment={(nextDepartmentId) => {
          setDepartmentId(nextDepartmentId)
          setSelectedWorkerId(null)
        }}
      />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex min-h-[68px] items-center gap-3 border-b border-white/65 bg-white/[0.9] px-3 py-2 shadow-[0_14px_38px_-26px_rgba(15,23,42,0.68)] backdrop-blur-xl sm:px-5">
        <div className="pointer-events-auto flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-zinc-950 text-white shadow-sm">
            <Building2 className="h-5 w-5" />
          </span>
          <span className="min-w-0 max-w-[92px] sm:max-w-[280px]">
            <span className="block truncate text-sm font-semibold sm:text-base">{companyName}</span>
            <span className="hidden truncate text-[11px] text-zinc-500 sm:block">
              Oficina operativa · pools reales · {timeLabel}
            </span>
          </span>
        </div>

        <div className="pointer-events-auto ml-auto hidden items-center gap-1.5 lg:flex" data-testid="agent-office-truth-chips">
          <span className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-200/80 bg-white/75 px-2.5 text-xs font-medium">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                model.activeCount > 0 ? "animate-pulse bg-sky-500" : "bg-zinc-300",
              )}
            />
            {truth.occupiedDesks}/{truth.physicalAgents || model.totalCount} puestos
          </span>
          <span className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-200/80 bg-white/75 px-2.5 text-xs font-medium">
            <CircleDollarSign className="h-3.5 w-3.5 text-zinc-500" />
            {money(truth.costTodayUsd)}
            {truth.dailyBudgetUsd != null ? ` / ${money(truth.dailyBudgetUsd)}` : ""}
          </span>
          <span className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-200/80 bg-white/75 px-2.5 text-xs font-medium">
            <BadgeCheck className="h-3.5 w-3.5 text-zinc-500" />
            {truth.pendingApprovals} aprob.
          </span>
          <span className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-200/80 bg-white/75 px-2.5 text-xs font-medium">
            <ShieldAlert className="h-3.5 w-3.5 text-zinc-500" />
            {truth.latestBlockers.length} bloqueos
          </span>
          <span className="inline-flex h-8 items-center gap-2 rounded-md border border-zinc-200/80 bg-white/75 px-2.5 text-xs font-medium">
            <Layers3 className="h-3.5 w-3.5 text-zinc-500" />
            {model.departments.length} depts
          </span>
        </div>

        <div className="pointer-events-auto flex items-center gap-0.5 rounded-md border border-zinc-200/80 bg-white/70 p-1 shadow-sm">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="hidden h-10 w-10 rounded-md bg-transparent sm:inline-flex"
            onClick={() => setTimeMode((current) => nextOfficeTimeMode(current))}
            aria-label={`Ambiente ${timeLabel}. Cambiar ciclo de luz`}
            title={`Ambiente ${timeLabel}`}
            data-testid="agent-office-time-toggle"
          >
            {timeMode === "auto" ? (
              <Clock3 className="h-4 w-4" />
            ) : timeMode === "dusk" || timeMode === "dawn" ? (
              <CloudSun className="h-4 w-4" />
            ) : timeOfDay === "day" ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-10 w-10 rounded-md bg-transparent",
              sound.enabled &&
                sound.state !== "unavailable" &&
                "bg-zinc-950 text-white hover:bg-zinc-800 hover:text-white",
            )}
            onClick={sound.toggle}
            aria-label={
              sound.state === "unavailable"
                ? "Reintentar sonido de la oficina"
                : sound.enabled
                  ? "Desactivar sonido de la oficina"
                  : "Activar sonido de la oficina"
            }
            title={
              sound.state === "loading"
                ? "Preparando audio"
                : sound.state === "elevenlabs"
                  ? "Audio ElevenLabs activo"
                  : sound.state === "blocked"
                    ? "Toca para activar el audio"
                    : sound.state === "unavailable"
                      ? "Reintentar audio"
                      : sound.enabled
                        ? "Audio activo"
                        : "Activar audio"
            }
            data-testid="agent-office-sound-toggle"
          >
            {sound.state === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : sound.enabled && sound.state !== "unavailable" ? (
              <Volume2 className="h-4 w-4" />
            ) : (
              <VolumeX className="h-4 w-4" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-md bg-transparent"
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
            className="hidden h-10 w-10 rounded-md bg-transparent sm:inline-flex"
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
            className={cn("h-10 w-10 rounded-md bg-transparent", rosterOpen && "bg-zinc-950 text-white hover:bg-zinc-800 hover:text-white")}
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
            className="h-10 w-10 rounded-md bg-transparent"
            onClick={onClose}
            aria-label="Cerrar oficina"
            title="Cerrar oficina"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </header>

      <div className="pointer-events-none absolute left-3 right-3 top-[78px] z-20 flex items-center gap-2 sm:left-5 sm:right-auto sm:max-w-[720px]">
        <div className="pointer-events-auto flex h-10 shrink-0 items-center rounded-md border border-white/75 bg-white/90 p-1 shadow-sm backdrop-blur-xl">
          <button
            type="button"
            className={cn(
              "h-8 rounded px-3 text-xs font-medium transition-colors",
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
              "h-8 rounded px-3 text-xs font-medium transition-colors",
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
          className="pointer-events-auto h-10 min-w-0 flex-1 rounded-md border border-white/75 bg-white/90 px-3 text-xs font-medium shadow-sm outline-none backdrop-blur-xl focus:ring-2 focus:ring-zinc-950 sm:w-[270px] sm:flex-none"
          aria-label="Filtrar por departamento"
        >
          <option value="all">Todos los departamentos</option>
          {model.departments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name} · {department.workers.length}
            </option>
          ))}
        </select>

        <div className="pointer-events-auto hidden h-10 w-32 items-center gap-2 rounded-md border border-white/75 bg-white/90 px-2.5 shadow-sm backdrop-blur-xl md:flex">
          {sound.enabled ? (
            <Volume2 className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
          ) : (
            <VolumeX className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          )}
          <Slider
            value={[Math.round(sound.volume * 100)]}
            max={100}
            step={1}
            disabled={!sound.enabled}
            onValueChange={([value]) => sound.setVolume((value || 0) / 100)}
            className="min-w-0"
            aria-label="Volumen de la oficina"
          />
        </div>
      </div>

      <div
        className="pointer-events-none absolute left-3 right-3 top-[126px] z-20 sm:left-5 sm:right-auto sm:max-w-[720px]"
        data-testid="agent-office-truth-strip"
      >
        <div className="pointer-events-auto grid grid-cols-2 gap-2 rounded-md border border-white/75 bg-white/90 p-2 shadow-sm backdrop-blur-xl sm:grid-cols-4">
          <div className="rounded bg-zinc-50 px-2.5 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Pool</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums">
              {focusedDepartment
                ? `${focusedDepartment.pool.occupied}/${focusedDepartment.pool.size}`
                : `${truth.occupiedDesks}/${truth.physicalAgents || "—"}`}
            </p>
            <p className="text-[11px] text-zinc-500">
              {focusedDepartment
                ? focusedDepartment.pool.enabled
                  ? `${focusedDepartment.pool.free} libres`
                  : "Pool pausado"
                : `${truth.freeDesks} libres · x${truth.writerConcurrency} writers`}
            </p>
          </div>
          <div className="rounded bg-zinc-50 px-2.5 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Coste hoy</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums">
              {money(focusedDepartment ? focusedDepartment.costTodayUsd : truth.costTodayUsd)}
            </p>
            <p className="text-[11px] text-zinc-500">
              {focusedDepartment?.pool.dailyBudgetUsd != null || truth.dailyBudgetUsd != null
                ? `tope ${money(focusedDepartment?.pool.dailyBudgetUsd ?? truth.dailyBudgetUsd)}`
                : "sin tope diario"}
            </p>
          </div>
          <div className="rounded bg-zinc-50 px-2.5 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Evidencia</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums">
              {focusedDepartment
                ? focusedDepartment.evidencePending
                : truth.pendingEvidenceReview}{" "}
              rev.
            </p>
            <p className="text-[11px] text-zinc-500">
              {focusedDepartment
                ? `${focusedDepartment.evidenceBlocked} bloqueadas`
                : `${truth.blockedMissions} misiones bloqueadas`}
            </p>
          </div>
          <div className="rounded bg-zinc-50 px-2.5 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Estado</p>
            <p className="mt-0.5 text-sm font-semibold">
              {focusedDepartment
                ? COMMAND_STATUS_LABELS[focusedDepartment.commandStatus]
                : truth.readinessStatus === "unknown"
                  ? "sin readiness"
                  : truth.readinessStatus}
            </p>
            <p className="text-[11px] text-zinc-500">
              {focusedDepartment?.currentWork
                || (truth.atRiskObjectives > 0
                  ? `${truth.atRiskObjectives} OKR en riesgo`
                  : `${truth.activeObjectives} OKR activos`)}
            </p>
          </div>
        </div>
        {truth.latestBlockers.length > 0 && departmentId === "all" ? (
          <div className="pointer-events-auto mt-2 flex items-start gap-2 rounded-md border border-amber-200/80 bg-amber-50/95 px-3 py-2 text-[11px] text-amber-950 shadow-sm backdrop-blur-xl">
            <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">
              <span className="font-semibold">Bloqueo reciente: </span>
              <span className="line-clamp-2">{truth.latestBlockers[0]?.label}</span>
            </span>
          </div>
        ) : focusedDepartment && focusedDepartment.blockers[0] ? (
          <div className="pointer-events-auto mt-2 flex items-start gap-2 rounded-md border border-amber-200/80 bg-amber-50/95 px-3 py-2 text-[11px] text-amber-950 shadow-sm backdrop-blur-xl">
            <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">
              <span className="font-semibold">Bloqueo del depto: </span>
              <span className="line-clamp-2">{focusedDepartment.blockers[0].label}</span>
            </span>
          </div>
        ) : null}
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 z-20 hidden items-center gap-3 rounded-md border border-white/70 bg-white/80 px-3 py-2 text-[11px] font-medium text-zinc-600 shadow-sm backdrop-blur-xl sm:flex">
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
        {sound.enabled || sound.state === "unavailable" ? (
          <span className="inline-flex items-center gap-1.5 border-l border-zinc-200 pl-3">
            {sound.state === "unavailable" ? (
              <VolumeX className="h-3.5 w-3.5" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" />
            )}
            {sound.state === "elevenlabs"
              ? "Ambiente ElevenLabs"
              : sound.state === "blocked"
                ? "Toca para activar audio"
                : sound.state === "unavailable"
                  ? "Audio no disponible"
                  : "Preparando ambiente"}
          </span>
        ) : null}
      </div>

      {rosterOpen ? (
        <aside
          className="absolute bottom-0 right-0 top-16 z-30 flex w-full flex-col border-l border-white/70 bg-white/90 shadow-[-18px_0_42px_-32px_rgba(15,23,42,0.6)] backdrop-blur-2xl sm:w-[360px]"
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
                <div className="grid grid-cols-2 gap-4 py-3">
                  <div>
                    <dt className="text-[10px] font-semibold uppercase text-zinc-500">Coste</dt>
                    <dd className="mt-1 text-sm font-medium tabular-nums">{money(selectedWorker.costUsd)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] font-semibold uppercase text-zinc-500">Evidencia</dt>
                    <dd className="mt-1 text-sm font-medium">{evidenceLabel(selectedWorker.evidenceReview)}</dd>
                  </div>
                </div>
                {selectedWorker.blocker ? (
                  <div className="py-3">
                    <dt className="text-[10px] font-semibold uppercase text-amber-700">Bloqueo</dt>
                    <dd className="mt-1.5 text-sm leading-5 text-amber-950">{selectedWorker.blocker}</dd>
                  </div>
                ) : null}
                {selectedWorker.evidenceSummary ? (
                  <div className="py-3">
                    <dt className="text-[10px] font-semibold uppercase text-zinc-500">Resumen de evidencia</dt>
                    <dd className="mt-1.5 text-sm leading-5 text-zinc-900">{selectedWorker.evidenceSummary}</dd>
                  </div>
                ) : null}
                <div className="py-3">
                  <dt className="text-[10px] font-semibold uppercase text-zinc-500">Última actividad</dt>
                  <dd className="mt-1 text-sm font-medium">{relativeTime(selectedWorker.updatedAt)}</dd>
                </div>
                {selectedWorker.runId ? (
                  <div className="py-3">
                    <dt className="text-[10px] font-semibold uppercase text-zinc-500">Run</dt>
                    <dd className="mt-1 font-mono text-xs text-zinc-700">{selectedWorker.runId}</dd>
                  </div>
                ) : null}
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

      <div className="pointer-events-none absolute bottom-3 right-3 z-20 flex items-center gap-2 rounded-md border border-white/75 bg-white/90 px-3 py-2 text-[11px] font-medium shadow-sm backdrop-blur-xl sm:hidden">
        <span className="h-2 w-2 rounded-full bg-sky-400" />
        {model.activeCount} {model.activeCount === 1 ? "activo" : "activos"} · {model.totalCount}{" "}
        {model.totalCount === 1 ? "agente" : "agentes"}
      </div>
    </div>,
    document.body,
  )
}
