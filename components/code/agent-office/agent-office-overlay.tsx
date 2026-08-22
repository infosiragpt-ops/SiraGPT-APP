"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import {
  Activity,
  ArrowUpRight,
  BadgeCheck,
  Building2,
  Camera,
  CircleDollarSign,
  CloudSun,
  FileWarning,
  Home,
  Layers3,
  Loader2,
  Moon,
  Pause,
  PersonStanding,
  Plane,
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
import type {
  AgentOfficeDepartment,
  AgentOfficeModel,
  AgentOfficeWorker,
} from "@/lib/agent-office-model"
import {
  nextOfficeTimeMode,
  officeTimePhaseModeLabel,
  resolveOfficeTimeOfDay,
  resolveOfficeTimePhase,
  type OfficeTimeMode,
} from "@/lib/agent-office-environment"
import { cn } from "@/lib/utils"

import { AgentOfficeScene } from "./agent-office-scene"
import { OFFICE_PRO_MARKER, type AgentOfficeNavMode } from "./agent-office-navigation"
import { useOfficeSoundscape } from "./use-office-soundscape"

type AgentOfficeOverlayProps = {
  open: boolean
  companyName: string
  model: AgentOfficeModel
  onClose: () => void
  onOpenWorker: (worker: AgentOfficeWorker) => void
  onOpenDepartment: (departmentId: string) => void
  onOpenDashboard: () => void
  onOpenControl: () => void
  onOpenFiles: () => void
  onOpenResources: () => void
}

type OfficeDestination = {
  id: "office" | "dashboard" | "control" | "files" | "resources"
  label: string
  icon: React.ComponentType<{ className?: string }>
  action?: () => void
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
  active: "Activo",
  queued: "En cola",
  paused: "Pausado",
  blocked: "Bloqueado",
  completed: "Completado",
  idle: "En espera",
}

const EVIDENCE_LABELS: Record<NonNullable<AgentOfficeWorker["evidenceReview"]>, string> = {
  pending: "Pendiente de CEO",
  approved: "Aprobada",
  changes_requested: "Cambios solicitados",
  rejected: "Rechazada",
  blocked: "Bloqueada",
}

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return `$${value.toFixed(value >= 10 ? 2 : 3)}`
}

function workerTone(worker: AgentOfficeWorker): string {
  if (worker.blocker || worker.statusTone === "attention") return "bg-amber-400"
  if (worker.statusTone === "active") return "bg-sky-400"
  if (worker.statusTone === "ready") return "bg-emerald-400"
  return "bg-slate-500"
}

function departmentTone(department: AgentOfficeDepartment): string {
  if (department.blockers.length > 0 || department.commandStatus === "blocked") return "bg-rose-400"
  if (department.activeCount > 0 || department.commandStatus === "active") return "bg-sky-400"
  if (department.commandStatus === "queued") return "bg-amber-400"
  return "bg-slate-500"
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute("hidden") && element.offsetParent !== null)
}

export function AgentOfficeOverlay({
  open,
  companyName,
  model,
  onClose,
  onOpenWorker,
  onOpenDepartment,
  onOpenDashboard,
  onOpenControl,
  onOpenFiles,
  onOpenResources,
}: AgentOfficeOverlayProps) {
  const [mounted, setMounted] = React.useState(false)
  const [paused, setPaused] = React.useState(false)
  const [activeOnly, setActiveOnly] = React.useState(false)
  const [departmentFilter, setDepartmentFilter] = React.useState("all")
  const [selectedDepartmentId, setSelectedDepartmentId] = React.useState<string | null>(null)
  const [selectedWorkerId, setSelectedWorkerId] = React.useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [cameraCommand, setCameraCommand] = React.useState<{
    type: "reset" | "zoom-in" | "zoom-out" | "fly" | "walk" | "orbit"
    nonce: number
  }>({ type: "reset", nonce: 0 })
  const [navMode, setNavMode] = React.useState<AgentOfficeNavMode>("orbit")
  const [timeMode, setTimeMode] = React.useState<OfficeTimeMode>("auto")
  const [localClock, setLocalClock] = React.useState(() => new Date())
  const dialogRef = React.useRef<HTMLDivElement>(null)
  const closeButtonRef = React.useRef<HTMLButtonElement>(null)
  const previousFocusRef = React.useRef<HTMLElement | null>(null)
  const restoreFocusRef = React.useRef(true)
  const onCloseRef = React.useRef(onClose)

  const timeOfDay = resolveOfficeTimeOfDay(timeMode, localClock)
  const timePhase = resolveOfficeTimePhase(timeMode, localClock)
  const timeLabel = officeTimePhaseModeLabel(timeMode, timePhase)
  const logicalAgentCount = model.departments.reduce(
    (total, department) => total + Math.max(1, department.pool.size),
    0,
  )
  const queuedTasks = model.departments.reduce(
    (total, department) => total + department.tasksQueued,
    0,
  )

  React.useEffect(() => setMounted(true), [])

  React.useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  React.useEffect(() => {
    if (!open) return
    setLocalClock(new Date())
    const interval = window.setInterval(() => setLocalClock(new Date()), 60_000)
    return () => window.clearInterval(interval)
  }, [open])

  React.useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    restoreFocusRef.current = true
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== "Tab" || !dialogRef.current) return
      const items = focusableElements(dialogRef.current)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", onKeyDown)
      if (restoreFocusRef.current) previousFocusRef.current?.focus()
    }
  }, [open])

  React.useEffect(() => {
    if (!open) {
      setSelectedWorkerId(null)
      setSelectedDepartmentId(null)
      setDrawerOpen(false)
    }
  }, [open])

  React.useEffect(() => {
    if (departmentFilter !== "all" && !model.departments.some((row) => row.id === departmentFilter)) {
      setDepartmentFilter("all")
    }
  }, [departmentFilter, model.departments])

  const visibleModel = React.useMemo<AgentOfficeModel>(() => {
    const departments = model.departments
      .filter((department) => departmentFilter === "all" || department.id === departmentFilter)
      .map((department) => {
        const workers = activeOnly ? department.workers.filter((worker) => worker.active) : department.workers
        return { ...department, workers, activeCount: workers.filter((worker) => worker.active).length }
      })
      .filter((department) => !activeOnly || department.workers.length > 0 || departmentFilter === department.id)
    const workers = departments.flatMap((department) => department.workers)
    return {
      departments,
      workers,
      activeCount: workers.filter((worker) => worker.active).length,
      totalCount: workers.length,
      truth: model.truth,
    }
  }, [activeOnly, departmentFilter, model])

  const selectedWorker = model.workers.find((worker) => worker.id === selectedWorkerId) || null
  const selectedDepartment = model.departments.find((row) => row.id === selectedDepartmentId) || null
  const sound = useOfficeSoundscape({
    active: open,
    timeOfDay,
    timePhase,
    paused,
    activeCount: visibleModel.activeCount,
    attentionCount: model.truth.blockedMissions + model.truth.latestBlockers.length,
    approvalCount: model.truth.pendingApprovals,
  })

  const leaveOffice = React.useCallback((action: () => void) => {
    restoreFocusRef.current = false
    onClose()
    action()
  }, [onClose])

  const destinations: OfficeDestination[] = [
    { id: "office", label: "Vista 3D", icon: Building2 },
    { id: "dashboard", label: "Panel", icon: Layers3, action: onOpenDashboard },
    { id: "control", label: "Controlar", icon: Activity, action: onOpenControl },
    { id: "files", label: "Archivos", icon: FileWarning, action: onOpenFiles },
    { id: "resources", label: "Recursos", icon: CircleDollarSign, action: onOpenResources },
  ]

  const sendCameraCommand = React.useCallback((
    type: "reset" | "zoom-in" | "zoom-out" | "fly" | "walk" | "orbit",
  ) => {
    setCameraCommand((current) => ({ type, nonce: current.nonce + 1 }))
  }, [])

  const setOfficeNav = React.useCallback((mode: AgentOfficeNavMode) => {
    setNavMode(mode)
    sendCameraCommand(mode === "orbit" ? "orbit" : mode)
  }, [sendCameraCommand])

  if (!mounted || !open) return null

  const truth = model.truth
  const healthLabel = truth.readinessStatus === "ready"
    ? "Operativo"
    : truth.readinessStatus === "blocked"
      ? "Bloqueado"
      : truth.readinessStatus === "attention" || truth.latestBlockers.length > 0
        ? "Atención"
        : "En observación"
  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[140] isolate overflow-hidden bg-slate-950 text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-office-title"
      data-testid="agent-office-overlay"
      data-office-time={timeOfDay}
      data-office-phase={timePhase}
      data-office-sound={sound.state}
      data-department-count={model.departments.length}
      data-logical-agent-count={logicalAgentCount}
      data-interactive-worker-count={model.workers.length}
      data-office-pro={OFFICE_PRO_MARKER}
      data-office-nav={navMode}
    >
      <AgentOfficeScene
        model={visibleModel}
        paused={paused}
        timeOfDay={timeOfDay}
        timePhase={timePhase}
        selectedWorkerId={selectedWorkerId}
        cameraCommand={cameraCommand}
        navMode={navMode}
        onNavModeChange={setNavMode}
        onSelectWorker={(workerId) => {
          const worker = model.workers.find((row) => row.id === workerId)
          setSelectedWorkerId(workerId)
          setSelectedDepartmentId(worker?.departmentId || null)
          setDrawerOpen(true)
        }}
        onSelectDepartment={(departmentId) => {
          setSelectedWorkerId(null)
          setSelectedDepartmentId(departmentId)
          setDrawerOpen(true)
        }}
      />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-[calc(4rem+env(safe-area-inset-top))] items-center border-b border-white/10 bg-slate-950/95 px-3 pt-[env(safe-area-inset-top)] shadow-2xl backdrop-blur-2xl sm:px-5">
        <div className="pointer-events-auto flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-sky-400/25 bg-gradient-to-br from-slate-800 to-slate-900 text-sky-300 shadow-lg">
            <Building2 className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span id="agent-office-title" className="block truncate text-sm font-semibold sm:text-base">Oficina de agentes</span>
            <span className="block max-w-44 truncate text-[11px] text-slate-400 sm:max-w-[420px]">
              {companyName} · {healthLabel} · {model.departments.length} departamentos · {logicalAgentCount} puestos
            </span>
          </span>
        </div>

        <div className="pointer-events-auto ml-auto flex items-center gap-1 rounded-xl border border-white/10 bg-slate-800/90 p-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="hidden h-10 w-10 rounded-lg text-slate-300 hover:bg-white/10 hover:text-white sm:inline-flex"
            onClick={() => setTimeMode((current) => nextOfficeTimeMode(current))}
            aria-label={`Ambiente ${timeLabel}. Cambiar ciclo de luz`}
            title={`Ambiente ${timeLabel}`}
            data-testid="agent-office-time-toggle"
          >
            {timeMode === "auto" ? <CloudSun className="h-4 w-4" /> : timeOfDay === "day" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="hidden h-10 w-10 rounded-lg text-slate-300 hover:bg-white/10 hover:text-white sm:inline-flex"
            onClick={sound.toggle}
            aria-label={sound.enabled ? "Desactivar sonido de la oficina" : "Activar sonido de la oficina"}
            data-testid="agent-office-sound-toggle"
          >
            {sound.state === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : sound.enabled && sound.state !== "unavailable" ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="hidden h-10 w-10 rounded-lg text-slate-300 hover:bg-white/10 hover:text-white sm:inline-flex"
            onClick={() => setPaused((current) => !current)}
            aria-label={paused ? "Reanudar oficina" : "Pausar oficina"}
          >
            {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          </Button>
          <Button
            ref={closeButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-lg text-slate-200 hover:bg-white/10 hover:text-white"
            onClick={onClose}
            aria-label="Cerrar oficina"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </header>

      <nav className="pointer-events-auto absolute bottom-20 left-4 top-20 z-20 hidden w-64 flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900/90 shadow-2xl backdrop-blur-2xl lg:flex" aria-label="Navegación de la oficina">
        <div className="border-b border-white/10 p-2">
          {destinations.map((destination) => {
            const Icon = destination.icon
            return (
              <button
                key={destination.id}
                type="button"
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400",
                  destination.id === "office" ? "bg-sky-400/10 text-sky-200" : "text-slate-300 hover:bg-white/[0.06] hover:text-white",
                )}
                aria-current={destination.id === "office" ? "page" : undefined}
                onClick={() => destination.action && leaveOffice(destination.action)}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {destination.label}
                {destination.action ? <ArrowUpRight className="ml-auto h-3.5 w-3.5 text-slate-500" /> : null}
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Departamentos</p>
            <p className="mt-1 text-xs text-slate-400">{model.departments.length} zonas conectadas</p>
          </div>
          <Layers3 className="h-4 w-4 text-slate-500" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" data-testid="agent-office-department-list">
          {model.departments.map((department) => (
            <button
              key={department.id}
              type="button"
              className={cn(
                "group flex min-h-[54px] w-full items-center gap-3 rounded-xl px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400",
                selectedDepartmentId === department.id ? "bg-white/[0.09]" : "hover:bg-white/[0.055]",
              )}
              onClick={() => {
                setSelectedWorkerId(null)
                setSelectedDepartmentId(department.id)
                setDrawerOpen(true)
              }}
              data-department-id={department.id}
            >
              <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", departmentTone(department))} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-slate-200">{department.name}</span>
                <span className="mt-1 block text-[10px] text-slate-500">
                  {department.activeCount} activos · {department.pool.size} puestos
                </span>
              </span>
              <ArrowUpRight className="h-3.5 w-3.5 text-slate-600 group-hover:text-slate-300" />
            </button>
          ))}
        </div>
      </nav>

      <div className="pointer-events-none absolute left-3 right-3 top-20 z-20 flex items-center gap-2 lg:left-72 lg:right-auto">
        <div className="pointer-events-auto flex h-11 shrink-0 items-center rounded-xl border border-white/10 bg-slate-900/90 p-1 shadow-lg backdrop-blur-xl">
          <button
            type="button"
            className={cn("h-9 rounded-lg px-3 text-xs font-semibold transition-colors", !activeOnly ? "bg-sky-500 text-white" : "text-slate-400 hover:bg-white/[0.06]")}
            onClick={() => setActiveOnly(false)}
            aria-pressed={!activeOnly}
          >Todos</button>
          <button
            type="button"
            className={cn("h-9 rounded-lg px-3 text-xs font-semibold transition-colors", activeOnly ? "bg-sky-500 text-white" : "text-slate-400 hover:bg-white/[0.06]")}
            onClick={() => setActiveOnly(true)}
            aria-pressed={activeOnly}
          >Activos</button>
        </div>
        <label className="pointer-events-auto relative min-w-0 flex-1 sm:w-[270px] sm:flex-none">
          <select
            value={departmentFilter}
            onChange={(event) => {
              setDepartmentFilter(event.target.value)
              setSelectedWorkerId(null)
              setSelectedDepartmentId(event.target.value === "all" ? null : event.target.value)
            }}
            className="h-11 w-full appearance-none rounded-xl border border-white/10 bg-slate-900/90 px-3 pr-7 text-xs font-semibold text-slate-200 shadow-lg outline-none backdrop-blur-xl focus:ring-2 focus:ring-sky-400"
            aria-label="Filtrar por departamento"
          >
            <option value="all">Todos los departamentos</option>
            {model.departments.map((department) => <option key={department.id} value={department.id}>{department.name} · {department.pool.size}</option>)}
          </select>
        </label>
      </div>

      {navMode !== "orbit" ? (
        <div
          className="pointer-events-none absolute bottom-[calc(9.5rem+env(safe-area-inset-bottom))] left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/15 bg-slate-950/80 px-3 py-1.5 text-[11px] font-medium tracking-wide text-slate-100 shadow-2xl backdrop-blur-xl lg:bottom-24"
          data-office-fly-hint={navMode}
          role="status"
        >
          {navMode === "fly"
            ? "Modo vuelo · WASD mover · Q/E altura · F salir"
            : "Modo caminar · WASD en la terraza · clic para mirar · F salir"}
        </div>
      ) : null}

      <div className="pointer-events-auto absolute bottom-[calc(5.5rem+env(safe-area-inset-bottom))] right-3 z-20 flex flex-col items-end gap-2 lg:bottom-20 sm:right-5" aria-label="Controles de navegación">
        <div className="flex overflow-hidden rounded-2xl border border-white/12 bg-slate-950/88 shadow-2xl backdrop-blur-xl" data-office-nav-toolbar="matrix">
          {([
            { id: "fly" as const, label: "Volar", icon: Plane },
            { id: "walk" as const, label: "Caminar", icon: PersonStanding },
            { id: "orbit" as const, label: "Órbita", icon: Home },
            { id: "camera" as const, label: "Cámara", icon: Camera },
          ]).map((tool) => {
            const Icon = tool.icon
            const active = tool.id !== "camera" && navMode === tool.id
            return (
              <button
                key={tool.id}
                type="button"
                className={cn(
                  "flex h-12 min-w-[4.4rem] flex-col items-center justify-center gap-0.5 px-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400",
                  active ? "bg-sky-500/20 text-sky-100" : "text-slate-400 hover:bg-white/[0.06] hover:text-white",
                )}
                aria-pressed={active}
                aria-label={tool.label}
                data-office-nav-tool={tool.id}
                onClick={() => {
                  if (tool.id === "camera") {
                    setOfficeNav("orbit")
                    sendCameraCommand("reset")
                    return
                  }
                  setOfficeNav(tool.id)
                }}
              >
                <Icon className="h-4 w-4" />
                {tool.label}
              </button>
            )
          })}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="icon" className="h-10 w-10 rounded-xl border border-white/10 bg-slate-900/90 text-lg font-medium text-slate-200 shadow-lg hover:bg-slate-800 hover:text-white" onClick={() => sendCameraCommand("zoom-in")} aria-label="Acercar cámara"><span aria-hidden>+</span></Button>
          <Button type="button" variant="ghost" size="icon" className="h-10 w-10 rounded-xl border border-white/10 bg-slate-900/90 text-lg font-medium text-slate-200 shadow-lg hover:bg-slate-800 hover:text-white" onClick={() => sendCameraCommand("zoom-out")} aria-label="Alejar cámara"><span aria-hidden>−</span></Button>
          <Button type="button" variant="ghost" size="icon" className="h-10 w-10 rounded-xl border border-white/10 bg-slate-900/90 text-slate-200 shadow-lg hover:bg-slate-800 hover:text-white" onClick={() => { setOfficeNav("orbit"); sendCameraCommand("reset") }} aria-label="Restablecer cámara"><RotateCcw className="h-4 w-4" /></Button>
          <Button type="button" variant="ghost" size="icon" className={cn("h-10 w-10 rounded-xl border border-white/10 bg-slate-900/90 text-slate-200 shadow-lg hover:bg-slate-800 hover:text-white", drawerOpen && !selectedWorker && !selectedDepartment && "border-sky-400/30 bg-sky-400/15 text-sky-200")} onClick={() => { setSelectedWorkerId(null); setSelectedDepartmentId(null); setDrawerOpen(true) }} aria-label="Ver agentes"><Users className="h-4 w-4" /></Button>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 right-16 z-20 hidden grid-cols-5 gap-px overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl md:grid lg:left-72" data-testid="agent-office-truth-strip">
        {[
          { label: "Puestos ocupados", value: `${truth.occupiedDesks}/${logicalAgentCount}`, icon: Users },
          { label: "Agentes activos", value: String(model.activeCount), icon: Activity },
          { label: "Tareas en cola", value: String(queuedTasks), icon: Layers3 },
          { label: "Aprobaciones", value: String(truth.pendingApprovals), icon: BadgeCheck },
          { label: "Salud del sistema", value: healthLabel, icon: ShieldAlert },
        ].map((metric) => {
          const Icon = metric.icon
          return (
            <div key={metric.label} className="min-w-0 bg-slate-900 px-3 py-2.5">
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500"><Icon className="h-3.5 w-3.5" />{metric.label}</div>
              <p className="mt-1 truncate text-sm font-semibold text-slate-100">{metric.value}</p>
            </div>
          )
        })}
      </div>

      {drawerOpen ? (
        <aside className="absolute bottom-0 right-0 z-40 flex max-h-[70vh] w-full flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-slate-900/95 shadow-2xl backdrop-blur-2xl sm:bottom-16 sm:top-16 sm:max-h-none sm:w-96 sm:rounded-none sm:rounded-l-2xl" data-testid="agent-office-roster" aria-label="Detalle operativo de la oficina">
          <div className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{selectedWorker ? "Agente seleccionado" : selectedDepartment ? "Departamento seleccionado" : "Todos los agentes"}</p>
              <p className="mt-1 truncate text-[11px] text-slate-500">{selectedWorker?.departmentName || selectedDepartment?.name || `${model.workers.length} agentes operativos`}</p>
            </div>
            <Button type="button" variant="ghost" size="icon" className="h-10 w-10 rounded-lg text-slate-300 hover:bg-white/10 hover:text-white" onClick={() => setDrawerOpen(false)} aria-label="Cerrar panel"><X className="h-4 w-4" /></Button>
          </div>

          {selectedWorker ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <div className="flex items-start gap-3">
                <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-slate-800 text-sm font-semibold text-white">
                  {selectedWorker.name.slice(0, 2).toUpperCase()}
                  <span className={cn("absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full border-2 border-slate-900", workerTone(selectedWorker))} />
                </span>
                <div className="min-w-0"><p className="truncate text-base font-semibold">{selectedWorker.name}</p><p className="mt-1 text-xs text-slate-400">{selectedWorker.statusLabel}</p></div>
              </div>
              <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.035] p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Trabajo actual</p>
                <p className="mt-2 text-sm leading-6 text-slate-200">{selectedWorker.task}</p>
                <p className="mt-3 text-xs text-slate-500">{ACTIVITY_LABELS[selectedWorker.activity]} · {selectedWorker.source === "run" ? "Ejecución" : "Sesión"} · {money(selectedWorker.costUsd)}</p>
                <p className="mt-2 text-xs text-slate-400">
                  Evidencia: {selectedWorker.evidenceReview ? EVIDENCE_LABELS[selectedWorker.evidenceReview] : "Sin evidencia"}
                  {Number.isFinite(selectedWorker.updatedAt) ? ` · Actualizado ${new Date(selectedWorker.updatedAt).toLocaleString("es-PE")}` : ""}
                </p>
              </div>
              {selectedWorker.blocker ? <p className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">{selectedWorker.blocker}</p> : null}
              <Button type="button" className="mt-5 h-11 w-full rounded-xl bg-sky-500 text-white hover:bg-sky-400" onClick={() => leaveOffice(() => onOpenWorker(selectedWorker))}>{selectedWorker.sessionId ? "Abrir sesión" : "Abrir departamento"}<ArrowUpRight className="ml-2 h-4 w-4" /></Button>
            </div>
          ) : selectedDepartment ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <div className="flex items-center gap-3"><span className={cn("h-3 w-3 rounded-full", departmentTone(selectedDepartment))} /><div><p className="text-base font-semibold">{selectedDepartment.name}</p><p className="mt-1 text-xs text-slate-500">{COMMAND_STATUS_LABELS[selectedDepartment.commandStatus] || selectedDepartment.commandStatus}</p></div></div>
              <p className="mt-5 text-sm leading-6 text-slate-300">{selectedDepartment.description}</p>
              <p className="mt-5 rounded-xl border border-white/10 bg-white/[0.035] p-3 text-xs leading-5 text-slate-300">{selectedDepartment.pool.occupied}/{selectedDepartment.pool.size} puestos · {selectedDepartment.tasksQueued} en cola · {selectedDepartment.progress}% · {money(selectedDepartment.costTodayUsd)} hoy</p>
              {selectedDepartment.currentWork ? <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.035] p-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Trabajo actual</p><p className="mt-2 text-sm leading-5 text-slate-200">{selectedDepartment.currentWork}</p></div> : null}
              {selectedDepartment.blockers[0] ? <div className="mt-3 flex gap-2 rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100"><FileWarning className="mt-0.5 h-4 w-4 shrink-0" />{selectedDepartment.blockers[0].label}</div> : null}
              <Button type="button" className="mt-5 h-11 w-full rounded-xl bg-sky-500 text-white hover:bg-sky-400" onClick={() => leaveOffice(() => onOpenDepartment(selectedDepartment.id))}>Abrir departamento<ArrowUpRight className="ml-2 h-4 w-4" /></Button>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto" data-testid="agent-office-worker-list">
              {model.workers.length > 0 ? model.workers.map((worker) => (
                <button key={worker.id} type="button" className="flex min-h-[68px] w-full items-center gap-3 border-b border-white/10 px-4 py-3 text-left hover:bg-white/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400" onClick={() => { setSelectedWorkerId(worker.id); setSelectedDepartmentId(worker.departmentId) }}>
                  <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-slate-800 text-xs font-semibold text-white">{worker.name.slice(0, 2).toUpperCase()}<span className={cn("absolute -bottom-1 -right-1 h-3 w-3 rounded-full border-2 border-slate-900", workerTone(worker))} /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-200">{worker.name}</span><span className="mt-1 block truncate text-xs text-slate-500">{worker.departmentName} · {worker.task}</span></span>
                  {worker.active ? <Activity className="h-4 w-4 shrink-0 text-sky-400" /> : worker.blocker ? <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" /> : null}
                </button>
              )) : <div className="flex min-h-[220px] flex-col items-center justify-center px-8 text-center"><Users className="h-7 w-7 text-slate-600" /><p className="mt-3 text-sm font-semibold">Sin agentes ejecutándose</p><p className="mt-1 text-xs leading-5 text-slate-500">Los {logicalAgentCount} puestos permanecen disponibles por departamento.</p></div>}
            </div>
          )}
        </aside>
      ) : null}

      <nav className="absolute inset-x-0 bottom-0 z-30 grid h-[calc(4rem+env(safe-area-inset-bottom))] grid-cols-5 border-t border-white/10 bg-slate-950 px-1 pb-[env(safe-area-inset-bottom)] lg:hidden" aria-label="Navegación móvil de la oficina">
        {destinations.map((destination) => {
          const Icon = destination.icon
          return <button key={destination.id} type="button" className={cn("flex min-h-11 flex-col items-center justify-center gap-1 text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400", destination.id === "office" ? "text-sky-300" : "text-slate-500")} aria-current={destination.id === "office" ? "page" : undefined} onClick={() => destination.action && leaveOffice(destination.action)}><Icon className="h-4 w-4" />{destination.label === "Vista 3D" ? "Oficina" : destination.label}</button>
        })}
      </nav>

      <p className="sr-only" role="status" aria-live="polite">
        {selectedWorker ? `${selectedWorker.name}, ${selectedWorker.statusLabel}` : selectedDepartment ? `${selectedDepartment.name}, ${selectedDepartment.activeCount} agentes activos` : `${model.departments.length} departamentos y ${logicalAgentCount} puestos disponibles`}
      </p>

    </div>,
    document.body,
  )
}
