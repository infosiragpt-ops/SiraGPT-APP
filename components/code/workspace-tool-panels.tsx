"use client"

import * as React from "react"
import {
  Activity,
  AlertTriangle,
  Box,
  ChevronDown,
  CheckCircle2,
  Cloud,
  Copy,
  Cpu,
  Database,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileCode2,
  FileJson,
  GitBranch,
  GitCommit,
  Globe2,
  HardDrive,
  History,
  KeyRound,
  LineChart,
  Link2,
  ListChecks,
  Lock,
  Play,
  PlugZap,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  Rocket,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Trash2,
  Upload,
  UploadCloud,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"
import type { WorkspaceToolId } from "@/lib/code-workspace-tools"
import { RealGitPanel } from "@/components/code/git-tool-real"
import { WorkspaceDeploymentsTool } from "@/components/deployments/workspace-deployments-tool"
import { RealPublishingPanel } from "@/components/code/publishing-tool-real"

type Deployment = {
  id: string
  target: "development" | "production"
  status: "ready" | "building" | "failed"
  url: string
  createdAt: number
  deploymentType?: "static" | "autoscale" | "reserved" | "scheduled"
  access?: "public" | "workspace" | "private"
  buildCommand?: string
  runCommand?: string
  publicDirectory?: string
  logs?: string[]
  cpu?: number
  memory?: number
  requests?: number
}

type SecretEntry = {
  id: string
  key: string
  value: string
  scope: "app" | "account"
  updatedAt: number
  linked?: boolean
}

type DbTable = {
  name: string
  columns: string[]
  rows: Record<string, string>[]
}

type WorkflowRun = {
  id: string
  name: string
  command: string
  status: "idle" | "running" | "success" | "failed"
  lastRun?: number
  isDefault?: boolean
}

type ValidationResult = {
  id: string
  label: string
  detail: string
  status: "pass" | "warn" | "fail"
}

type ConsoleLine = {
  stream: "stdout" | "stderr" | "system"
  text: string
}

type ConsoleRun = {
  id: string
  command: string
  status: "running" | "success" | "failed"
  createdAt: number
  endedAt?: number
  lines: ConsoleLine[]
}

const INTEGRATION_GROUPS = [
  {
    id: "managed",
    label: "Managed",
    detail: "Servicios nativos que el agente puede activar sin configurar proveedores externos.",
    items: [
      { id: "managed-database", label: "Database", detail: "Postgres administrado, SQL y DATABASE_URL" },
      { id: "managed-storage", label: "App Storage", detail: "Archivos, imagenes, videos y documentos" },
      { id: "managed-auth", label: "Auth", detail: "Login preconstruido y usuarios de la app" },
      { id: "managed-domains", label: "Domains", detail: "Dominios de desarrollo, produccion y custom" },
    ],
  },
  {
    id: "connectors",
    label: "Connectors",
    detail: "Conexiones de primera linea para leer y escribir desde el agente.",
    items: [
      { id: "github", label: "GitHub", detail: "Repositorios, issues y pull requests" },
      { id: "slack", label: "Slack", detail: "Alertas, mensajes y canales del equipo" },
      { id: "google", label: "Google", detail: "OAuth, Drive, Calendar y datos autorizados" },
    ],
  },
  {
    id: "external",
    label: "External APIs",
    detail: "Servicios externos que usan API keys guardadas en Secrets.",
    items: [
      { id: "stripe", label: "Stripe", detail: "Pagos, checkout, suscripciones y webhooks" },
      { id: "supabase", label: "Supabase", detail: "Postgres, auth y storage externo" },
      { id: "openai", label: "OpenAI", detail: "Modelos, respuestas, vision y herramientas" },
    ],
  },
  {
    id: "agent-services",
    label: "Agent services",
    detail: "Capacidades que el agente consume sin exponer claves al proyecto.",
    items: [
      { id: "web-search", label: "Web Search", detail: "Busqueda de contexto para construir y depurar" },
      { id: "image-gen", label: "Image Generation", detail: "Assets, mockups y recursos visuales" },
      { id: "long-running", label: "Long-running agents", detail: "Tareas de larga duracion con seguimiento" },
    ],
  },
]

const SKILL_ROWS = [
  { id: "planner", label: "Planner", detail: "Descompone una idea en tareas ejecutables" },
  { id: "builder", label: "Builder", detail: "Genera archivos y aplica cambios al workspace" },
  { id: "debugger", label: "Debugger", detail: "Lee consola, errores y propone fixes" },
  { id: "reviewer", label: "Reviewer", detail: "Revisa seguridad, UX y regresiones" },
]

function makeId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function useWorkspacePersistedState<T>(suffix: string, fallback: T) {
  const { activeFolder } = useCodeWorkspace()
  const key = React.useMemo(
    () => `siragpt:code-tool:${activeFolder?.id || "default"}:${suffix}`,
    [activeFolder?.id, suffix],
  )
  const fallbackRef = React.useRef(fallback)
  const [loaded, setLoaded] = React.useState(false)
  const [state, setState] = React.useState<T>(fallback)

  React.useEffect(() => {
    setLoaded(false)
    try {
      const raw = window.localStorage.getItem(key)
      setState(raw ? JSON.parse(raw) as T : fallbackRef.current)
    } catch {
      setState(fallbackRef.current)
    } finally {
      setLoaded(true)
    }
  }, [key])

  React.useEffect(() => {
    if (!loaded) return
    try {
      window.localStorage.setItem(key, JSON.stringify(state))
    } catch {
      /* local storage unavailable */
    }
  }, [key, loaded, state])

  return [state, setState] as const
}

export function WorkspaceToolPanel({ toolId }: { toolId: WorkspaceToolId }) {
  switch (toolId) {
    case "console":
      return <ConsoleTool />
    case "publishing":
      // DEPLOYMENTS_V2 on ⇒ the real project-scoped Deployments module; off ⇒
      // the legacy mock (keeps prod unchanged until the flag is enabled).
      return <WorkspaceDeploymentsTool fallback={<PublishingTool />} />
    case "secrets":
      return <SecretsTool />
    case "database":
      return <DatabaseTool />
    case "storage":
      return <StorageTool />
    case "integrations":
      return <IntegrationsTool />
    case "auth":
      return <AuthTool />
    case "security":
      return <SecurityTool />
    case "analytics":
      return <AnalyticsTool />
    case "automations":
      return <AutomationsTool />
    case "skills":
      return <SkillsTool />
    case "settings":
      return <SettingsToolPanel />
    case "validation":
      return <ValidationTool />
    case "developer":
      return <DeveloperTool />
    case "git":
      return <GitTool />
    case "workflows":
      return <WorkflowsTool />
    case "vnc":
      return <VncTool />
    case "canvas":
      return <CanvasTool />
    default:
      return <GenericTool toolId={toolId} />
  }
}

function ToolShell({
  eyebrow,
  title,
  detail,
  action,
  children,
}: {
  eyebrow: string
  title: string
  detail: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border/50 px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
            <h2 className="mt-1 text-[18px] font-semibold tracking-tight text-foreground">{title}</h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted-foreground">{detail}</p>
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
    </div>
  )
}

function PanelGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 lg:grid-cols-2">{children}</div>
}

function PanelCard({
  title,
  detail,
  icon,
  children,
  className,
}: {
  title: string
  detail?: string
  icon?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("rounded-lg border border-border/60 bg-card/80 p-4 shadow-sm", className)}>
      <div className="flex items-start gap-3">
        {icon ? (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
          {detail ? <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{detail}</p> : null}
        </div>
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  )
}

function StatusPill({ status }: { status: "ready" | "building" | "failed" | "pass" | "warn" | "fail" | "running" | "idle" | "success" }) {
  const label: Record<typeof status, string> = {
    ready: "Ready",
    building: "Building",
    failed: "Failed",
    pass: "Pass",
    warn: "Warning",
    fail: "Fail",
    running: "Running",
    idle: "Idle",
    success: "Success",
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        (status === "ready" || status === "pass" || status === "success") && "border-emerald-500/25 bg-emerald-500/10 text-emerald-600",
        (status === "warn" || status === "building" || status === "running") && "border-amber-500/25 bg-amber-500/10 text-amber-600",
        (status === "failed" || status === "fail") && "border-rose-500/25 bg-rose-500/10 text-rose-600",
        status === "idle" && "border-border bg-muted text-muted-foreground",
      )}
    >
      {label[status]}
    </span>
  )
}

function ToolTabs<T extends string>({
  value,
  items,
  onChange,
}: {
  value: T
  items: { id: T; label: string }[]
  onChange: (id: T) => void
}) {
  return (
    <div className="inline-flex rounded-lg border border-border/60 bg-muted/25 p-1">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onChange(item.id)}
          className={cn(
            "h-7 rounded-md px-2.5 text-[12px] font-medium transition-colors",
            value === item.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function formatDateTime(value?: number) {
  return value ? new Date(value).toLocaleString() : "Sin ejecutar"
}

function copyToClipboard(value: string, success: string) {
  void navigator.clipboard?.writeText(value).then(
    () => toast.success(success),
    () => toast.error("No se pudo copiar al portapapeles."),
  )
}

function PublishingTool() {
  const { activeFolder } = useCodeWorkspace()
  // Legacy simulation kept behind a flag (set true to bring it back).
  const SHOW_LEGACY: boolean = false
  if (SHOW_LEGACY) return <LegacyPublishingTool />
  return (
    <ToolShell
      eyebrow="Deployments"
      title="Publishing"
      detail="Publica tu proyecto en Hostinger: build + subida (SFTP/FTP), URL en vivo e historial."
    >
      <RealPublishingPanel projectId={activeFolder?.id || null} />
    </ToolShell>
  )
}

function LegacyPublishingTool() {
  const { files, activeFolder, workspaceSource } = useCodeWorkspace()
  const [deployments, setDeployments] = useWorkspacePersistedState<Deployment[]>("deployments", [])
  const [settings, setSettings] = useWorkspacePersistedState("publishing-settings", {
    domain: "siragpt-app.local",
    deploymentType: "autoscale" as NonNullable<Deployment["deploymentType"]>,
    access: "public" as NonNullable<Deployment["access"]>,
    buildCommand: "npm run build",
    runCommand: "npm run start",
    publicDirectory: "dist",
  })
  const [target, setTarget] = React.useState<"development" | "production">("production")
  const [activeTab, setActiveTab] = React.useState<"overview" | "logs" | "resources" | "analytics">("overview")
  const [, setConsoleRuns] = useWorkspacePersistedState<ConsoleRun[]>("console-runs", [])
  const [publishing, setPublishing] = React.useState(false)

  const publish = () => {
    setPublishing(true)
    const startedAt = Date.now()
    const runId = makeId("console")
    const pendingRun: ConsoleRun = {
      id: runId,
      command: `deploy:${target}`,
      status: "running",
      createdAt: startedAt,
      lines: [
        { stream: "system", text: `Preparing ${target} deployment` },
        { stream: "stdout", text: settings.buildCommand },
        { stream: "stdout", text: settings.runCommand },
      ],
    }
    setConsoleRuns((prev) => [pendingRun, ...prev].slice(0, 20))
    window.setTimeout(() => {
      const hasFiles = Object.keys(files).length > 0
      const next: Deployment = {
        id: makeId("deploy"),
        target,
        status: hasFiles ? "ready" : "failed",
        url: `https://${settings.domain}`,
        createdAt: Date.now(),
        deploymentType: settings.deploymentType,
        access: settings.access,
        buildCommand: settings.buildCommand,
        runCommand: settings.runCommand,
        publicDirectory: settings.publicDirectory,
        logs: hasFiles
          ? [
              "Build completed",
              "Static assets optimized",
              "Health check passed",
              `Serving ${settings.domain}`,
            ]
          : ["Build failed: no workspace files were found"],
        cpu: hasFiles ? 18 + Math.round(Math.random() * 22) : 0,
        memory: hasFiles ? 112 + Math.round(Math.random() * 160) : 0,
        requests: hasFiles ? 240 + Math.round(Math.random() * 900) : 0,
      }
      setDeployments((prev) => [next, ...prev].slice(0, 8))
      setConsoleRuns((prev) => prev.map((row) => row.id === runId
        ? {
            ...row,
            status: next.status === "ready" ? "success" : "failed",
            endedAt: Date.now(),
            lines: [
              ...row.lines,
              ...(next.logs || []).map((text) => ({ stream: next.status === "ready" ? "stdout" as const : "stderr" as const, text })),
            ],
          }
        : row,
      ))
      setPublishing(false)
      toast[next.status === "ready" ? "success" : "error"](
        next.status === "ready" ? "Deploy registrado." : "No hay archivos para publicar.",
      )
    }, 650)
  }

  const latest = deployments[0]
  const deployStatus: Deployment["status"] | "idle" = latest ? latest.status : "idle"
  const deployStatusLabel = publishing ? "building" : deployStatus === "idle" ? "Sin deploys" : deployStatus
  const deploymentTypeLabel = {
    static: "Static",
    autoscale: "Autoscale",
    reserved: "Reserved VM",
    scheduled: "Scheduled",
  }[latest?.deploymentType || settings.deploymentType]

  return (
    <ToolShell
      eyebrow="Deployments"
      title="Publishing"
      detail="Publica una version compartible, revisa status, comandos, logs, recursos y analitica del deploy."
      action={
        <Button size="sm" onClick={publish} disabled={publishing} className="h-8 gap-1.5">
          {publishing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
          {latest ? "Republish" : "Publish"}
        </Button>
      }
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <ToolTabs
          value={activeTab}
          onChange={setActiveTab}
          items={[
            { id: "overview", label: "Overview" },
            { id: "logs", label: "Logs" },
            { id: "resources", label: "Resources" },
            { id: "analytics", label: "Analytics" },
          ]}
        />
        <div className="flex gap-2">
          {(["development", "production"] as const).map((row) => (
            <button
              key={row}
              type="button"
              onClick={() => setTarget(row)}
              className={cn(
                "h-8 rounded-md border px-3 text-[12px] transition-colors",
                target === row ? "border-foreground bg-foreground text-background" : "border-border bg-background hover:bg-muted",
              )}
            >
              {row === "development" ? "Development" : "Production"}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "overview" ? (
        <PanelGrid>
          <PanelCard title="Deployment status" detail={activeFolder?.name || workspaceSource.name} icon={<Globe2 className="h-4 w-4" />}>
            <div className="space-y-3">
              <ActivityRow label="Status" value={deployStatusLabel} />
              <ActivityRow label="Domain" value={latest?.url || `https://${settings.domain}`} />
              <ActivityRow label="Type" value={deploymentTypeLabel} />
              <ActivityRow label="Access" value={latest?.access || settings.access} />
              <ActivityRow label="Workspace files" value={String(Object.keys(files).length)} />
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={!latest} onClick={() => latest && window.open(latest.url, "_blank", "noopener,noreferrer")}>
                  <ExternalLink className="h-3.5 w-3.5" />
                  View app
                </Button>
                <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setActiveTab("logs")}>
                  <ListChecks className="h-3.5 w-3.5" />
                  View logs
                </Button>
                <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setActiveTab("resources")}>
                  <Cpu className="h-3.5 w-3.5" />
                  Usage
                </Button>
              </div>
            </div>
          </PanelCard>
          <PanelCard title="Commands and domain" detail="Configuracion que usa el deploy seleccionado" icon={<SlidersHorizontal className="h-4 w-4" />}>
            <div className="grid gap-2">
              <label className="block text-[12px] font-medium text-foreground">
                Domain
                <Input value={settings.domain} onChange={(e) => setSettings((prev) => ({ ...prev, domain: e.target.value }))} className="mt-1 h-8 text-[12px]" />
              </label>
              <label className="block text-[12px] font-medium text-foreground">
                Build command
                <Input value={settings.buildCommand} onChange={(e) => setSettings((prev) => ({ ...prev, buildCommand: e.target.value }))} className="mt-1 h-8 font-mono text-[12px]" />
              </label>
              <label className="block text-[12px] font-medium text-foreground">
                Run command
                <Input value={settings.runCommand} onChange={(e) => setSettings((prev) => ({ ...prev, runCommand: e.target.value }))} className="mt-1 h-8 font-mono text-[12px]" />
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                <select
                  value={settings.deploymentType}
                  onChange={(e) => setSettings((prev) => ({ ...prev, deploymentType: e.target.value as NonNullable<Deployment["deploymentType"]> }))}
                  className="h-8 rounded-md border border-input bg-background px-2 text-[12px]"
                >
                  <option value="static">Static</option>
                  <option value="autoscale">Autoscale</option>
                  <option value="reserved">Reserved VM</option>
                  <option value="scheduled">Scheduled</option>
                </select>
                <select
                  value={settings.access}
                  onChange={(e) => setSettings((prev) => ({ ...prev, access: e.target.value as NonNullable<Deployment["access"]> }))}
                  className="h-8 rounded-md border border-input bg-background px-2 text-[12px]"
                >
                  <option value="public">Public</option>
                  <option value="workspace">Workspace</option>
                  <option value="private">Only you</option>
                </select>
              </div>
            </div>
          </PanelCard>
          <PanelCard title="History" detail="Deploys recientes de este workspace" icon={<History className="h-4 w-4" />} className="lg:col-span-2">
            <div className="space-y-2">
              {deployments.length === 0 ? (
                <p className="rounded-md bg-muted/35 px-3 py-3 text-[12px] text-muted-foreground">Aun no publicaste este workspace.</p>
              ) : (
                deployments.map((row) => (
                  <div key={row.id} className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[12px]">{row.url}</p>
                      <p className="text-[11px] text-muted-foreground">{formatDateTime(row.createdAt)} · {row.target} · {row.deploymentType || "autoscale"}</p>
                    </div>
                    <StatusPill status={row.status} />
                  </div>
                ))
              )}
            </div>
          </PanelCard>
        </PanelGrid>
      ) : null}

      {activeTab === "logs" ? (
        <PanelCard title="Deployment logs" detail="Salida historica del ultimo publish" icon={<ListChecks className="h-4 w-4" />}>
          <pre className="max-h-[520px] overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-[12px] leading-5 text-zinc-100">
            {(latest?.logs?.length ? latest.logs : ["No deployment logs yet. Run Publish to generate logs."]).map((line, index) => `[${String(index + 1).padStart(2, "0")}] ${line}`).join("\n")}
          </pre>
        </PanelCard>
      ) : null}

      {activeTab === "resources" ? (
        <PanelGrid>
          <ResourceMeter label="CPU" value={latest?.cpu || 0} suffix="%" icon={<Cpu className="h-4 w-4" />} />
          <ResourceMeter label="Memory" value={latest?.memory || 0} max={512} suffix=" MB" icon={<Server className="h-4 w-4" />} />
          <ResourceMeter label="Requests" value={latest?.requests || 0} max={1200} suffix="" icon={<Activity className="h-4 w-4" />} />
          <PanelCard title="QR and manage" detail="Accesos rapidos para compartir o administrar" icon={<QrCode className="h-4 w-4" />}>
            <div className="grid grid-cols-[80px_1fr] gap-3">
              <div className="grid h-20 w-20 place-items-center rounded-md border border-border/60 bg-muted/30 font-mono text-[10px] text-muted-foreground">QR</div>
              <div className="space-y-2">
                <Button size="sm" variant="outline" className="h-8 w-full justify-start gap-1.5" disabled={!latest}>
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open deployment
                </Button>
                <Button size="sm" variant="outline" className="h-8 w-full justify-start gap-1.5" onClick={() => setActiveTab("overview")}>
                  <Settings className="h-3.5 w-3.5" />
                  Manage settings
                </Button>
              </div>
            </div>
          </PanelCard>
        </PanelGrid>
      ) : null}

      {activeTab === "analytics" ? (
        <PanelGrid>
          <Metric title="Deploys" value={String(deployments.length)} />
          <Metric title="Requests" value={String(deployments.reduce((sum, row) => sum + (row.requests || 0), 0))} />
          <Metric title="Success rate" value={deployments.length ? `${Math.round((deployments.filter((row) => row.status === "ready").length / deployments.length) * 100)}%` : "0%"} />
          <Metric title="Last deploy" value={latest ? formatDateTime(latest.createdAt) : "None"} />
          <PanelCard title="Traffic" detail="Metrica sintetica del workspace local" icon={<LineChart className="h-4 w-4" />} className="lg:col-span-2">
            <div className="flex h-48 items-end gap-2 rounded-md border border-border/60 bg-muted/20 p-3">
              {[24, 42, 35, 68, 52, 88, 61, 93, 74, 56, 82, 100].map((value, idx) => (
                <div key={idx} className="flex flex-1 items-end">
                  <div className="w-full rounded-t bg-foreground/75" style={{ height: `${value}%` }} />
                </div>
              ))}
            </div>
          </PanelCard>
        </PanelGrid>
      ) : null}
    </ToolShell>
  )
}

function ResourceMeter({
  label,
  value,
  max = 100,
  suffix,
  icon,
}: {
  label: string
  value: number
  max?: number
  suffix: string
  icon: React.ReactNode
}) {
  const pct = Math.min(100, Math.round((value / max) * 100))
  return (
    <PanelCard title={label} detail={`${value}${suffix}`} icon={icon}>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">{pct}% de uso del limite local</p>
    </PanelCard>
  )
}

function SecretsTool() {
  const [secrets, setSecrets] = useWorkspacePersistedState<SecretEntry[]>("secrets", [])
  const [keyName, setKeyName] = React.useState("")
  const [value, setValue] = React.useState("")
  const [scope, setScope] = React.useState<"app" | "account">("app")
  const [activeTab, setActiveTab] = React.useState<"app" | "account" | "env">("app")
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editingValue, setEditingValue] = React.useState("")
  const [revealed, setRevealed] = React.useState<Set<string>>(new Set())

  const addSecret = () => {
    const key = keyName.trim().replace(/\s+/g, "_").toUpperCase()
    if (!key || !value) return
    setSecrets((prev) => [
      { id: makeId("secret"), key, value, scope, linked: scope === "account", updatedAt: Date.now() },
      ...prev.filter((row) => !(row.key === key && row.scope === scope)),
    ])
    setKeyName("")
    setValue("")
  }

  const predefined = [
    { key: "REPLIT_DOMAINS", value: "siragpt-app.local" },
    { key: "REPLIT_DEV_DOMAIN", value: "127.0.0.1:3000" },
    { key: "REPLIT_USER", value: "Admin User" },
    { key: "REPLIT_DEPLOYMENT", value: "workspace" },
    { key: "DATABASE_URL", value: "postgres://workspace:local@siragpt/db" },
  ]
  const appSecrets = secrets.filter((row) => row.scope === "app")
  const accountSecrets = secrets.filter((row) => row.scope === "account")
  const envRows = [
    ...predefined,
    ...appSecrets,
    ...accountSecrets.filter((row) => row.linked !== false),
  ]
  const envText = envRows.map((row) => `${row.key}=${JSON.stringify(row.value)}`).join("\n")
  const jsonText = JSON.stringify(Object.fromEntries(envRows.map((row) => [row.key, row.value])), null, 2)

  return (
    <ToolShell
      eyebrow="Environment"
      title="Secrets"
      detail="Gestiona variables sensibles por workspace. Los valores se muestran enmascarados y se guardan solo en este navegador local."
      action={
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5"
          onClick={() => copyToClipboard(envText, ".env copiado")}
          disabled={!envRows.length}
        >
          <Copy className="h-3.5 w-3.5" />
          Copiar .env
        </Button>
      }
    >
      <div className="mb-4">
        <ToolTabs
          value={activeTab}
          onChange={setActiveTab}
          items={[
            { id: "app", label: "App Secrets" },
            { id: "account", label: "Account Secrets" },
            { id: "env", label: ".env / JSON" },
          ]}
        />
      </div>
      <PanelGrid>
        <PanelCard title="Nuevo secret" detail="Equivalente local al panel de App Secrets" icon={<KeyRound className="h-4 w-4" />}>
          <div className="space-y-2">
            <Input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="OPENAI_API_KEY" className="h-8 text-[12px]" />
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Valor" type="password" className="h-8 text-[12px]" />
            <div className="flex items-center justify-between gap-2">
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as "app" | "account")}
                className="h-8 rounded-md border border-input bg-background px-2 text-[12px]"
              >
                <option value="app">App Secret</option>
                <option value="account">Account Secret</option>
              </select>
              <Button size="sm" className="h-8 gap-1.5" onClick={addSecret} disabled={!keyName.trim() || !value}>
                <Plus className="h-3.5 w-3.5" />
                Agregar
              </Button>
            </div>
          </div>
        </PanelCard>
        {activeTab !== "env" ? (
          <PanelCard
            title={activeTab === "app" ? "Variables de la app" : "Secrets de cuenta"}
            detail={activeTab === "app" ? `${appSecrets.length} secrets del workspace` : `${accountSecrets.length} secrets disponibles para enlazar`}
            icon={<Lock className="h-4 w-4" />}
          >
            <SecretList
              rows={activeTab === "app" ? appSecrets : accountSecrets}
              revealed={revealed}
              editingId={editingId}
              editingValue={editingValue}
              accountMode={activeTab === "account"}
              onReveal={(id) => setRevealed((prev) => {
                const next = new Set(prev)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })}
              onEdit={(row) => {
                setEditingId(row.id)
                setEditingValue(row.value)
              }}
              onChangeEdit={setEditingValue}
              onSaveEdit={(row) => {
                setSecrets((prev) => prev.map((item) => item.id === row.id ? { ...item, value: editingValue, updatedAt: Date.now() } : item))
                setEditingId(null)
                setEditingValue("")
              }}
              onToggleLink={(row) => setSecrets((prev) => prev.map((item) => item.id === row.id ? { ...item, linked: item.linked === false } : item))}
              onDelete={(id) => setSecrets((prev) => prev.filter((item) => item.id !== id))}
            />
          </PanelCard>
        ) : (
          <PanelCard title="Export" detail="Variables efectivas: predefinidas, app secrets y account secrets enlazados" icon={<FileJson className="h-4 w-4" />}>
            <div className="grid gap-3">
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[12px] font-medium">.env</p>
                  <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={() => copyToClipboard(envText, ".env copiado")}>
                    <Copy className="h-3 w-3" />
                    Copiar
                  </Button>
                </div>
                <pre className="max-h-44 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-5">{envText}</pre>
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[12px] font-medium">JSON</p>
                  <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={() => copyToClipboard(jsonText, "JSON copiado")}>
                    <Copy className="h-3 w-3" />
                    Copiar
                  </Button>
                </div>
                <pre className="max-h-44 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-5">{jsonText}</pre>
              </div>
            </div>
          </PanelCard>
        )}
      </PanelGrid>
    </ToolShell>
  )
}

function SecretList({
  rows,
  revealed,
  editingId,
  editingValue,
  accountMode,
  onReveal,
  onEdit,
  onChangeEdit,
  onSaveEdit,
  onToggleLink,
  onDelete,
}: {
  rows: SecretEntry[]
  revealed: Set<string>
  editingId: string | null
  editingValue: string
  accountMode: boolean
  onReveal: (id: string) => void
  onEdit: (row: SecretEntry) => void
  onChangeEdit: (value: string) => void
  onSaveEdit: (row: SecretEntry) => void
  onToggleLink: (row: SecretEntry) => void
  onDelete: (id: string) => void
}) {
  if (rows.length === 0) {
    return <p className="rounded-md bg-muted/35 px-3 py-3 text-[12px] text-muted-foreground">Sin secrets todavia.</p>
  }
  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const open = revealed.has(row.id)
        const editing = editingId === row.id
        return (
          <div key={row.id} className="rounded-md border border-border/50 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[12px] font-medium">{row.key}</p>
                {editing ? (
                  <Input
                    value={editingValue}
                    onChange={(event) => onChangeEdit(event.target.value)}
                    className="mt-1 h-8 font-mono text-[12px]"
                    autoFocus
                  />
                ) : (
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {open ? row.value : "••••••••••••••••"} · {row.scope}
                    {accountMode ? ` · ${row.linked === false ? "unlinked" : "linked"}` : ""}
                  </p>
                )}
              </div>
              {editing ? (
                <Button size="sm" className="h-7" onClick={() => onSaveEdit(row)}>Guardar</Button>
              ) : (
                <>
                  {accountMode ? (
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => onToggleLink(row)}>
                      {row.linked === false ? "Link" : "Unlink"}
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(row)} aria-label={`Editar ${row.key}`}>
                    <Settings className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onReveal(row.id)} aria-label={open ? "Ocultar secret" : "Mostrar secret"}>
                    {open ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-rose-600" onClick={() => onDelete(row.id)} aria-label={`Eliminar ${row.key}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DatabaseTool() {
  const fallback: DbTable[] = [
    {
      name: "users",
      columns: ["id", "name", "role"],
      rows: [
        { id: "1", name: "Admin User", role: "admin" },
        { id: "2", name: "Cliente demo", role: "member" },
      ],
    },
  ]
  const [tables, setTables] = useWorkspacePersistedState<DbTable[]>("database", fallback)
  const [environment, setEnvironment] = useWorkspacePersistedState<"development" | "production">("database-env", "development")
  const [query, setQuery] = React.useState("select * from users")
  const [selected, setSelected] = React.useState("users")
  const table = tables.find((row) => row.name === selected) || tables[0]
  const result = React.useMemo(() => runSql(query, tables), [query, tables])

  const addRow = () => {
    if (!table) return
    setTables((prev) => prev.map((item) => {
      if (item.name !== table.name) return item
      const nextIndex = item.rows.length + 1
      const row = Object.fromEntries(item.columns.map((col) => [col, col === "id" ? String(nextIndex) : `${col}_${nextIndex}`]))
      return { ...item, rows: [...item.rows, row] }
    }))
  }

  return (
    <ToolShell
      eyebrow="Database"
      title="Postgres workspace"
      detail="Explora tablas, ejecuta consultas simples y prueba datos locales antes de conectar una base real."
      action={<Button size="sm" className="h-8 gap-1.5" onClick={addRow}><Plus className="h-3.5 w-3.5" />Fila demo</Button>}
    >
      <div className="grid min-h-[520px] gap-3 lg:grid-cols-[220px_1fr]">
        <PanelCard title="Tablas" detail="Modelo local" icon={<Database className="h-4 w-4" />} className="h-fit">
          <div className="space-y-1">
            {tables.map((row) => (
              <button
                key={row.name}
                type="button"
                onClick={() => {
                  setSelected(row.name)
                  setQuery(`select * from ${row.name}`)
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px]",
                  selected === row.name ? "bg-foreground text-background" : "hover:bg-muted",
                )}
              >
                <span>{row.name}</span>
                <span>{row.rows.length}</span>
              </button>
            ))}
          </div>
        </PanelCard>
        <div className="space-y-3">
          <PanelCard title="Connection" detail="Credenciales locales del workspace" icon={<Cloud className="h-4 w-4" />}>
            <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Environment</p>
                <ToolTabs
                  value={environment}
                  onChange={setEnvironment}
                  items={[
                    { id: "development", label: "Development" },
                    { id: "production", label: "Production" },
                  ]}
                />
              </div>
              <div className="min-w-0">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">DATABASE_URL</p>
                <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
                  <code className="min-w-0 flex-1 truncate text-[11px]">postgres://workspace:{environment}@siragpt.local/{environment}</code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    aria-label="Copiar DATABASE_URL"
                    onClick={() => copyToClipboard(`postgres://workspace:${environment}@siragpt.local/${environment}`, "DATABASE_URL copiado")}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-foreground" style={{ width: `${Math.min(100, tables.reduce((sum, row) => sum + row.rows.length, 0) * 8)}%` }} />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">Uso local estimado a partir de filas guardadas en el navegador.</p>
          </PanelCard>
          <PanelCard title="SQL runner" detail="Soporta SELECT *, SELECT COUNT(*) y SHOW TABLES" icon={<Play className="h-4 w-4" />}>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
              className="h-24 w-full resize-none rounded-md border border-input bg-background p-3 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <div className="mt-3 overflow-hidden rounded-md border border-border/60">
              <DataTable columns={result.columns} rows={result.rows} />
            </div>
          </PanelCard>
          {table ? (
            <PanelCard title={`Tabla: ${table.name}`} detail={`${table.columns.length} columnas · ${table.rows.length} filas`} icon={<Box className="h-4 w-4" />}>
              <div className="overflow-hidden rounded-md border border-border/60">
                <DataTable columns={table.columns} rows={table.rows} />
              </div>
            </PanelCard>
          ) : null}
        </div>
      </div>
    </ToolShell>
  )
}

function runSql(query: string, tables: DbTable[]) {
  const q = query.trim().toLowerCase()
  if (q === "show tables") {
    return { columns: ["table", "rows"], rows: tables.map((row) => ({ table: row.name, rows: String(row.rows.length) })) }
  }
  const count = q.match(/^select\s+count\(\*\)\s+from\s+([a-z0-9_-]+)/i)
  if (count) {
    const table = tables.find((row) => row.name.toLowerCase() === count[1].toLowerCase())
    return { columns: ["count"], rows: [{ count: String(table?.rows.length ?? 0) }] }
  }
  const select = q.match(/^select\s+\*\s+from\s+([a-z0-9_-]+)/i)
  if (select) {
    const table = tables.find((row) => row.name.toLowerCase() === select[1].toLowerCase())
    if (!table) return { columns: ["error"], rows: [{ error: `table not found: ${select[1]}` }] }
    return { columns: table.columns, rows: table.rows }
  }
  return { columns: ["message"], rows: [{ message: "Consulta no soportada en el runner local." }] }
}

function DataTable({ columns, rows }: { columns: string[]; rows: Record<string, string>[] }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full min-w-[420px] border-collapse text-left text-[12px]">
        <thead className="sticky top-0 bg-muted">
          <tr>
            {columns.map((col) => (
              <th key={col} className="border-b border-border/60 px-3 py-2 font-medium text-muted-foreground">{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={Math.max(columns.length, 1)} className="px-3 py-6 text-center text-muted-foreground">Sin filas</td>
            </tr>
          ) : (
            rows.map((row, idx) => (
              <tr key={idx} className="odd:bg-muted/20">
                {columns.map((col) => (
                  <td key={col} className="border-b border-border/40 px-3 py-2 font-mono">{row[col] ?? ""}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

function StorageTool() {
  const [assets, setAssets] = useWorkspacePersistedState<{ id: string; name: string; size: number; type: string; createdAt: number }[]>("storage", [])
  return (
    <ToolShell eyebrow="Storage" title="App Storage" detail="Guarda metadatos de archivos del workspace y prepara assets para la app.">
      <PanelGrid>
        <PanelCard title="Subir archivo" detail="El archivo no sale de tu navegador; se registra como asset local." icon={<Upload className="h-4 w-4" />}>
          <input
            type="file"
            multiple
            className="block w-full text-[12px] file:mr-3 file:h-8 file:rounded-md file:border-0 file:bg-foreground file:px-3 file:text-background"
            onChange={(e) => {
              const files = Array.from(e.target.files || [])
              setAssets((prev) => [
                ...files.map((file) => ({ id: makeId("asset"), name: file.name, size: file.size, type: file.type || "file", createdAt: Date.now() })),
                ...prev,
              ])
              e.currentTarget.value = ""
            }}
          />
        </PanelCard>
        <PanelCard title="Assets" detail={`${assets.length} archivos registrados`} icon={<HardDrive className="h-4 w-4" />}>
          <div className="space-y-2">
            {assets.length === 0 ? <p className="rounded-md bg-muted/35 px-3 py-3 text-[12px] text-muted-foreground">Sin assets.</p> : assets.map((asset) => (
              <div key={asset.id} className="flex items-center gap-2 rounded-md border border-border/50 px-3 py-2">
                <FileCode2 className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium">{asset.name}</p>
                  <p className="text-[11px] text-muted-foreground">{Math.ceil(asset.size / 1024)} KB · {asset.type}</p>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setAssets((prev) => prev.filter((row) => row.id !== asset.id))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </PanelCard>
      </PanelGrid>
    </ToolShell>
  )
}

function IntegrationsTool() {
  const [connected, setConnected] = useWorkspacePersistedState<Record<string, boolean>>("integrations", {})
  return (
    <ToolShell eyebrow="Connectors" title="Integraciones" detail="Servicios administrados, conectores, APIs externas y servicios internos del agente.">
      <div className="space-y-4">
        {INTEGRATION_GROUPS.map((group) => (
          <section key={group.id}>
            <div className="mb-2">
              <h3 className="text-[13px] font-semibold text-foreground">{group.label}</h3>
              <p className="text-[12px] leading-5 text-muted-foreground">{group.detail}</p>
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {group.items.map((connector) => (
                <PanelCard
                  key={connector.id}
                  title={connector.label}
                  detail={connector.detail}
                  icon={group.id === "managed" ? <PlugZap className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
                >
                  <div className="flex items-center justify-between">
                    <StatusPill status={connected[connector.id] ? "success" : group.id === "managed" ? "ready" : "idle"} />
                    <Button
                      size="sm"
                      variant={connected[connector.id] || group.id === "managed" ? "outline" : "default"}
                      className="h-8"
                      onClick={() => setConnected((prev) => ({ ...prev, [connector.id]: !prev[connector.id] }))}
                    >
                      {group.id === "managed"
                        ? connected[connector.id] ? "Configurar" : "Activar"
                        : connected[connector.id] ? "Desconectar" : "Conectar"}
                    </Button>
                  </div>
                </PanelCard>
              ))}
            </div>
          </section>
        ))}
      </div>
    </ToolShell>
  )
}

function AuthTool() {
  const [auth, setAuth] = useWorkspacePersistedState("auth", {
    email: true,
    google: false,
    github: false,
    requireVerifiedEmail: true,
    sessionDays: 30,
  })
  return (
    <ToolShell eyebrow="Authentication" title="Auth" detail="Configura proveedores de login y reglas basicas de sesion para la app.">
      <PanelGrid>
        <PanelCard title="Proveedores" detail="Activa login por email, Google o GitHub" icon={<ShieldCheck className="h-4 w-4" />}>
          {(["email", "google", "github"] as const).map((key) => (
            <ToggleRow
              key={key}
              label={key === "email" ? "Email/password" : key === "google" ? "Google OAuth" : "GitHub OAuth"}
              checked={Boolean(auth[key])}
              onChange={() => setAuth((prev) => ({ ...prev, [key]: !prev[key] }))}
            />
          ))}
        </PanelCard>
        <PanelCard title="Politicas" detail="Reglas que el agente puede usar al generar el login" icon={<Lock className="h-4 w-4" />}>
          <ToggleRow
            label="Requerir email verificado"
            checked={auth.requireVerifiedEmail}
            onChange={() => setAuth((prev) => ({ ...prev, requireVerifiedEmail: !prev.requireVerifiedEmail }))}
          />
          <label className="mt-3 block text-[12px] font-medium">
            Duracion de sesion: {auth.sessionDays} dias
            <input
              type="range"
              min={1}
              max={90}
              value={auth.sessionDays}
              onChange={(e) => setAuth((prev) => ({ ...prev, sessionDays: Number(e.target.value) }))}
              className="mt-2 w-full"
            />
          </label>
        </PanelCard>
      </PanelGrid>
    </ToolShell>
  )
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <button type="button" onClick={onChange} className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-[12px] hover:bg-muted/50">
      <span>{label}</span>
      <span className={cn("h-5 w-9 rounded-full p-0.5 transition-colors", checked ? "bg-emerald-500" : "bg-muted-foreground/25")}>
        <span className={cn("block h-4 w-4 rounded-full bg-white transition-transform", checked && "translate-x-4")} />
      </span>
    </button>
  )
}

function SecurityTool() {
  const { files } = useCodeWorkspace()
  const findings = React.useMemo(() => {
    const rows: { path: string; severity: "warn" | "fail"; detail: string }[] = []
    Object.entries(files).forEach(([path, file]) => {
      const content = file.content || ""
      if (/api[_-]?key|secret|token|password/i.test(content)) {
        rows.push({ path, severity: "warn", detail: "Posible credencial o token en el archivo." })
      }
      if (/dangerouslySetInnerHTML|eval\(|new Function/i.test(content)) {
        rows.push({ path, severity: "fail", detail: "Patron de ejecucion/renderizado riesgoso." })
      }
    })
    return rows
  }, [files])
  const securityRows = [
    { label: "Package firewall", detail: "Bloqueo preventivo de paquetes vulnerables", status: "pass" as const },
    { label: "Project Security Center", detail: "Inventario y hallazgos del proyecto actual", status: findings.some((row) => row.severity === "fail") ? "fail" as const : findings.length ? "warn" as const : "pass" as const },
    { label: "Workspace Security Center", detail: "Revision de secretos, auth, datos y exposicion publica", status: findings.length ? "warn" as const : "pass" as const },
  ]
  return (
    <ToolShell eyebrow="Security" title="Security Center" detail="Escaneo rapido del workspace para detectar credenciales o patrones peligrosos.">
      <PanelGrid>
        <PanelCard title="Security tools" detail="Capas que debe revisar el agente antes de publicar" icon={<Shield className="h-4 w-4" />}>
          <div className="space-y-2">
            {securityRows.map((row) => (
              <div key={row.label} className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[12px] font-medium">{row.label}</p>
                  <p className="truncate text-[11px] text-muted-foreground">{row.detail}</p>
                </div>
                <StatusPill status={row.status} />
              </div>
            ))}
          </div>
        </PanelCard>
        <PanelCard title="Resultados" detail={`${findings.length} hallazgos`} icon={<AlertTriangle className="h-4 w-4" />}>
          <div className="space-y-2">
            {findings.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-3 py-3 text-[12px] text-emerald-600">
                <CheckCircle2 className="h-4 w-4" />
                No se detectaron riesgos obvios en los archivos actuales.
              </div>
            ) : findings.map((row, idx) => (
              <div key={`${row.path}-${idx}`} className="flex items-start gap-2 rounded-md border border-border/60 px-3 py-2">
                <StatusPill status={row.severity} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[12px]">{row.path}</p>
                  <p className="text-[12px] text-muted-foreground">{row.detail}</p>
                </div>
                <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1.5">
                  <Wrench className="h-3 w-3" />
                  Fix with Agent
                </Button>
              </div>
            ))}
          </div>
        </PanelCard>
      </PanelGrid>
    </ToolShell>
  )
}

function AnalyticsTool() {
  const { files, activeFolder } = useCodeWorkspace()
  const [deployments] = useWorkspacePersistedState<Deployment[]>("deployments", [])
  const fileCount = Object.keys(files).length
  const jsCount = Object.keys(files).filter((path) => /\.(tsx?|jsx?)$/.test(path)).length
  return (
    <ToolShell eyebrow="Insights" title="Analytics" detail="Resumen operativo local del proyecto y de su actividad de publicacion.">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric title="Workspace" value={activeFolder?.name || "Default"} />
        <Metric title="Archivos" value={String(fileCount)} />
        <Metric title="JS/TS" value={String(jsCount)} />
        <Metric title="Deploys" value={String(deployments.length)} />
      </div>
      <PanelCard className="mt-3" title="Actividad" detail="Eventos sintetizados a partir del estado local" icon={<Activity className="h-4 w-4" />}>
        <div className="space-y-2 text-[12px]">
          <ActivityRow label="Preview" value={fileCount ? "Listo para ejecutar" : "Esperando archivos"} />
          <ActivityRow label="Publicacion" value={deployments[0] ? `Ultimo deploy: ${new Date(deployments[0].createdAt).toLocaleString()}` : "Sin historial"} />
          <ActivityRow label="Codigo" value={`${jsCount} archivos de aplicacion detectados`} />
        </div>
      </PanelCard>
    </ToolShell>
  )
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/80 p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="mt-2 truncate text-xl font-semibold text-foreground">{value}</p>
    </div>
  )
}

function ActivityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-muted/35 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right font-medium">{value}</span>
    </div>
  )
}

function AutomationsTool() {
  const [items, setItems] = useWorkspacePersistedState<{ id: string; label: string; enabled: boolean }[]>("automations", [
    { id: "daily-check", label: "Revisar errores cada dia", enabled: false },
    { id: "deploy-check", label: "Validar antes de publicar", enabled: true },
  ])
  return (
    <ToolShell eyebrow="Automation" title="Automations" detail="Tareas recurrentes del workspace que el agente puede ejecutar o vigilar.">
      <PanelCard title="Reglas" detail="Automatizaciones locales" icon={<Zap className="h-4 w-4" />}>
        {items.map((item) => (
          <ToggleRow
            key={item.id}
            label={item.label}
            checked={item.enabled}
            onChange={() => setItems((prev) => prev.map((row) => row.id === item.id ? { ...row, enabled: !row.enabled } : row))}
          />
        ))}
      </PanelCard>
    </ToolShell>
  )
}

function SkillsTool() {
  const [enabled, setEnabled] = useWorkspacePersistedState<Record<string, boolean>>("skills", {
    planner: true,
    builder: true,
    debugger: true,
    reviewer: false,
  })
  return (
    <ToolShell eyebrow="Agent" title="Agent Skills" detail="Habilidades activas del agente para construir, depurar y revisar el workspace.">
      <div className="grid gap-3 md:grid-cols-2">
        {SKILL_ROWS.map((skill) => (
          <PanelCard key={skill.id} title={skill.label} detail={skill.detail} icon={<Wrench className="h-4 w-4" />}>
            <ToggleRow label="Habilitado" checked={Boolean(enabled[skill.id])} onChange={() => setEnabled((prev) => ({ ...prev, [skill.id]: !prev[skill.id] }))} />
          </PanelCard>
        ))}
      </div>
    </ToolShell>
  )
}

function SettingsToolPanel() {
  const [settings, setSettings] = useWorkspacePersistedState("settings", {
    autosave: true,
    formatOnSave: true,
    previewAutoRefresh: true,
    density: "compact",
  })
  return (
    <ToolShell eyebrow="Workspace" title="User Settings" detail="Preferencias de editor, preview y densidad del workspace.">
      <PanelGrid>
        <PanelCard title="Editor" detail="Preferencias de escritura" icon={<Settings className="h-4 w-4" />}>
          <ToggleRow label="Autosave" checked={settings.autosave} onChange={() => setSettings((prev) => ({ ...prev, autosave: !prev.autosave }))} />
          <ToggleRow label="Format on save" checked={settings.formatOnSave} onChange={() => setSettings((prev) => ({ ...prev, formatOnSave: !prev.formatOnSave }))} />
          <ToggleRow label="Preview auto-refresh" checked={settings.previewAutoRefresh} onChange={() => setSettings((prev) => ({ ...prev, previewAutoRefresh: !prev.previewAutoRefresh }))} />
        </PanelCard>
        <PanelCard title="Apariencia" detail="Densidad de controles" icon={<Activity className="h-4 w-4" />}>
          <select
            value={settings.density}
            onChange={(e) => setSettings((prev) => ({ ...prev, density: e.target.value }))}
            className="h-8 rounded-md border border-input bg-background px-2 text-[12px]"
          >
            <option value="compact">Compacta</option>
            <option value="comfortable">Comoda</option>
            <option value="dense">Densa</option>
          </select>
        </PanelCard>
      </PanelGrid>
    </ToolShell>
  )
}

function ValidationTool() {
  const { files } = useCodeWorkspace()
  const [results, setResults] = React.useState<ValidationResult[]>([])
  const run = () => {
    const paths = Object.keys(files)
    const hasPackage = paths.some((path) => path.endsWith("package.json"))
    const hasEntry = paths.some((path) => /(^|\/)(index|app|main)\.(tsx?|jsx?|html)$/.test(path))
    const hasLargeFile = Object.values(files).some((file) => file.content.length > 120_000)
    setResults([
      { id: "files", label: "Workspace files", detail: `${paths.length} archivos detectados`, status: paths.length ? "pass" : "fail" },
      { id: "entry", label: "Entry point", detail: hasEntry ? "Entrada detectada" : "No se encontro index/app/main", status: hasEntry ? "pass" : "warn" },
      { id: "package", label: "Node project", detail: hasPackage ? "package.json presente" : "Proyecto estatico o sin package.json", status: hasPackage ? "pass" : "warn" },
      { id: "size", label: "Large files", detail: hasLargeFile ? "Hay archivos muy grandes" : "Tamano razonable", status: hasLargeFile ? "warn" : "pass" },
    ])
  }
  return (
    <ToolShell eyebrow="Checks" title="Validation" detail="Ejecuta una validacion local del workspace antes de publicar." action={<Button size="sm" className="h-8 gap-1.5" onClick={run}><Play className="h-3.5 w-3.5" />Ejecutar</Button>}>
      <PanelCard title="Resultados" detail={results.length ? "Ultima ejecucion" : "Sin ejecutar"} icon={<CheckCircle2 className="h-4 w-4" />}>
        <div className="space-y-2">
          {results.length === 0 ? <p className="rounded-md bg-muted/35 px-3 py-3 text-[12px] text-muted-foreground">Pulsa Ejecutar para validar el workspace.</p> : results.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
              <div>
                <p className="text-[12px] font-medium">{row.label}</p>
                <p className="text-[11px] text-muted-foreground">{row.detail}</p>
              </div>
              <StatusPill status={row.status} />
            </div>
          ))}
        </div>
      </PanelCard>
    </ToolShell>
  )
}

function DeveloperTool() {
  const { files, activePath, activeFolder, workspaceSource } = useCodeWorkspace()
  return (
    <ToolShell eyebrow="Diagnostics" title="Developer" detail="Datos tecnicos del workspace actual para depuracion.">
      <PanelGrid>
        <PanelCard title="Workspace" detail="Estado actual" icon={<Wrench className="h-4 w-4" />}>
          <pre className="max-h-80 overflow-auto rounded-md bg-muted/40 p-3 text-[11px] leading-5">
            {JSON.stringify({ activeFolder, workspaceSource, activePath, fileCount: Object.keys(files).length }, null, 2)}
          </pre>
        </PanelCard>
        <PanelCard title="Eventos" detail="Acciones rapidas" icon={<Activity className="h-4 w-4" />}>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="h-8" onClick={() => window.dispatchEvent(new CustomEvent("siragpt:code-open-preview"))}>Abrir preview</Button>
            <Button size="sm" variant="outline" className="h-8" onClick={() => window.dispatchEvent(new CustomEvent("siragpt:code-composer-mode"))}>Composer</Button>
          </div>
        </PanelCard>
      </PanelGrid>
    </ToolShell>
  )
}

function GitTool() {
  const { activeFolder } = useCodeWorkspace()
  return (
    <ToolShell
      eyebrow="Version control"
      title="Git"
      detail="Conecta GitHub y controla versiones reales: commit, push, pull, ramas e historial."
    >
      <RealGitPanel projectId={activeFolder?.id || null} projectName={activeFolder?.name} />
    </ToolShell>
  )
}

function WorkflowsTool() {
  const { files } = useCodeWorkspace()
  const scripts = React.useMemo(() => {
    const pkg = files["package.json"]?.content
    if (!pkg) return []
    try {
      const parsed = JSON.parse(pkg)
      return Object.entries(parsed.scripts || {}).map(([name, command]) => ({ name, command: String(command) }))
    } catch {
      return []
    }
  }, [files])
  const defaults: WorkflowRun[] = (scripts.length ? scripts : [
    { name: "dev", command: "npm run dev" },
    { name: "build", command: "npm run build" },
    { name: "test", command: "npm test" },
  ]).map((row) => ({ id: row.name, name: row.name, command: row.command, status: "idle" }))
  const [runs, setRuns] = useWorkspacePersistedState<WorkflowRun[]>("workflows", defaults)
  const [defaultId, setDefaultId] = useWorkspacePersistedState("workflow-default", defaults[0]?.id || "dev")
  const [, setConsoleRuns] = useWorkspacePersistedState<ConsoleRun[]>("console-runs", [])
  const [draftName, setDraftName] = React.useState("")
  const [draftCommand, setDraftCommand] = React.useState("")

  const run = (row: WorkflowRun) => {
    const consoleId = makeId("console")
    const startedAt = Date.now()
    const pendingRun: ConsoleRun = {
      id: consoleId,
      command: row.command,
      status: "running",
      createdAt: startedAt,
      lines: [
        { stream: "system", text: `Workflow ${row.name} started` },
        { stream: "stdout", text: `$ ${row.command}` },
      ],
    }
    setRuns((prev) => prev.map((item) => item.id === row.id ? { ...item, status: "running", lastRun: startedAt } : item))
    setConsoleRuns((prev) => [pendingRun, ...prev].slice(0, 20))
    window.setTimeout(() => {
      setRuns((prev) => prev.map((item) => item.id === row.id ? { ...item, status: "success", lastRun: Date.now() } : item))
      setConsoleRuns((prev) => prev.map((item) => item.id === consoleId
        ? {
            ...item,
            status: "success",
            endedAt: Date.now(),
            lines: [
              ...item.lines,
              { stream: "stdout", text: "Workspace command completed" },
              { stream: "system", text: "Exit code 0" },
            ],
          }
        : item,
      ))
    }, 900)
  }

  const stop = (id: string) => {
    setRuns((prev) => prev.map((row) => row.id === id ? { ...row, status: "idle", lastRun: Date.now() } : row))
    toast("Workflow detenido")
  }

  const addWorkflow = () => {
    const name = draftName.trim()
    const command = draftCommand.trim()
    if (!name || !command) return
    const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
    setRuns((prev) => [{ id, name, command, status: "idle" }, ...prev.filter((row) => row.id !== id)])
    if (!defaultId) setDefaultId(id)
    setDraftName("")
    setDraftCommand("")
  }

  return (
    <ToolShell eyebrow="Run" title="Workflows" detail="Configura el boton Run, crea comandos reutilizables y envia la salida a Console.">
      <PanelGrid>
        <PanelCard title="Run button" detail="Workflow seleccionado para el boton Run del workspace" icon={<Play className="h-4 w-4" />}>
          <div className="space-y-2">
            <select value={defaultId} onChange={(event) => setDefaultId(event.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-2 text-[12px]">
              {runs.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
            <Button
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => {
                const row = runs.find((item) => item.id === defaultId)
                if (row) run(row)
              }}
              disabled={!runs.length}
            >
              <Play className="h-3.5 w-3.5" />
              Run selected workflow
            </Button>
          </div>
        </PanelCard>
        <PanelCard title="New workflow" detail="Secuencia simple de comandos" icon={<Workflow className="h-4 w-4" />}>
          <div className="space-y-2">
            <Input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="lint" className="h-8 text-[12px]" />
            <Input value={draftCommand} onChange={(event) => setDraftCommand(event.target.value)} placeholder="npm run lint" className="h-8 font-mono text-[12px]" />
            <Button size="sm" className="h-8 gap-1.5" onClick={addWorkflow} disabled={!draftName.trim() || !draftCommand.trim()}>
              <Plus className="h-3.5 w-3.5" />
              Add workflow
            </Button>
          </div>
        </PanelCard>
      </PanelGrid>
      <div className="mt-3 space-y-2">
        {runs.map((row) => (
          <div key={row.id} className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/80 px-3 py-2">
            <Workflow className="h-4 w-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-[12px] font-medium">{row.name}</p>
                {row.id === defaultId ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Run button</span> : null}
              </div>
              <p className="truncate font-mono text-[11px] text-muted-foreground">{row.command}</p>
              <p className="text-[10px] text-muted-foreground">Last run: {formatDateTime(row.lastRun)}</p>
            </div>
            <StatusPill status={row.status} />
            <Button size="sm" variant={row.status === "running" ? "outline" : "default"} className="h-8 w-20 gap-1.5" onClick={() => row.status === "running" ? stop(row.id) : run(row)}>
              {row.status === "running" ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {row.status === "running" ? "Stop" : "Run"}
            </Button>
            <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-rose-600" onClick={() => setRuns((prev) => prev.filter((item) => item.id !== row.id))} aria-label={`Eliminar workflow ${row.name}`}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </ToolShell>
  )
}

function ConsoleTool() {
  const [runs, setRuns] = useWorkspacePersistedState<ConsoleRun[]>("console-runs", [])
  const [latestOnly, setLatestOnly] = React.useState(true)
  const visibleRuns = latestOnly ? runs.slice(0, 1) : runs

  const seedRun = () => {
    const id = makeId("console")
    const demoRun: ConsoleRun = {
      id,
      command: "npm run dev",
      status: "success",
      createdAt: Date.now(),
      endedAt: Date.now(),
      lines: [
        { stream: "system", text: "Development server started" },
        { stream: "stdout", text: "ready - local app available at http://127.0.0.1:3000" },
        { stream: "stdout", text: "compiled successfully" },
      ],
    }
    setRuns((prev) => [demoRun, ...prev].slice(0, 20))
  }

  return (
    <ToolShell
      eyebrow="Runtime output"
      title="Console"
      detail="Logs del app en ejecucion y salidas generadas por Workflows o Publishing."
      action={
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setLatestOnly((prev) => !prev)}>
            <ChevronDown className="h-3.5 w-3.5" />
            {latestOnly ? "All runs" : "Latest"}
          </Button>
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setRuns([])} disabled={!runs.length}>
            <RotateCcw className="h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      }
    >
      <PanelGrid>
        <PanelCard title="Run history" detail={`${runs.length} ejecuciones guardadas`} icon={<History className="h-4 w-4" />}>
          <div className="space-y-2">
            {runs.length === 0 ? (
              <div className="rounded-md bg-muted/35 px-3 py-3">
                <p className="text-[12px] text-muted-foreground">Aun no hay logs. Ejecuta un workflow, publish o crea un log demo.</p>
                <Button size="sm" variant="outline" className="mt-3 h-8 gap-1.5" onClick={seedRun}>
                  <Play className="h-3.5 w-3.5" />
                  Log demo
                </Button>
              </div>
            ) : runs.map((row) => (
              <div key={row.id} className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[12px]">{row.command}</p>
                  <p className="text-[11px] text-muted-foreground">{formatDateTime(row.createdAt)}</p>
                </div>
                <StatusPill status={row.status} />
              </div>
            ))}
          </div>
        </PanelCard>
        <PanelCard title="AI suggestions" detail="Lectura rapida de errores y posibles fixes" icon={<Wrench className="h-4 w-4" />}>
          <div className="space-y-2">
            {runs.some((row) => row.status === "failed" || row.lines.some((line) => line.stream === "stderr")) ? (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700">
                Hay errores en stderr. Abre el run, copia el log y pide al agente aplicar el fix sobre el archivo afectado.
              </div>
            ) : (
              <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-700">
                No hay errores recientes en Console.
              </div>
            )}
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => window.dispatchEvent(new CustomEvent("siragpt:code-composer-mode"))}>
              <Wrench className="h-3.5 w-3.5" />
              Ask Agent to fix
            </Button>
          </div>
        </PanelCard>
      </PanelGrid>
      <PanelCard title="Output" detail={latestOnly ? "Ultima ejecucion" : "Todas las ejecuciones"} icon={<SquareTerminal className="h-4 w-4" />} className="mt-3">
        <div className="max-h-[440px] overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-[12px] leading-5 text-zinc-100">
          {visibleRuns.length === 0 ? (
            <p className="text-zinc-400">No console output yet.</p>
          ) : visibleRuns.map((row) => (
            <div key={row.id} className="mb-4 last:mb-0">
              <div className="mb-1 text-zinc-400">$ {row.command}</div>
              {row.lines.map((line, idx) => (
                <div
                  key={`${row.id}:${idx}`}
                  className={cn(
                    line.stream === "stderr" && "text-rose-300",
                    line.stream === "system" && "text-sky-300",
                    line.stream === "stdout" && "text-zinc-100",
                  )}
                >
                  {line.text}
                </div>
              ))}
            </div>
          ))}
        </div>
      </PanelCard>
    </ToolShell>
  )
}

function VncTool() {
  const [url, setUrl] = useWorkspacePersistedState("vnc-url", "")
  return (
    <ToolShell eyebrow="Remote display" title="VNC" detail="Conecta una pantalla remota o preview externo por URL segura.">
      <PanelCard title="Conexion" detail="Pega una URL de viewer o noVNC" icon={<Server className="h-4 w-4" />}>
        <div className="flex gap-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." className="h-8 text-[12px]" />
          <Button size="sm" className="h-8" disabled={!url} onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>Abrir</Button>
        </div>
        {url ? <iframe title="VNC preview" src={url} className="mt-3 h-80 w-full rounded-md border border-border/60 bg-muted" /> : null}
      </PanelCard>
    </ToolShell>
  )
}

function CanvasTool() {
  const [notes, setNotes] = useWorkspacePersistedState("canvas", "Flujo principal:\n- Usuario describe una app\n- Agente genera archivos\n- Preview muestra el resultado\n- Se publica cuando pasa validacion")
  return (
    <ToolShell eyebrow="Design" title="Canvas" detail="Lienzo simple para planear pantallas y flujos mientras el agente trabaja.">
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="h-[520px] w-full resize-none rounded-lg border border-border/60 bg-card p-4 font-mono text-[13px] leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      />
    </ToolShell>
  )
}

function GenericTool({ toolId }: { toolId: WorkspaceToolId }) {
  return (
    <ToolShell eyebrow="Tool" title={toolId} detail="Herramienta del workspace.">
      <PanelCard title="Disponible" detail="Abre esta herramienta desde el catalogo principal." />
    </ToolShell>
  )
}
