"use client"

import * as React from "react"
import {
  AlertTriangle,
  Archive,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Download,
  File,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Folder,
  Gauge,
  GitCompareArrows,
  Inbox,
  Loader2,
  Pause,
  Play,
  Plug,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  coworkApi,
  type CoworkApproval,
  type CoworkAuditLog,
  type CoworkConnector,
  type CoworkCostSummary,
  type CoworkFile,
  type CoworkFileContent,
  type CoworkRun,
  type CoworkWorkspace,
  type ScheduledCoworkTask,
} from "@/lib/cowork-api"

type CoworkPanelProps = {
  chatId: string
  onClose: () => void
}

type PanelData = {
  workspace: CoworkWorkspace | null
  files: CoworkFile[]
  runs: CoworkRun[]
  approvals: CoworkApproval[]
  scheduledTasks: ScheduledCoworkTask[]
  connectors: CoworkConnector[]
  audit: CoworkAuditLog[]
  costs: CoworkCostSummary | null
}

const INITIAL_DATA: PanelData = {
  workspace: null,
  files: [],
  runs: [],
  approvals: [],
  scheduledTasks: [],
  connectors: [],
  audit: [],
  costs: null,
}

const ACTIVE_RUNS = new Set(["queued", "running", "paused", "waiting_approval"])

function money(value: number | string | null | undefined): string {
  const number = Number(value || 0)
  return new Intl.NumberFormat("es-PE", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: number < 0.01 ? 4 : 2,
    maximumFractionDigits: 4,
  }).format(Number.isFinite(number) ? number : 0)
}

function formatDate(value?: string | null): string {
  if (!value) return "Sin registro"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Sin registro"
  return new Intl.DateTimeFormat("es-PE", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function statusLabel(status: string): string {
  return ({
    queued: "En cola",
    running: "En ejecución",
    paused: "En pausa",
    waiting_approval: "Esperando aprobación",
    completed: "Completada",
    failed: "Con error",
    cancelled: "Cancelada",
    pending: "Pendiente",
    in_progress: "En curso",
    blocked: "Bloqueada",
  } as Record<string, string>)[status] || status
}

function StatusDot({ status }: { status: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        status === "running" && "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.12)]",
        status === "waiting_approval" && "bg-amber-500",
        status === "paused" && "bg-sky-500",
        status === "completed" && "bg-foreground/40",
        status === "failed" && "bg-red-500",
        status === "cancelled" && "bg-muted-foreground/40",
        !["running", "waiting_approval", "paused", "completed", "failed", "cancelled"].includes(status) && "bg-muted-foreground/50",
      )}
    />
  )
}

function fileIcon(path: string, className = "h-4 w-4") {
  if (/\.(xlsx|xls|csv)$/i.test(path)) return <FileSpreadsheet className={className} />
  if (/\.(js|jsx|ts|tsx|json|css|html|py|sql|md)$/i.test(path)) return <FileCode2 className={className} />
  if (/\.(docx|doc|pdf|txt|rtf)$/i.test(path)) return <FileText className={className} />
  return <File className={className} />
}

function fileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function FileTree({
  files,
  selectedPath,
  onSelect,
}: {
  files: CoworkFile[]
  selectedPath?: string | null
  onSelect: (file: CoworkFile) => void
}) {
  const grouped = React.useMemo(() => {
    const result = new Map<string, CoworkFile[]>()
    for (const file of files) {
      const parts = file.path.split("/")
      const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "Raíz"
      const current = result.get(folder) || []
      current.push(file)
      result.set(folder, current)
    }
    return Array.from(result.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [files])
  const [closedFolders, setClosedFolders] = React.useState<Set<string>>(new Set())

  if (!files.length) {
    return (
      <div className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
        <Folder className="mb-3 h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm font-medium">El workspace está listo</p>
        <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
          Pide al agente crear o editar un documento. Los archivos aparecerán aquí con todas sus versiones.
        </p>
      </div>
    )
  }

  return (
    <div className="py-1">
      {grouped.map(([folder, folderFiles]) => {
        const closed = closedFolders.has(folder)
        return (
          <div key={folder}>
            <button
              type="button"
              className="flex h-8 w-full items-center gap-2 px-3 text-left text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              onClick={() => {
                setClosedFolders((previous) => {
                  const next = new Set(previous)
                  if (next.has(folder)) next.delete(folder)
                  else next.add(folder)
                  return next
                })
              }}
            >
              {closed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              <Folder className="h-3.5 w-3.5" />
              <span className="min-w-0 flex-1 truncate">{folder}</span>
              <span className="tabular-nums text-[10px]">{folderFiles.length}</span>
            </button>
            {!closed && folderFiles
              .sort((a, b) => a.path.localeCompare(b.path))
              .map((file) => (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => onSelect(file)}
                  className={cn(
                    "flex min-h-9 w-full items-center gap-2 border-l-2 px-4 text-left text-xs transition-colors",
                    selectedPath === file.path
                      ? "border-foreground bg-muted/60 text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-muted/30 hover:text-foreground",
                  )}
                >
                  {fileIcon(file.path)}
                  <span className="min-w-0 flex-1 truncate">{file.path.split("/").pop()}</span>
                  <span className="text-[10px] tabular-nums">v{file.currentVersion}</span>
                </button>
              ))}
          </div>
        )
      })}
    </div>
  )
}

function FilesView({
  workspace,
  files,
}: {
  workspace: CoworkWorkspace
  files: CoworkFile[]
}) {
  const [selected, setSelected] = React.useState<CoworkFile | null>(null)
  const [content, setContent] = React.useState<CoworkFileContent | null>(null)
  const [diff, setDiff] = React.useState<string | null>(null)
  const [compareFrom, setCompareFrom] = React.useState<string>("")
  const [busy, setBusy] = React.useState(false)
  const [filter, setFilter] = React.useState("")

  React.useEffect(() => {
    if (selected && !files.some((file) => file.id === selected.id)) {
      setSelected(null)
      setContent(null)
      setDiff(null)
      setCompareFrom("")
    } else if (selected) {
      const current = files.find((file) => file.id === selected.id)
      if (current && current.currentVersion !== selected.currentVersion) {
        setSelected(current)
        setCompareFrom(String(Math.max(1, current.currentVersion - 1)))
      }
    }
  }, [files, selected])

  const visibleFiles = React.useMemo(() => {
    const query = filter.trim().toLowerCase()
    return query ? files.filter((file) => file.path.toLowerCase().includes(query)) : files
  }, [files, filter])

  const openFile = async (file: CoworkFile) => {
    setSelected(file)
    setDiff(null)
    setCompareFrom(file.currentVersion > 1 ? String(file.currentVersion - 1) : "")
    setBusy(true)
    try {
      const result = await coworkApi.readFile(workspace.id, file.path)
      setContent(result.file)
    } catch (error: any) {
      toast.error(error?.message || "No se pudo abrir el archivo")
      setContent(null)
    } finally {
      setBusy(false)
    }
  }

  const compare = async () => {
    if (!selected || selected.currentVersion < 2 || !compareFrom) return
    setBusy(true)
    try {
      const result = await coworkApi.diffFile(
        workspace.id,
        selected.path,
        Number(compareFrom),
        selected.currentVersion,
      )
      setDiff(result.diff || "Sin cambios de texto")
    } catch (error: any) {
      toast.error(error?.message || "No se pudo comparar las versiones")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <div className="border-b border-border/50 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Buscar archivos"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>
      <div className="grid min-h-0 grid-cols-[minmax(145px,38%)_minmax(0,1fr)]">
        <ScrollArea className="border-r border-border/50">
          <FileTree files={visibleFiles} selectedPath={selected?.path} onSelect={openFile} />
        </ScrollArea>
        <div className="flex min-h-0 flex-col bg-muted/[0.08]">
          {!selected ? (
            <div className="flex h-full flex-col items-center justify-center px-5 text-center">
              <FileText className="mb-3 h-7 w-7 text-muted-foreground/35" />
              <p className="text-xs font-medium">Selecciona un archivo</p>
              <p className="mt-1 text-[11px] text-muted-foreground">Previsualiza contenido, versiones y cambios.</p>
            </div>
          ) : (
            <>
              <div className="flex min-h-12 items-center gap-2 border-b border-border/50 px-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium" title={selected.path}>{selected.path}</p>
                  <p className="text-[10px] text-muted-foreground">
                    v{selected.currentVersion} · {fileSize(selected.size)} · {formatDate(selected.updatedAt)}
                  </p>
                </div>
                {selected.currentVersion > 1 && (
                  <>
                    <Select value={compareFrom} onValueChange={setCompareFrom}>
                      <SelectTrigger className="h-7 w-[68px] px-2 text-[10px]" aria-label="Versión base para comparar">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(selected.versions || [])
                          .filter((version) => version.version < selected.currentVersion)
                          .map((version) => (
                            <SelectItem key={version.id} value={String(version.version)}>v{version.version}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title={`Comparar v${compareFrom} con v${selected.currentVersion}`}
                      aria-label={`Comparar v${compareFrom} con v${selected.currentVersion}`}
                      onClick={compare}
                    >
                      <GitCompareArrows className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Descargar archivo"
                  aria-label="Descargar archivo"
                  onClick={() => void coworkApi.downloadFile(workspace.id, selected.path).catch((error) => toast.error(error.message))}
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                {busy ? (
                  <div className="flex h-40 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin" /></div>
                ) : diff !== null ? (
                  <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-foreground/80">{diff}</pre>
                ) : content?.encoding === "base64" ? (
                  <div className="p-4 text-xs text-muted-foreground">
                    Este archivo binario está disponible para descarga. La vista previa de texto no aplica.
                  </div>
                ) : (
                  <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
                    {content?.content || "Archivo vacío"}
                  </pre>
                )}
              </ScrollArea>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ApprovalInbox({
  approvals,
  onDecision,
}: {
  approvals: CoworkApproval[]
  onDecision: (approval: CoworkApproval, decision: "allow" | "deny") => Promise<void>
}) {
  if (!approvals.length) return null
  return (
    <section className="border-b border-amber-500/25 bg-amber-500/[0.04]">
      <div className="flex items-center gap-2 px-3 py-2">
        <Inbox className="h-4 w-4 text-amber-600" />
        <span className="text-xs font-semibold">Aprobaciones pendientes</span>
        <Badge variant="outline" className="ml-auto h-5 px-1.5 text-[10px]">{approvals.length}</Badge>
      </div>
      <div className="divide-y divide-amber-500/15 border-t border-amber-500/15">
        {approvals.map((approval) => (
          <div key={approval.id} className="px-3 py-2.5">
            <p className="text-xs font-medium">{approval.humanDescription || approval.tool}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">Expira {formatDate(approval.expiresAt)}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => void onDecision(approval, "allow")}>
                <Check className="mr-1 h-3.5 w-3.5" /> Aprobar
              </Button>
              <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" onClick={() => void onDecision(approval, "deny")}>
                <X className="mr-1 h-3.5 w-3.5" /> Denegar
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function RunRow({
  run,
  onControl,
  onSteer,
}: {
  run: CoworkRun
  onControl: (run: CoworkRun, action: "pause" | "resume" | "cancel") => Promise<void>
  onSteer: (run: CoworkRun, note: string) => Promise<void>
}) {
  const [expanded, setExpanded] = React.useState(ACTIVE_RUNS.has(run.status))
  const [steering, setSteering] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const progress = Math.min(100, Math.round((Number(run.currentStep || 0) / Math.max(1, Number(run.maxSteps || 1))) * 100))
  const checklist = Array.isArray(run.checklist) ? run.checklist : []

  const submitSteering = async () => {
    const note = steering.trim()
    if (!note || busy) return
    setBusy(true)
    try {
      await onSteer(run, note)
      setSteering("")
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-start gap-2 px-3 py-3 text-left hover:bg-muted/25"
      >
        <StatusDot status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-medium">{run.prompt}</span>
            {run.parentRunId && <Badge variant="secondary" className="h-4 px-1 text-[9px]">Subtarea</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            <span>{statusLabel(run.status)}</span>
            <span>{run.currentStep}/{run.maxSteps} pasos</span>
            <span>{money(run.costUsd)}</span>
            <span>{formatDate(run.updatedAt)}</span>
          </div>
        </div>
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="space-y-3 px-3 pb-3 pl-7">
          <div>
            <div className="mb-1 flex justify-between text-[10px] text-muted-foreground">
              <span>Presupuesto de pasos</span>
              <span>{progress}%</span>
            </div>
            <Progress value={progress} className="h-1.5" />
          </div>
          {run.lastEvent && (
            <p className="rounded border border-border/50 bg-muted/25 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              {run.lastEvent}
            </p>
          )}
          {checklist.length > 0 && (
            <div className="space-y-1.5">
              {checklist.map((item, index) => (
                <div key={item.id || `${index}-${item.text}`} className="flex items-start gap-2 text-[11px]">
                  {item.status === "completed" ? (
                    <Check className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  ) : item.status === "blocked" ? (
                    <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-red-500" />
                  ) : item.status === "in_progress" ? (
                    <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 animate-spin text-sky-500" />
                  ) : (
                    <Circle className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                  )}
                  <span className={cn(item.status === "completed" && "text-muted-foreground line-through")}>{item.text}</span>
                </div>
              ))}
            </div>
          )}
          {ACTIVE_RUNS.has(run.status) && (
            <>
              <div className="flex gap-1.5">
                {run.status === "running" && (
                  <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]" onClick={() => void onControl(run, "pause")}>
                    <Pause className="mr-1 h-3 w-3" /> Pausar
                  </Button>
                )}
                {run.status === "paused" && (
                  <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]" onClick={() => void onControl(run, "resume")}>
                    <Play className="mr-1 h-3 w-3" /> Reanudar
                  </Button>
                )}
                <Button variant="outline" size="sm" className="h-7 px-2 text-[10px] text-red-600 hover:text-red-600" onClick={() => void onControl(run, "cancel")}>
                  <Square className="mr-1 h-3 w-3" /> Detener
                </Button>
              </div>
              {!["waiting_approval", "queued"].includes(run.status) && (
                <div className="flex gap-1.5">
                  <Input
                    value={steering}
                    onChange={(event) => setSteering(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault()
                        void submitSteering()
                      }
                    }}
                    placeholder="Añade una instrucción sin detener la tarea"
                    className="h-8 text-[11px]"
                  />
                  <Button size="icon" className="h-8 w-8 shrink-0" onClick={() => void submitSteering()} disabled={!steering.trim() || busy} title="Dirigir tarea">
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </article>
  )
}

function TasksView({
  runs,
  approvals,
  onRefresh,
}: {
  runs: CoworkRun[]
  approvals: CoworkApproval[]
  onRefresh: () => Promise<void>
}) {
  const decide = async (approval: CoworkApproval, decision: "allow" | "deny") => {
    try {
      await coworkApi.decideApproval(approval.id, decision)
      toast.success(decision === "allow" ? "Acción aprobada" : "Acción denegada")
      await onRefresh()
    } catch (error: any) {
      toast.error(error?.message || "No se pudo registrar la decisión")
    }
  }
  const control = async (run: CoworkRun, action: "pause" | "resume" | "cancel") => {
    try {
      await coworkApi.controlRun(run.id, action)
      toast.success(action === "pause" ? "Tarea pausada" : action === "resume" ? "Tarea reanudada" : "Cancelación solicitada")
      await onRefresh()
    } catch (error: any) {
      toast.error(error?.message || "No se pudo controlar la tarea")
    }
  }
  const steer = async (run: CoworkRun, note: string) => {
    try {
      await coworkApi.steerRun(run.id, note)
      toast.success("La instrucción se aplicará entre pasos")
      await onRefresh()
    } catch (error: any) {
      toast.error(error?.message || "No se pudo dirigir la tarea")
    }
  }
  const executing = runs.filter((run) => ["queued", "running"].includes(run.status))
  const waiting = runs.filter((run) => ["paused", "waiting_approval"].includes(run.status))
  const history = runs.filter((run) => !ACTIVE_RUNS.has(run.status))
  const columns = [
    { id: "executing", label: "En curso", runs: executing },
    { id: "waiting", label: "En espera", runs: waiting },
    { id: "history", label: "Finalizadas", runs: history },
  ]

  return (
    <ScrollArea className="h-full">
      <ApprovalInbox approvals={approvals} onDecision={decide} />
      <div className="grid min-h-[280px] grid-cols-1 min-[560px]:grid-cols-3">
        {columns.map((column, index) => (
          <section
            key={column.id}
            aria-label={column.label}
            className={cn(
              "min-w-0 border-b border-border/50 min-[560px]:border-b-0",
              index < columns.length - 1 && "min-[560px]:border-r",
            )}
          >
            <div className="flex h-9 items-center border-b border-border/50 bg-muted/[0.12] px-3">
              <span className="text-[10px] font-semibold uppercase text-muted-foreground">{column.label}</span>
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">{column.runs.length}</span>
            </div>
            {column.runs.length ? column.runs.map((run) => (
              <RunRow key={run.id} run={run} onControl={control} onSteer={steer} />
            )) : (
              <p className="px-3 py-5 text-center text-[11px] text-muted-foreground">Sin tareas</p>
            )}
          </section>
        ))}
      </div>
    </ScrollArea>
  )
}

function ScheduleView({
  workspace,
  tasks,
  onRefresh,
}: {
  workspace: CoworkWorkspace
  tasks: ScheduledCoworkTask[]
  onRefresh: () => Promise<void>
}) {
  const [creating, setCreating] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [prompt, setPrompt] = React.useState("")
  const [cronExpr, setCronExpr] = React.useState("0 9 * * 1")
  const [tz, setTz] = React.useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Lima")
  const [deliver, setDeliver] = React.useState<"chat" | "email" | "telegram">("chat")

  const create = async () => {
    if (!prompt.trim() || !cronExpr.trim() || busy) return
    setBusy(true)
    try {
      await coworkApi.createScheduledTask({
        workspaceId: workspace.id,
        prompt: prompt.trim(),
        cronExpr: cronExpr.trim(),
        tz,
        deliver,
        maxSteps: 40,
        maxCostUsd: 2,
      })
      toast.success("Tarea programada")
      setPrompt("")
      setCreating(false)
      await onRefresh()
    } catch (error: any) {
      toast.error(error?.message || "No se pudo programar la tarea")
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex items-center border-b border-border/50 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">Automatizaciones</p>
          <p className="text-[10px] text-muted-foreground">Tareas recurrentes con zona horaria y presupuesto.</p>
        </div>
        <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => setCreating((value) => !value)}>
          {creating ? <X className="mr-1 h-3 w-3" /> : <CalendarClock className="mr-1 h-3 w-3" />}
          {creating ? "Cerrar" : "Programar"}
        </Button>
      </div>
      {creating && (
        <div className="space-y-2 border-b border-border/50 bg-muted/20 p-3">
          <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Qué debe hacer el agente" className="min-h-20 resize-none text-xs" />
          <div className="grid grid-cols-2 gap-2">
            <Input value={cronExpr} onChange={(event) => setCronExpr(event.target.value)} placeholder="0 9 * * 1" className="h-8 font-mono text-[11px]" />
            <Input value={tz} onChange={(event) => setTz(event.target.value)} placeholder="America/Lima" className="h-8 text-[11px]" />
          </div>
          <div className="flex gap-2">
            <Select value={deliver} onValueChange={(value) => setDeliver(value as typeof deliver)}>
              <SelectTrigger className="h-8 flex-1 text-[11px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="chat">Entregar en chat</SelectItem>
                <SelectItem value="email">Entregar por email</SelectItem>
                <SelectItem value="telegram">Entregar por Telegram</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" className="h-8" onClick={() => void create()} disabled={!prompt.trim() || busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Guardar"}
            </Button>
          </div>
        </div>
      )}
      {tasks.length ? (
        <div className="divide-y divide-border/50">
          {tasks.map((task) => (
            <article key={task.id} className="px-3 py-3">
              <div className="flex items-start gap-2">
                <StatusDot status={task.enabled ? "running" : "cancelled"} />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-xs font-medium">{task.prompt}</p>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">{task.cronExpr} · {task.tz}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Próxima: {formatDate(task.nextRunAt)} · {task.deliver}
                  </p>
                  {task.lastError && <p className="mt-1 text-[10px] text-red-600">{task.lastError}</p>}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  title={task.enabled ? "Pausar programación" : "Activar programación"}
                  onClick={() => void coworkApi.updateScheduledTask(task.id, { enabled: !task.enabled }).then(onRefresh).catch((error) => toast.error(error.message))}
                >
                  {task.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-red-600"
                  title="Eliminar programación"
                  onClick={() => void coworkApi.deleteScheduledTask(task.id).then(onRefresh).catch((error) => toast.error(error.message))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="flex min-h-52 flex-col items-center justify-center px-6 text-center">
          <CalendarClock className="mb-3 h-8 w-8 text-muted-foreground/35" />
          <p className="text-sm font-medium">Sin tareas programadas</p>
          <p className="mt-1 text-xs text-muted-foreground">Programa informes, revisiones o entregas periódicas.</p>
        </div>
      )}
    </ScrollArea>
  )
}

function ConnectorsView({
  connectors,
  onRefresh,
}: {
  connectors: CoworkConnector[]
  onRefresh: () => Promise<void>
}) {
  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (!event.data || typeof event.data !== "object") return
      const status = String((event.data as any).status || "")
      if (status === "success") {
        toast.success("Conector vinculado")
        void onRefresh()
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [onRefresh])

  return (
    <ScrollArea className="h-full">
      <div className="border-b border-border/50 px-3 py-2.5">
        <p className="text-xs font-medium">Conectores administrados</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
          Las lecturas son automáticas. Toda escritura externa requiere aprobación.
        </p>
      </div>
      <div className="divide-y divide-border/50">
        {connectors.map((connector) => {
          const connected = connector.account?.status === "connected"
          return (
          <article key={connector.id} className="flex items-start gap-3 px-3 py-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border/60 bg-muted/25">
              <Plug className="h-4 w-4 text-muted-foreground" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-xs font-medium">{connector.name}</p>
                <Badge variant={connected ? "default" : "outline"} className="h-4 px-1 text-[9px]">
                  {connected ? "Conectado" : "Disponible"}
                </Badge>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                {connector.capabilities.map((capability) => capability.replaceAll("_", " ")).join(" · ")}
              </p>
              {connector.account?.accountLabel && <p className="mt-1 text-[10px]">{connector.account.accountLabel}</p>}
            </div>
            {connected ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[10px]"
                onClick={() => void coworkApi.disconnectConnector(connector.id).then(onRefresh).catch((error) => toast.error(error.message))}
              >
                Desconectar
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[10px]"
                onClick={() => void coworkApi.beginConnectorConnection(connector.connectUrl || "/settings?s=apps").catch((error) => toast.error(error.message))}
              >
                Conectar
              </Button>
            )}
          </article>
          )
        })}
      </div>
    </ScrollArea>
  )
}

function AuditView({
  logs,
  costs,
}: {
  logs: CoworkAuditLog[]
  costs: CoworkCostSummary | null
}) {
  return (
    <ScrollArea className="h-full">
      <div className="grid grid-cols-3 border-b border-border/50">
        <div className="border-r border-border/50 px-3 py-3">
          <p className="text-[10px] text-muted-foreground">Coste 30 días</p>
          <p className="mt-1 text-sm font-semibold tabular-nums">{money(costs?.totalCostUsd)}</p>
        </div>
        <div className="border-r border-border/50 px-3 py-3">
          <p className="text-[10px] text-muted-foreground">Tokens</p>
          <p className="mt-1 text-sm font-semibold tabular-nums">{Number(costs?.tokensEstimate || 0).toLocaleString("es-PE")}</p>
        </div>
        <div className="px-3 py-3">
          <p className="text-[10px] text-muted-foreground">Acciones</p>
          <p className="mt-1 text-sm font-semibold tabular-nums">{logs.length}</p>
        </div>
      </div>
      <div className="divide-y divide-border/50">
        {logs.map((log) => (
          <article key={log.id} className="flex gap-2.5 px-3 py-2.5">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="break-words font-mono text-[10px] font-medium text-foreground/80">{log.action}</p>
              {(log.resultSummary || log.inputSummary) && (
                <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">
                  {log.resultSummary || log.inputSummary}
                </p>
              )}
            </div>
            <time className="shrink-0 text-[9px] text-muted-foreground">{formatDate(log.createdAt)}</time>
          </article>
        ))}
        {!logs.length && <p className="px-3 py-8 text-center text-xs text-muted-foreground">Aún no hay acciones auditadas.</p>}
      </div>
    </ScrollArea>
  )
}

export default function CoworkPanel({ chatId, onClose }: CoworkPanelProps) {
  const [data, setData] = React.useState<PanelData>(INITIAL_DATA)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [tab, setTab] = React.useState("files")
  const mountedRef = React.useRef(true)
  const workspaceIdRef = React.useRef<string | null>(null)

  const load = React.useCallback(async (quiet = false) => {
    if (!chatId) return
    if (!quiet) setLoading(true)
    else setRefreshing(true)
    try {
      const ensured = await coworkApi.ensureWorkspace(chatId)
      const workspaceId = ensured.workspace.id
      workspaceIdRef.current = workspaceId
      const [workspace, approvals, schedules, connectors, audit, costs] = await Promise.all([
        coworkApi.getWorkspace(workspaceId),
        coworkApi.listApprovals(),
        coworkApi.listScheduledTasks(workspaceId),
        coworkApi.listConnectors(),
        coworkApi.listAudit(workspaceId),
        coworkApi.getCosts(workspaceId),
      ])
      if (!mountedRef.current || workspaceIdRef.current !== workspaceId) return
      setData({
        workspace: workspace.workspace,
        files: workspace.files,
        runs: workspace.recentRuns,
        approvals: approvals.approvals.filter((approval) => {
          if (!approval.runId) return true
          return workspace.recentRuns.some((run) => run.id === approval.runId)
        }),
        scheduledTasks: schedules.tasks,
        connectors: connectors.connectors,
        audit: audit.logs,
        costs,
      })
    } catch (error: any) {
      if (!quiet) toast.error(error?.message || "No se pudo cargar Cowork")
    } finally {
      if (mountedRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [chatId])

  React.useEffect(() => {
    mountedRef.current = true
    workspaceIdRef.current = null
    setData(INITIAL_DATA)
    void load(false)
    return () => {
      mountedRef.current = false
    }
  }, [chatId, load])

  const hasActiveRuns = data.runs.some((run) => ACTIVE_RUNS.has(run.status))
  React.useEffect(() => {
    if (!hasActiveRuns && !data.approvals.length) return
    const timer = window.setInterval(() => void load(true), 2500)
    return () => window.clearInterval(timer)
  }, [data.approvals.length, hasActiveRuns, load])

  const refresh = React.useCallback(async () => {
    await load(true)
  }, [load])

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-border/50 bg-background" aria-label="Workspace Cowork">
      <header className="flex min-h-[58px] items-center gap-3 border-b border-border/50 px-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border/60 bg-muted/25">
          <Folder className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{data.workspace?.name || "Workspace"}</h2>
            {hasActiveRuns && <Badge className="h-4 px-1 text-[9px]">En ejecución</Badge>}
          </div>
          <p className="truncate text-[10px] text-muted-foreground">
            {data.files.length} archivos · {data.runs.filter((run) => ACTIVE_RUNS.has(run.status)).length} tareas activas
          </p>
        </div>
        {data.workspace && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title="Exportar workspace como ZIP"
            aria-label="Exportar workspace como ZIP"
            onClick={() => void coworkApi.exportWorkspace(data.workspace!.id, data.workspace!.name).catch((error) => toast.error(error.message))}
          >
            <Archive className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Actualizar"
          aria-label="Actualizar workspace"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" title="Cerrar" aria-label="Cerrar workspace" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      {loading || !data.workspace ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <p className="text-xs text-muted-foreground">Preparando workspace seguro…</p>
        </div>
      ) : (
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="h-10 w-full justify-start gap-0 rounded-none border-b border-border/50 bg-transparent p-0">
            <TabsTrigger value="files" className="h-10 flex-1 rounded-none border-b-2 border-transparent px-1 text-[10px] data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none">
              <Folder className="mr-1 h-3.5 w-3.5" /> Archivos
            </TabsTrigger>
            <TabsTrigger value="tasks" className="relative h-10 flex-1 rounded-none border-b-2 border-transparent px-1 text-[10px] data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none">
              <Gauge className="mr-1 h-3.5 w-3.5" /> Tareas
              {data.approvals.length > 0 && <span className="absolute right-1 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-500" />}
            </TabsTrigger>
            <TabsTrigger value="schedule" className="h-10 flex-1 rounded-none border-b-2 border-transparent px-1 text-[10px] data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none">
              <Clock3 className="mr-1 h-3.5 w-3.5" /> Agenda
            </TabsTrigger>
            <TabsTrigger value="connectors" className="h-10 flex-1 rounded-none border-b-2 border-transparent px-1 text-[10px] data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none">
              <Plug className="mr-1 h-3.5 w-3.5" /> Apps
            </TabsTrigger>
            <TabsTrigger value="audit" className="h-10 flex-1 rounded-none border-b-2 border-transparent px-1 text-[10px] data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none">
              <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Auditoría
            </TabsTrigger>
          </TabsList>
          <TabsContent value="files" className="mt-0 min-h-0 flex-1"><FilesView workspace={data.workspace} files={data.files} /></TabsContent>
          <TabsContent value="tasks" className="mt-0 min-h-0 flex-1"><TasksView runs={data.runs} approvals={data.approvals} onRefresh={refresh} /></TabsContent>
          <TabsContent value="schedule" className="mt-0 min-h-0 flex-1"><ScheduleView workspace={data.workspace} tasks={data.scheduledTasks} onRefresh={refresh} /></TabsContent>
          <TabsContent value="connectors" className="mt-0 min-h-0 flex-1"><ConnectorsView connectors={data.connectors} onRefresh={refresh} /></TabsContent>
          <TabsContent value="audit" className="mt-0 min-h-0 flex-1"><AuditView logs={data.audit} costs={data.costs} /></TabsContent>
        </Tabs>
      )}
    </aside>
  )
}
