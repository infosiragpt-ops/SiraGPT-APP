"use client"

import * as React from "react"
import {
  Activity,
  AlertTriangle,
  Box,
  ChevronDown,
  Check,
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
  FolderOpen,
  GitBranch,
  GitCommit,
  Globe2,
  HardDrive,
  HelpCircle,
  History,
  KeyRound,
  LineChart,
  Link2,
  ListChecks,
  Lock,
  MoreVertical,
  Play,
  PlugZap,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  Rocket,
  Search,
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
  X,
  Zap,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { CODE_OPEN_TOOL_EVENT, CODE_RUNNER_ACTIVE_EVENT, getActiveHostRunId, useCodeWorkspace } from "@/lib/code-workspace-context"
import { hostRunnerService } from "@/lib/code-runner/host-runner-service"
import { githubService, type GithubStatus } from "@/lib/github-service"
import { ALL_TOOLS, type WorkspaceToolId } from "@/lib/code-workspace-tools"
import {
  detectDotenvSecrets,
  detectEnvKeyHints,
  mergeSecretEntries,
  normalizeEnvKey,
  parseDotenvText,
  type CodeSecretEntry,
} from "@/lib/code-secrets"
import { detectWorkspaceSchema, fieldLabel } from "@/lib/code-agent/workspace-schema"
import { RealGitPanel } from "@/components/code/git-tool-real"
import { WorkspaceDeploymentsTool } from "@/components/deployments/workspace-deployments-tool"
import { RealPublishingPanel } from "@/components/code/publishing-tool-real"
import { hostingService } from "@/lib/hosting-service"
import { deploymentsApi, type Deployment as RealDeployment } from "@/lib/deployments/deployments-api"
import { getGitBinding } from "@/lib/code-git-mirror"

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

type SecretEntry = CodeSecretEntry

type DbColType = "TEXT" | "INTEGER" | "FLOAT" | "BOOLEAN" | "TIMESTAMP" | "JSON"
type DbTable = {
  name: string
  columns: string[]
  columnTypes?: Record<string, DbColType>
  rows: Record<string, string>[]
}
const DB_COL_TYPES: DbColType[] = ["TEXT", "INTEGER", "FLOAT", "BOOLEAN", "TIMESTAMP", "JSON"]
const DB_TYPE_COLORS: Record<string, string> = {
  TEXT: "bg-sky-500/10 text-sky-600",
  INTEGER: "bg-violet-500/10 text-violet-600",
  FLOAT: "bg-indigo-500/10 text-indigo-600",
  BOOLEAN: "bg-amber-500/10 text-amber-600",
  TIMESTAMP: "bg-emerald-500/10 text-emerald-600",
  JSON: "bg-rose-500/10 text-rose-600",
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

const TOOL_RUNTIME_NOTES: Record<WorkspaceToolId, string> = {
  agent: "Enfoca el chat del agente y conserva el contexto del workspace.",
  preview: "Renderiza la app actual y puede arrancar proyectos con dev server.",
  shell: "Terminal integrada con comandos sobre los archivos del workspace.",
  console: "Historial de ejecuciones, logs y envio de errores al agente.",
  files: "Explorador de archivos con busqueda, apertura y eliminacion.",
  "new-file": "Crea archivos nuevos desde el launcher o el menu.",
  "code-search": "Busca texto y rutas dentro del contenido del workspace.",
  publishing: "Abre Deployments reales del proyecto, con fallback local.",
  integrations: "Gestiona conectores nativos, APIs y servicios del agente.",
  database: "Tablas locales, SQL basico y preview de datos estructurados.",
  storage: "Carga assets, enlaza carpeta local y mantiene lista de objetos.",
  auth: "Configura proveedores y reglas basicas de sesion.",
  security: "Escanea secretos, APIs peligrosas y permite pedir fix al agente.",
  secrets: "Gestiona variables de entorno, .env y envio seguro a deploy.",
  skills: "Activa habilidades del agente por workspace.",
  analytics: "Resume archivos, despliegues y actividad local.",
  automations: "Activa reglas recurrentes para revision y despliegue.",
  canvas: "Lienzo textual persistente para flujos y pantallas.",
  settings: "Preferencias de editor, preview y densidad.",
  validation: "Checks locales sobre entrada, package.json, tamano y archivos.",
  developer: "Diagnostico tecnico y eventos internos del workspace.",
  git: "Panel GitHub real para cargar, comparar y versionar archivos.",
  vnc: "Viewer remoto por URL segura o noVNC.",
  workflows: "Comandos reutilizables conectados a Console y Preview.",
}

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
  className,
  headerClassName,
  bodyClassName,
}: {
  eyebrow: string
  title: string
  detail: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  headerClassName?: string
  bodyClassName?: string
}) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      <div className={cn("shrink-0 border-b border-border/50 px-5 py-4", headerClassName)}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
            <h2 className="mt-1 text-[18px] font-semibold tracking-tight text-foreground">{title}</h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted-foreground">{detail}</p>
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      </div>
      <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", bodyClassName)}>{children}</div>
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
      className="bg-[#1f1f1f] text-white"
      headerClassName="border-[#353535] bg-[#1f1f1f] [&_p]:text-[#a8b0bf] [&_h2]:text-white"
      bodyClassName="bg-[#1f1f1f] px-0 py-0"
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

const DEFAULT_SECRETS: SecretEntry[] = []
const LEGACY_DEMO_SECRET_KEYS = new Set([
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "SLACK_ENCRYPTION_KEY",
  "ANON_TOKEN_SECRET",
  "ANTHROPIC_API_KEY",
  "BACKEND_BASE_URL",
  "BASE_URL",
  "CEREBRAS_API_KEY",
  "CORS_ORIGINS",
  "DEEPSEEK_API_KEY",
  "DEFAULT_OBJECT_STORAGE_BUCKET_ID",
  "ENCRYPTION_KEY",
  "FAL_API_KEY",
  "FIGMA_CLIENT_ID",
  "FROM_EMAIL",
  "FRONTEND_URL",
  "GEMINI_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_SECRET_KEY_ALT",
  "STRIPE_WEBHOOK_SECRET",
  "UPLOAD_DIR",
  "VOYAGE_API_KEY",
  "WOS_API_KEY",
  "XAI_API_KEY",
])
const LEGACY_DEMO_SECRET_VALUES = new Set([
  "",
  "some-secret-token",
  "sk-ant-...",
  "http://localhost:3001",
  "http://localhost:3000",
  "cr-...",
  "*",
  "ds-...",
  "sira-bucket",
  "some-enc-key",
  "fal-...",
  "figma-client",
  "no-reply@siragpt.com",
  "ai-...",
  "sk_test_...",
  "whsec_...",
  "/tmp/uploads",
  "vy-...",
  "wos-...",
  "xai-...",
])

type ConfigurationEntry = {
  id: string
  key: string
  value: string
  testingValue?: string
  type: "link" | "sync" | "globe"
  updatedAt: number
}

const DEFAULT_CONFIGURATIONS: ConfigurationEntry[] = []
const LEGACY_DEMO_CONFIG_KEYS = new Set([
  "CODE_HOST_RUNNER",
  "CODE_HOST_RUNNER_ALLOWED_USER_IDS",
  "GOOGLE_AUTH_BASE_URL",
  "R2_ENDPOINT",
  "SIRAGPT_MEMORY_EMBED_PROVIDER",
  "SIRAGPT_USER_MEMORY_STORE",
  "GOOGLE_ALLOW_FRONTEND_CALLBACK",
  "SEED_ADMIN_EMAIL",
  "SEED_ADMIN_PASSWORD",
])

function SecretsTool() {
  const { activeFolder, files } = useCodeWorkspace()
  const connectionId = activeFolder?.id ? getGitBinding(activeFolder.id) : null
  const [secrets, setSecrets] = useWorkspacePersistedState<SecretEntry[]>("secrets", DEFAULT_SECRETS)
  const [configurations, setConfigurations] = useWorkspacePersistedState<ConfigurationEntry[]>("configurations", DEFAULT_CONFIGURATIONS)

  const [filterText, setFilterText] = React.useState("")
  const [revealed, setRevealed] = React.useState<Set<string>>(new Set())
  const [deployKeys, setDeployKeys] = React.useState<string[]>([])
  const [savingDeploy, setSavingDeploy] = React.useState(false)
  const envLoadedRef = React.useRef(false)

  // Modals state
  const [showAddSecret, setShowAddSecret] = React.useState(false)
  const [showAddConfig, setShowAddConfig] = React.useState(false)
  const [showBulkImport, setShowBulkImport] = React.useState(false)
  const [showBulkImportConfig, setShowBulkImportConfig] = React.useState(false)

  // New Secret form state
  const [newSecretKey, setNewSecretKey] = React.useState("")
  const [newSecretValue, setNewSecretValue] = React.useState("")
  const [newSecretScope, setNewSecretScope] = React.useState<"app" | "account">("app")

  // New Config form state
  const [newConfigKey, setNewConfigKey] = React.useState("")
  const [newConfigValue, setNewConfigValue] = React.useState("")
  const [newConfigTestingValue, setNewConfigTestingValue] = React.useState("")
  const [newConfigType, setNewConfigType] = React.useState<"link" | "sync" | "globe">("link")

  // Bulk import state
  const [bulkText, setBulkText] = React.useState("")

  // Dropdown menu state
  const [showSecretsMore, setShowSecretsMore] = React.useState(false)
  const [showConfigsMore, setShowConfigsMore] = React.useState(false)
  const [activeMenu, setActiveMenu] = React.useState<{ type: "secret" | "config"; id: string } | null>(null)

  React.useEffect(() => {
    if (!connectionId) return setDeployKeys([])
    hostingService.getEnv(connectionId).then(({ keys }) => setDeployKeys(keys)).catch(() => setDeployKeys([]))
  }, [connectionId])

  React.useEffect(() => {
    setSecrets((prev) => {
      const next = prev.filter((s) => {
        const key = normalizeEnvKey(s.key)
        return !(LEGACY_DEMO_SECRET_KEYS.has(key) && LEGACY_DEMO_SECRET_VALUES.has(String(s.value || "")))
      })
      return next.length === prev.length ? prev : next
    })
    setConfigurations((prev) => {
      const next = prev.filter((c) => !LEGACY_DEMO_CONFIG_KEYS.has(normalizeEnvKey(c.key)))
      return next.length === prev.length ? prev : next
    })
  }, [setConfigurations, setSecrets])

  const envHints = React.useMemo(() => detectEnvKeyHints(files), [files])
  const envFileSecrets = React.useMemo(() => detectDotenvSecrets(files), [files])
  const envDetectionSignature = React.useMemo(
    () => [
      activeFolder?.id || "default",
      envHints.map((h) => `${h.key}:${h.source}:${h.hasValue ? "1" : "0"}`).join("|"),
      envFileSecrets.map((s) => `${s.key}:${s.value.length}:${s.path}`).join("|"),
    ].join("::"),
    [activeFolder?.id, envFileSecrets, envHints],
  )

  React.useEffect(() => {
    const detected = [
      ...envHints.map((h) => ({ key: h.key, source: h.source === "env-file" ? "env-file" as const : "detected" as const })),
      ...envFileSecrets.map((s) => ({ key: s.key, value: s.value, source: "env-file" as const })),
    ]
    if (!detected.length) return
    setSecrets((prev) => {
      const next = mergeSecretEntries(prev, detected)
      const before = prev.map((s) => `${s.key}:${s.value}:${s.source || ""}`).sort().join("|")
      const after = next.map((s) => `${s.key}:${s.value}:${s.source || ""}`).sort().join("|")
      return before === after ? prev : next
    })
  }, [envDetectionSignature, envFileSecrets, envHints, setSecrets])

  const copyToClipboard = (text: string, msg: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => toast.success(msg),
      () => toast.error("No se pudo copiar al portapapeles.")
    )
  }

  const handleAddSecret = () => {
    const keyName = normalizeEnvKey(newSecretKey)
    if (!keyName) return
    setSecrets((prev) => [
      { id: makeId("secret"), key: keyName, value: newSecretValue, scope: newSecretScope, updatedAt: Date.now() },
      ...prev.filter((r) => !(r.key === keyName && r.scope === newSecretScope)),
    ])
    setNewSecretKey("")
    setNewSecretValue("")
    setShowAddSecret(false)
    toast.success("Secret guardado")
  }

  const handleAddConfig = () => {
    const keyName = newConfigKey.trim().toUpperCase()
    if (!keyName) return
    setConfigurations((prev) => [
      {
        id: makeId("config"),
        key: keyName,
        value: newConfigValue,
        testingValue: newConfigTestingValue || undefined,
        type: newConfigType,
        updatedAt: Date.now(),
      },
      ...prev.filter((r) => r.key !== keyName),
    ])
    setNewConfigKey("")
    setNewConfigValue("")
    setNewConfigTestingValue("")
    setShowAddConfig(false)
    toast.success("Configuración guardada")
  }

  const handleBulkImportSecrets = () => {
    const parsed = parseDotenvText(bulkText)
    if (parsed.length === 0) return toast.error("No se encontraron claves válidas.")
    setSecrets((prev) => mergeSecretEntries(prev, parsed.map((p) => ({ ...p, source: "env-file" })), { overwrite: true }))
    setBulkText("")
    setShowBulkImport(false)
    toast.success(`${parsed.length} secret(s) importados`)
  }

  const handleImportWorkspaceEnv = () => {
    const detected = [
      ...envHints.map((h) => ({ key: h.key, source: h.source === "env-file" ? "env-file" as const : "detected" as const })),
      ...envFileSecrets.map((s) => ({ key: s.key, value: s.value, source: "env-file" as const })),
    ]
    if (!detected.length) return toast.info("No encontré .env, .env.example ni referencias process.env/import.meta.env en este workspace.")
    setSecrets((prev) => mergeSecretEntries(prev, detected, { overwrite: true }))
    const withValues = envFileSecrets.length
    const missing = envHints.filter((h) => !envFileSecrets.some((s) => s.key === h.key)).length
    toast.success(`Entorno detectado: ${withValues} valor(es) importados, ${missing} clave(s) pendiente(s).`)
  }

  const handleBulkImportConfigs = () => {
    try {
      const parsed = JSON.parse(bulkText)
      if (typeof parsed !== "object" || parsed === null) throw new Error()
      setConfigurations((prev) => {
        const next = [...prev]
        for (const [key, value] of Object.entries(parsed)) {
          const k = key.toUpperCase()
          const valStr = String(value)
          const idx = next.findIndex((r) => r.key === k)
          if (idx >= 0) {
            next[idx] = { ...next[idx], value: valStr, updatedAt: Date.now() }
          } else {
            next.unshift({ id: makeId("config"), key: k, value: valStr, type: "link", updatedAt: Date.now() })
          }
        }
        return next
      })
      setBulkText("")
      setShowBulkImportConfig(false)
      toast.success("Configuraciones importadas")
    } catch {
      toast.error("Formato JSON inválido.")
    }
  }

  const saveToDeploy = async () => {
    if (!connectionId) return toast.error("Conecta un repo en Git primero.")
    setSavingDeploy(true)
    const env: Record<string, string> = {}
    for (const s of secrets) {
      if (s.value) env[s.key] = s.value
    }
    try {
      const { keys } = await hostingService.setEnv(connectionId, env)
      setDeployKeys(keys)
      toast.success(`${keys.length} secrets guardados para el deploy`)
    } catch (e) {
      toast.error((e as Error).message || "Error al sincronizar deploy")
    } finally {
      setSavingDeploy(false)
    }
  }

  const toggleRevealSecret = (id: string) => {
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const updateSecretValue = (id: string, val: string) => {
    setSecrets((prev) => prev.map((s) => (s.id === id ? { ...s, value: val, updatedAt: Date.now() } : s)))
  }

  const updateConfigValue = (id: string, val: string) => {
    setConfigurations((prev) => prev.map((c) => (c.id === id ? { ...c, value: val, updatedAt: Date.now() } : c)))
  }

  const updateConfigTestingValue = (id: string, val: string) => {
    setConfigurations((prev) => prev.map((c) => (c.id === id ? { ...c, testingValue: val, updatedAt: Date.now() } : c)))
  }

  const deleteSecret = (id: string) => {
    setSecrets((prev) => prev.filter((s) => s.id !== id))
    toast.success("Secret eliminado")
  }

  const deleteConfig = (id: string) => {
    setConfigurations((prev) => prev.filter((c) => c.id !== id))
    toast.success("Configuración eliminada")
  }

  const toggleSecretScope = (id: string) => {
    setSecrets((prev) =>
      prev.map((s) => (s.id === id ? { ...s, scope: s.scope === "app" ? "account" : "app", updatedAt: Date.now() } : s))
    )
    toast.success("Ámbito de secret actualizado")
  }

  const envText = secrets.map((s) => `${s.key}=${s.value}`).join("\n")
  const jsonText = JSON.stringify(
    Object.fromEntries(secrets.map((s) => [s.key, s.value])),
    null,
    2
  )

  const filteredSecrets = secrets.filter((s) => s.key.toLowerCase().includes(filterText.toLowerCase()))
  const filteredConfigs = configurations.filter((c) => c.key.toLowerCase().includes(filterText.toLowerCase()))

  const missingSecrets = filteredSecrets.filter((s) => !s.value)
  const existingSecrets = filteredSecrets.filter((s) => s.value)

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f5f5f7] dark:bg-zinc-950">
      {/* Header */}
      <div className="shrink-0 border-b border-border/40 bg-background/95 backdrop-blur px-6 py-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[20px] font-bold tracking-tight text-foreground">Secrets</h2>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Button size="sm" variant="outline" className="h-8 text-[12px]" onClick={() => setShowSecretsMore(!showSecretsMore)}>
                More
              </Button>
              {showSecretsMore && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSecretsMore(false)} />
                  <div className="absolute right-0 mt-2 w-48 rounded-lg border border-border bg-popover p-1 shadow-md z-50 text-[12px]">
                    <button
                      onClick={() => {
                        setShowSecretsMore(false)
                        setBulkText("")
                        setShowBulkImport(true)
                      }}
                      className="flex w-full items-center px-2.5 py-2 hover:bg-muted rounded-md text-left"
                    >
                      Import .env
                    </button>
                    <button
                      onClick={() => {
                        setShowSecretsMore(false)
                        copyToClipboard(envText, ".env copiado")
                      }}
                      className="flex w-full items-center px-2.5 py-2 hover:bg-muted rounded-md text-left"
                    >
                      Copy .env Text
                    </button>
                    <button
                      onClick={() => {
                        setShowSecretsMore(false)
                        copyToClipboard(jsonText, "JSON copiado")
                      }}
                      className="flex w-full items-center px-2.5 py-2 hover:bg-muted rounded-md text-left"
                    >
                      Copy as JSON
                    </button>
                    {connectionId && (
                      <button
                        onClick={() => {
                          setShowSecretsMore(false)
                          void saveToDeploy()
                        }}
                        disabled={savingDeploy}
                        className="flex w-full items-center px-2.5 py-2 hover:bg-muted rounded-md text-left font-medium text-blue-600 dark:text-blue-400"
                      >
                        {savingDeploy ? "Syncing..." : "Save to Deploy"}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[12px]" onClick={() => copyToClipboard(envText, "Secrets linkeados")}>
              <Link2 className="h-3.5 w-3.5" />
              Link Account Secrets
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[12px]" onClick={handleImportWorkspaceEnv}>
              <Search className="h-3.5 w-3.5" />
              Detect .env
            </Button>
            <Button size="sm" className="h-8 gap-1 bg-blue-600 hover:bg-blue-500 text-white text-[12px] font-medium" onClick={() => setShowAddSecret(true)}>
              <Plus className="h-3.5 w-3.5" />
              New Secret
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-6">
        {/* Search */}
        <div className="relative">
          <Input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Filter Secrets by name"
            className="h-10 pl-3 pr-10 text-[13px] bg-background border border-border/50 rounded-lg shadow-sm"
          />
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        </div>

        <div className="rounded-xl border border-blue-500/15 bg-blue-500/5 p-4 text-[12px] text-muted-foreground">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="font-semibold text-foreground">Entorno del proyecto</p>
              <p className="mt-1 leading-relaxed">
                SiraGPT detecta variables desde `.env`, `.env.example` y referencias de código. Si el proyecto fue clonado,
                los valores existentes se importan al panel; las claves sin valor quedan pendientes para que el usuario las complete.
              </p>
              {envHints.length > 0 ? (
                <p className="mt-2">
                  Detectadas: <span className="font-mono text-foreground">{envHints.length}</span> clave(s)
                  {envFileSecrets.length > 0 ? <> · <span className="font-mono text-foreground">{envFileSecrets.length}</span> con valor desde `.env`</> : null}
                </p>
              ) : (
                <p className="mt-2">Este workspace no declara variables todavía. Un proyecto nuevo desde cero empieza vacío.</p>
              )}
            </div>
            <Button size="sm" variant="outline" className="h-8 shrink-0 text-[12px]" onClick={handleImportWorkspaceEnv}>
              Detectar ahora
            </Button>
          </div>
        </div>

        {/* Missing Secrets */}
        {missingSecrets.length > 0 && (
          <div className="space-y-3">
            <div>
              <h3 className="text-[14px] font-bold text-foreground">Configure missing Secret values</h3>
              <p className="text-[12px] text-muted-foreground">
                This App contains Secrets that might be required. Add values to ensure the code runs as expected.
              </p>
            </div>
            <div className="space-y-2">
              {missingSecrets.map((secret) => (
                <SecretRow
                  key={secret.id}
                  secret={secret}
                  revealed={revealed.has(secret.id)}
                  onToggleReveal={() => toggleRevealSecret(secret.id)}
                  onValueChange={(val) => updateSecretValue(secret.id, val)}
                  onCopyKey={() => copyToClipboard(secret.key, "Key copiado")}
                  onCopyVal={() => copyToClipboard(secret.value, "Valor copiado")}
                  onDelete={() => deleteSecret(secret.id)}
                  onToggleScope={() => toggleSecretScope(secret.id)}
                  activeMenu={activeMenu}
                  setActiveMenu={setActiveMenu}
                />
              ))}
            </div>
          </div>
        )}

        {/* Existing Secrets */}
        {existingSecrets.length > 0 && (
          <div className="space-y-2">
            {missingSecrets.length > 0 && <div className="border-t border-border/40 my-4" />}
            {existingSecrets.map((secret) => (
              <SecretRow
                key={secret.id}
                secret={secret}
                revealed={revealed.has(secret.id)}
                onToggleReveal={() => toggleRevealSecret(secret.id)}
                onValueChange={(val) => updateSecretValue(secret.id, val)}
                onCopyKey={() => copyToClipboard(secret.key, "Key copiado")}
                onCopyVal={() => copyToClipboard(secret.value, "Valor copiado")}
                onDelete={() => deleteSecret(secret.id)}
                onToggleScope={() => toggleSecretScope(secret.id)}
                activeMenu={activeMenu}
                setActiveMenu={setActiveMenu}
              />
            ))}
          </div>
        )}

        {filteredSecrets.length === 0 && (
          <div className="rounded-xl border border-dashed border-border/70 bg-background/70 p-8 text-center">
            <KeyRound className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <h3 className="mt-3 text-[14px] font-semibold text-foreground">Sin secrets todavía</h3>
            <p className="mx-auto mt-1 max-w-md text-[12px] leading-relaxed text-muted-foreground">
              Cuando el agente clone o genere un proyecto, aparecerán aquí las variables necesarias. También puedes importar un `.env`
              o crear una clave manualmente.
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <Button size="sm" variant="outline" className="h-8 text-[12px]" onClick={handleImportWorkspaceEnv}>
                Detectar entorno
              </Button>
              <Button size="sm" className="h-8 bg-blue-600 text-[12px] text-white hover:bg-blue-500" onClick={() => setShowAddSecret(true)}>
                New Secret
              </Button>
            </div>
          </div>
        )}

        {/* Configurations Section */}
        <div className="border-t border-border/40 pt-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[16px] font-bold text-foreground">Configurations</h3>
              <p className="text-[12px] text-muted-foreground mt-0.5 max-w-2xl leading-relaxed">
                Configurations are similar to secrets, but should only be used for non-sensitive information. They're useful for having a variable that's different between your published app and when testing on Replit.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="relative">
                <Button size="sm" variant="outline" className="h-8 text-[12px]" onClick={() => setShowConfigsMore(!showConfigsMore)}>
                  More
                </Button>
                {showConfigsMore && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowConfigsMore(false)} />
                    <div className="absolute right-0 mt-2 w-48 rounded-lg border border-border bg-popover p-1 shadow-md z-50 text-[12px]">
                      <button
                        onClick={() => {
                          setShowConfigsMore(false)
                          copyToClipboard(JSON.stringify(configurations, null, 2), "Configuraciones copiadas")
                        }}
                        className="flex w-full items-center px-2.5 py-2 hover:bg-muted rounded-md text-left"
                      >
                        Export JSON
                      </button>
                      <button
                        onClick={() => {
                          setShowConfigsMore(false)
                          setBulkText("")
                          setShowBulkImportConfig(true)
                        }}
                        className="flex w-full items-center px-2.5 py-2 hover:bg-muted rounded-md text-left"
                      >
                        Import JSON
                      </button>
                    </div>
                  </>
                )}
              </div>
              <Button size="sm" className="h-8 gap-1 bg-blue-600 hover:bg-blue-500 text-white text-[12px] font-medium" onClick={() => setShowAddConfig(true)}>
                <Plus className="h-3.5 w-3.5" />
                New configuration
              </Button>
            </div>
          </div>

          <div className="space-y-2.5">
            {filteredConfigs.map((config) => (
              <ConfigRow
                key={config.id}
                config={config}
                onValueChange={(val) => updateConfigValue(config.id, val)}
                onTestingValueChange={(val) => updateConfigTestingValue(config.id, val)}
                onCopyKey={() => copyToClipboard(config.key, "Key copiado")}
                onCopyVal={() => copyToClipboard(config.value, "Valor copiado")}
                onDelete={() => deleteConfig(config.id)}
                activeMenu={activeMenu}
                setActiveMenu={setActiveMenu}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Add Secret Modal */}
      {showAddSecret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="relative w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-2xl space-y-4">
            <button onClick={() => setShowAddSecret(false)} className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 transition-opacity">
              <X className="h-4 w-4" />
            </button>
            <h3 className="text-[16px] font-bold text-foreground">Create New Secret</h3>
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-foreground">Secret Name</label>
                <Input value={newSecretKey} onChange={(e) => setNewSecretKey(e.target.value)} placeholder="e.g. STRIPE_API_KEY" className="h-9 text-[12px]" />
              </div>
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-foreground">Secret Value</label>
                <Input value={newSecretValue} onChange={(e) => setNewSecretValue(e.target.value)} placeholder="Value" type="password" className="h-9 text-[12px]" />
              </div>
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-foreground">Scope</label>
                <select
                  value={newSecretScope}
                  onChange={(e) => setNewSecretScope(e.target.value as "app" | "account")}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-[12px]"
                >
                  <option value="app">App Secret</option>
                  <option value="account">Account Secret</option>
                </select>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" className="h-9 px-4 text-[12px]" onClick={() => setShowAddSecret(false)}>
                Cancel
              </Button>
              <Button size="sm" className="h-9 px-4 bg-blue-600 hover:bg-blue-500 text-white text-[12px] font-medium" onClick={handleAddSecret} disabled={!newSecretKey.trim()}>
                Create Secret
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Config Modal */}
      {showAddConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="relative w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-2xl space-y-4">
            <button onClick={() => setShowAddConfig(false)} className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 transition-opacity">
              <X className="h-4 w-4" />
            </button>
            <h3 className="text-[16px] font-bold text-foreground">Create New Configuration</h3>
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-foreground">Config Name</label>
                <Input value={newConfigKey} onChange={(e) => setNewConfigKey(e.target.value)} placeholder="e.g. APP_COLOR" className="h-9 text-[12px]" />
              </div>
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-foreground">Value</label>
                <Input value={newConfigValue} onChange={(e) => setNewConfigValue(e.target.value)} placeholder="e.g. blue" className="h-9 text-[12px]" />
              </div>
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-foreground">Testing Value (Optional)</label>
                <Input value={newConfigTestingValue} onChange={(e) => setNewConfigTestingValue(e.target.value)} placeholder="Testing override" className="h-9 text-[12px]" />
              </div>
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-foreground">Type</label>
                <select
                  value={newConfigType}
                  onChange={(e) => setNewConfigType(e.target.value as "link" | "sync" | "globe")}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-[12px]"
                >
                  <option value="link">Link</option>
                  <option value="sync">Sync / Testing</option>
                  <option value="globe">Globe / Public</option>
                </select>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" className="h-9 px-4 text-[12px]" onClick={() => setShowAddConfig(false)}>
                Cancel
              </Button>
              <Button size="sm" className="h-9 px-4 bg-blue-600 hover:bg-blue-500 text-white text-[12px] font-medium" onClick={handleAddConfig} disabled={!newConfigKey.trim()}>
                Create Configuration
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Import Secrets Modal */}
      {showBulkImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="relative w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-2xl space-y-4">
            <button onClick={() => setShowBulkImport(false)} className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 transition-opacity">
              <X className="h-4 w-4" />
            </button>
            <h3 className="text-[16px] font-bold text-foreground">Import .env File Content</h3>
            <p className="text-[12px] text-muted-foreground">
              Paste raw env declarations in key=value lines. Existing keys will be overwritten.
            </p>
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              rows={6}
              spellCheck={false}
              placeholder="API_KEY=my_val&#10;PORT=3000"
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" className="h-9 px-4 text-[12px]" onClick={() => setShowBulkImport(false)}>
                Cancel
              </Button>
              <Button size="sm" className="h-9 px-4 bg-blue-600 hover:bg-blue-500 text-white text-[12px] font-medium" onClick={handleBulkImportSecrets} disabled={!bulkText.trim()}>
                Import Secrets
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Import Configs Modal */}
      {showBulkImportConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="relative w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-2xl space-y-4">
            <button onClick={() => setShowBulkImportConfig(false)} className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 transition-opacity">
              <X className="h-4 w-4" />
            </button>
            <h3 className="text-[16px] font-bold text-foreground">Import Configurations JSON</h3>
            <p className="text-[12px] text-muted-foreground">
              Paste a flat JSON object key-value mapping to import configurations.
            </p>
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              rows={6}
              spellCheck={false}
              placeholder='{ "CODE_HOST_RUNNER": "1" }'
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" className="h-9 px-4 text-[12px]" onClick={() => setShowBulkImportConfig(false)}>
                Cancel
              </Button>
              <Button size="sm" className="h-9 px-4 bg-blue-600 hover:bg-blue-500 text-white text-[12px] font-medium" onClick={handleBulkImportConfigs} disabled={!bulkText.trim()}>
                Import JSON
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SecretRow({
  secret,
  revealed,
  onToggleReveal,
  onValueChange,
  onCopyKey,
  onCopyVal,
  onDelete,
  onToggleScope,
  activeMenu,
  setActiveMenu,
}: {
  secret: SecretEntry
  revealed: boolean
  onToggleReveal: () => void
  onValueChange: (val: string) => void
  onCopyKey: () => void
  onCopyVal: () => void
  onDelete: () => void
  onToggleScope: () => void
  activeMenu: { type: "secret" | "config"; id: string } | null
  setActiveMenu: (val: { type: "secret" | "config"; id: string } | null) => void
}) {
  const isMenuOpen = activeMenu?.type === "secret" && activeMenu.id === secret.id

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
      {/* Left Key Card */}
      <div className="flex h-10 items-center gap-2.5 rounded-lg border border-border/40 bg-zinc-200/50 dark:bg-zinc-800/40 px-3 py-2 text-[12px] font-mono font-semibold text-zinc-800 dark:text-zinc-200 shadow-sm">
        <button onClick={onCopyKey} className="text-muted-foreground hover:text-foreground transition-colors" title="Copy name">
          <Copy className="h-3.5 w-3.5" />
        </button>
        <span className="truncate flex-1">{secret.key}</span>
      </div>

      {/* Right Value Card */}
      <div className="flex h-10 items-center gap-2 rounded-lg border border-border/40 bg-zinc-200/50 dark:bg-zinc-800/40 px-3 py-2 shadow-sm relative">
        <button onClick={onCopyVal} className="text-muted-foreground hover:text-foreground transition-colors" title="Copy value">
          <Copy className="h-3.5 w-3.5" />
        </button>
        <input
          type={revealed ? "text" : "password"}
          value={secret.value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder="Enter your secret value"
          className="flex-1 bg-transparent border-none outline-none font-mono text-[12px] text-zinc-900 dark:text-zinc-100 placeholder:text-muted-foreground/75"
        />
        <button onClick={onToggleReveal} className="text-muted-foreground hover:text-foreground transition-colors" title={revealed ? "Hide" : "Show"}>
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>

        {/* Options Ellipsis */}
        <div className="relative">
          <button onClick={() => setActiveMenu(isMenuOpen ? null : { type: "secret", id: secret.id })} className="text-muted-foreground hover:text-foreground transition-colors">
            <MoreVertical className="h-4 w-4" />
          </button>
          {isMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setActiveMenu(null)} />
              <div className="absolute right-0 mt-2 w-36 rounded-md border border-border bg-popover p-1 shadow-md z-50 text-[11px]">
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    onToggleScope()
                  }}
                  className="flex w-full items-center px-2 py-1.5 hover:bg-muted rounded text-left"
                >
                  Scope: {secret.scope === "app" ? "Account" : "App"}
                </button>
                <button
                  onClick={() => {
                    setActiveMenu(null)
                    onDelete()
                  }}
                  className="flex w-full items-center px-2 py-1.5 hover:bg-muted rounded text-left text-rose-600"
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ConfigRow({
  config,
  onValueChange,
  onTestingValueChange,
  onCopyKey,
  onCopyVal,
  onDelete,
  activeMenu,
  setActiveMenu,
}: {
  config: ConfigurationEntry
  onValueChange: (val: string) => void
  onTestingValueChange: (val: string) => void
  onCopyKey: () => void
  onCopyVal: () => void
  onDelete: () => void
  activeMenu: { type: "secret" | "config"; id: string } | null
  setActiveMenu: (val: { type: "secret" | "config"; id: string } | null) => void
}) {
  const isMenuOpen = activeMenu?.type === "config" && activeMenu.id === config.id

  const getIcon = () => {
    switch (config.type) {
      case "sync":
        return <RefreshCw className="h-4 w-4 text-blue-500 shrink-0" />
      case "globe":
        return <Globe2 className="h-4 w-4 text-green-500 shrink-0" />
      default:
        return <Link2 className="h-4 w-4 text-amber-500 shrink-0" />
    }
  }

  const hasTestingOverride = typeof config.testingValue !== "undefined"

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3">
        {/* Leftmost Type Icon */}
        <div className="w-6 flex justify-center">{getIcon()}</div>

        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
          {/* Left Key Card */}
          <div className="flex h-10 items-center gap-2.5 rounded-lg border border-border/40 bg-zinc-200/50 dark:bg-zinc-800/40 px-3 py-2 text-[12px] font-mono font-semibold text-zinc-800 dark:text-zinc-200 shadow-sm">
            <button onClick={onCopyKey} className="text-muted-foreground hover:text-foreground transition-colors">
              <Copy className="h-3.5 w-3.5" />
            </button>
            <span className="truncate flex-1">{config.key}</span>
          </div>

          {/* Right Value Card */}
          <div className="flex h-10 items-center gap-2 rounded-lg border border-border/40 bg-zinc-200/50 dark:bg-zinc-800/40 px-3 py-2 shadow-sm relative">
            <button onClick={onCopyVal} className="text-muted-foreground hover:text-foreground transition-colors">
              <Copy className="h-3.5 w-3.5" />
            </button>
            <input
              type="text"
              value={config.value}
              onChange={(e) => onValueChange(e.target.value)}
              className="flex-1 bg-transparent border-none outline-none font-mono text-[12px] text-zinc-900 dark:text-zinc-100"
            />

            {/* Options Ellipsis */}
            <div className="relative">
              <button onClick={() => setActiveMenu(isMenuOpen ? null : { type: "config", id: config.id })} className="text-muted-foreground hover:text-foreground transition-colors">
                <MoreVertical className="h-4 w-4" />
              </button>
              {isMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setActiveMenu(null)} />
                  <div className="absolute right-0 mt-2 w-32 rounded-md border border-border bg-popover p-1 shadow-md z-50 text-[11px]">
                    <button
                      onClick={() => {
                        setActiveMenu(null)
                        onDelete()
                      }}
                      className="flex w-full items-center px-2 py-1.5 hover:bg-muted rounded text-left text-rose-600"
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Sub-row for testing override if config has one */}
      {hasTestingOverride && (
        <div className="flex items-center gap-3 pl-9">
          <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
            {/* Testing override label */}
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground pl-1">
              <span>Testing value</span>
              <span title="This override is applied during Replit workspace tests.">
                <HelpCircle className="h-3.5 w-3.5 cursor-help" />
              </span>
            </div>

            {/* Testing override value input */}
            <div className="flex h-10 items-center gap-2 rounded-lg border border-border/40 bg-zinc-200/50 dark:bg-zinc-800/40 px-3 py-2 shadow-sm">
              <button onClick={() => copyToClipboard(config.testingValue || "", "Testing value copiado")} className="text-muted-foreground hover:text-foreground transition-colors">
                <Copy className="h-3.5 w-3.5" />
              </button>
              <input
                type="text"
                value={config.testingValue}
                onChange={(e) => onTestingValueChange(e.target.value)}
                className="flex-1 bg-transparent border-none outline-none font-mono text-[12px] text-zinc-900 dark:text-zinc-100"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function DatabaseTool() {
  const { files } = useCodeWorkspace()
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

  // Real data model of the app being built, parsed from the workspace itself
  // (prisma/schema.prisma or the in-memory CRUD API routes emitted by codegen).
  const workspaceSchema = React.useMemo(() => detectWorkspaceSchema(files), [files])

  const addRow = () => {
    if (!table) return
    setTables((prev) => prev.map((item) => {
      if (item.name !== table.name) return item
      const nextIndex = item.rows.length + 1
      const row = Object.fromEntries(item.columns.map((col) => [col, col === "id" ? String(nextIndex) : `${col}_${nextIndex}`]))
      return { ...item, rows: [...item.rows, row] }
    }))
  }

  // Seed/refresh the local playground tables from the real workspace model so
  // the SQL runner operates over the app's actual shape (rows are preserved
  // for tables that already exist).
  const importWorkspaceModel = () => {
    if (!workspaceSchema) return
    setTables((prev) => {
      const prevByName = new Map(prev.map((item) => [item.name.toLowerCase(), item]))
      const imported = workspaceSchema.models.map((model) => {
        const name = model.name.toLowerCase()
        const columns = model.fields.length > 0 ? model.fields.map((field) => field.name) : ["id"]
        const existing = prevByName.get(name)
        return {
          name,
          columns,
          rows: existing ? existing.rows : [],
        }
      })
      const importedNames = new Set(imported.map((item) => item.name))
      return [...imported, ...prev.filter((item) => !importedNames.has(item.name))]
    })
    const first = workspaceSchema.models[0]
    if (first) {
      setSelected(first.name.toLowerCase())
      setQuery(`select * from ${first.name.toLowerCase()}`)
    }
    toast.success(`Modelo importado: ${workspaceSchema.models.length} tabla(s) del workspace`)
  }

  return (
    <ToolShell
      eyebrow={workspaceSchema ? "Database · workspace" : "Database · local"}
      title="Postgres workspace"
      detail={
        workspaceSchema
          ? `Modelo real detectado en ${workspaceSchema.path} (${workspaceSchema.models.length} modelo(s)). El playground de abajo es local al navegador; la base Postgres por-proyecto real aún no está disponible.`
          : "Prototipo LOCAL en el navegador (no persiste en el servidor): modela tablas y prueba consultas simples. La base Postgres por-proyecto real aún no está disponible."
      }
      action={<Button size="sm" className="h-8 gap-1.5" onClick={addRow}><Plus className="h-3.5 w-3.5" />Fila demo</Button>}
    >
      {workspaceSchema ? (
        <PanelCard
          title="Modelo del workspace"
          detail={
            workspaceSchema.source === "prisma"
              ? `Parseado de ${workspaceSchema.path}`
              : "Detectado de las rutas API del proyecto"
          }
          icon={<Database className="h-4 w-4" />}
          className="mb-3"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {workspaceSchema.models.map((model) => (
              <div key={model.name} className="rounded-md border border-border/60 bg-muted/20 p-2.5">
                <p className="text-[12.5px] font-semibold">{model.name}</p>
                {model.fields.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {model.fields.map((field) => (
                      <code
                        key={field.name}
                        className={cn(
                          "rounded border border-border/50 bg-background px-1.5 py-0.5 text-[10.5px]",
                          field.isId && "border-foreground/30 font-semibold",
                          field.relation && "text-muted-foreground",
                        )}
                        title={[
                          field.isId ? "primary key" : null,
                          field.isUnique ? "unique" : null,
                          field.relation ? `relación → ${field.relation}` : null,
                          field.hasDefault ? "con default" : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || undefined}
                      >
                        {fieldLabel(field)}
                      </code>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-muted-foreground">Campos no inferibles desde las rutas.</p>
                )}
              </div>
            ))}
          </div>
          <Button size="sm" variant="outline" className="mt-3 h-8 gap-1.5" onClick={importWorkspaceModel}>
            <Database className="h-3.5 w-3.5" />
            Usar este modelo en el playground
          </Button>
        </PanelCard>
      ) : null}
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
  const { openLocalFolderWorkspace, workspaceSource } = useCodeWorkspace()
  const [assets, setAssets] = useWorkspacePersistedState<{ id: string; name: string; size: number; type: string; createdAt: number }[]>("storage", [])
  return (
    <ToolShell
      eyebrow="Storage · local"
      title="App Storage"
      detail="Registro LOCAL de assets del workspace (los archivos no salen del navegador). El almacenamiento de objetos servido a la app aún no está disponible."
    >
      <PanelGrid>
        <PanelCard
          title="Carpeta local"
          detail={workspaceSource.linked ? `Vinculada: ${workspaceSource.name}` : "Vincula una carpeta de tu computadora al workspace"}
          icon={<FolderOpen className="h-4 w-4" />}
        >
          <Button
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => void openLocalFolderWorkspace()}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {workspaceSource.linked ? "Cambiar carpeta" : "Vincular carpeta local"}
          </Button>
          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
            El agente lee archivos compatibles de esa carpeta en el workspace y puedes guardar cambios de vuelta al disco.
          </p>
        </PanelCard>
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

// Open a workspace tool panel by id (managed services route to their real tool).
function openWorkspaceTool(toolId: string) {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(CODE_OPEN_TOOL_EVENT, { detail: toolId }))
}

// Which real tool a managed/external card routes to.
const INTEGRATION_ROUTE: Record<string, string> = {
  "managed-database": "database",
  "managed-storage": "storage",
  "managed-auth": "auth",
  "managed-domains": "publishing",
  stripe: "secrets",
  supabase: "secrets",
  openai: "secrets",
}

function IntegrationsTool() {
  const [gh, setGh] = React.useState<GithubStatus | null>(null)
  const [ghLoading, setGhLoading] = React.useState(true)
  React.useEffect(() => {
    let alive = true
    githubService
      .status()
      .then((s) => { if (alive) setGh(s) })
      .catch(() => { if (alive) setGh(null) })
      .finally(() => { if (alive) setGhLoading(false) })
    return () => { alive = false }
  }, [])

  const renderCard = (group: { id: string }, connector: { id: string; label: string; detail: string }) => {
    // GitHub: REAL OAuth connection status (same backend the Git tool uses).
    if (connector.id === "github") {
      const connected = !!gh?.connected
      const configured = gh?.configured !== false
      return (
        <div className="flex items-center justify-between">
          <StatusPill status={ghLoading ? "idle" : connected ? "success" : configured ? "idle" : "warn"} />
          <Button
            size="sm"
            variant={connected ? "outline" : "default"}
            className="h-8"
            disabled={ghLoading}
            onClick={() => {
              if (connected) { openWorkspaceTool("git"); return }
              githubService.connectUrl().then(({ url }) => { if (url) window.open(url, "_blank", "noopener") }).catch(() => {})
            }}
          >
            {ghLoading ? "…" : connected ? `Conectado${gh?.login ? `: ${gh.login}` : ""}` : configured ? "Conectar" : "No configurado"}
          </Button>
        </div>
      )
    }
    // Managed services + external APIs → route to their real tool (Database/
    // Storage/Auth/Publishing/Secrets) instead of a fake on/off toggle.
    const route = INTEGRATION_ROUTE[connector.id]
    if (route) {
      return (
        <div className="flex items-center justify-between">
          <StatusPill status={group.id === "managed" ? "ready" : "idle"} />
          <Button size="sm" variant="outline" className="h-8" onClick={() => openWorkspaceTool(route)}>
            {group.id === "external" ? "Configurar en Secrets" : "Abrir"}
          </Button>
        </div>
      )
    }
    // Agent services (web search / image gen / long-running) are ALWAYS
    // available to the chat agent — mark them so, honestly, no toggle.
    if (group.id === "agent-services") {
      return (
        <div className="flex items-center justify-between">
          <StatusPill status="success" />
          <span className="text-[11px] text-muted-foreground">Disponible para el agente</span>
        </div>
      )
    }
    // Connectors without a per-workspace backend yet (Slack/Google): honest.
    return (
      <div className="flex items-center justify-between">
        <StatusPill status="idle" />
        <span className="text-[11px] text-muted-foreground">Próximamente</span>
      </div>
    )
  }

  return (
    <ToolShell eyebrow="Connectors" title="Integraciones" detail="GitHub conecta por OAuth real; los servicios administrados abren su herramienta; las APIs externas se configuran en Secrets.">
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
                  {renderCard(group, connector)}
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
    <ToolShell eyebrow="Authentication · local" title="Auth" detail="Preferencias LOCALES de login para el código generado (aún no gestiona usuarios ni sesiones reales en el servidor).">
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
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 gap-1.5"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("siragpt:code-fix-error", {
                        detail: { text: `${row.path}: ${row.detail}` },
                      }),
                    )
                  }
                >
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
  // REAL deployments for this user from /api/deployments (DEPLOYMENTS_V2).
  const [deploys, setDeploys] = React.useState<RealDeployment[] | null>(null)
  React.useEffect(() => {
    let alive = true
    deploymentsApi
      .list()
      .then((rows) => { if (alive) setDeploys(Array.isArray(rows) ? rows : []) })
      .catch(() => { if (alive) setDeploys([]) }) // flag off / unauth → honest 0
    return () => { alive = false }
  }, [])
  const fileCount = Object.keys(files).length
  const jsCount = Object.keys(files).filter((path) => /\.(tsx?|jsx?)$/.test(path)).length
  const running = (deploys || []).filter((d) => d.status === "running").length
  const last = (deploys || [])[0]
  const fmtStatus: Record<string, string> = {
    running: "activo", suspended: "suspendido", building: "construyendo",
    paused: "pausado", failed: "fallido", shut_down: "apagado",
  }
  return (
    <ToolShell eyebrow="Insights" title="Analytics" detail="Métricas reales del workspace y del historial de despliegues de tu cuenta.">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric title="Workspace" value={activeFolder?.name || "Default"} />
        <Metric title="Archivos" value={String(fileCount)} />
        <Metric title="JS/TS" value={String(jsCount)} />
        <Metric title="Deploys" value={deploys === null ? "…" : `${deploys.length}${running ? ` · ${running} activo(s)` : ""}`} />
      </div>
      <PanelCard className="mt-3" title="Despliegues" detail={deploys === null ? "Cargando…" : `${deploys.length} despliegue(s) en tu cuenta`} icon={<Activity className="h-4 w-4" />}>
        <div className="space-y-2 text-[12px]">
          {deploys === null ? (
            <p className="text-muted-foreground">Consultando /api/deployments…</p>
          ) : deploys.length === 0 ? (
            <ActivityRow label="Publicación" value="Sin despliegues todavía — publica desde Publishing" />
          ) : (
            <>
              {last ? <ActivityRow label={last.name} value={`${fmtStatus[last.status] || last.status} · ${new Date(last.createdAt).toLocaleDateString()}`} /> : null}
              {deploys.slice(1, 4).map((d) => (
                <ActivityRow key={d.id} label={d.name} value={`${fmtStatus[d.status] || d.status} · ${d.defaultDomain || d.subdomain}`} />
              ))}
            </>
          )}
          <ActivityRow label="Preview" value={fileCount ? "Listo para ejecutar" : "Esperando archivos"} />
          <ActivityRow label="Código" value={`${jsCount} archivos de aplicación`} />
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
    <ToolShell eyebrow="Automation · experimental" title="Automations" detail="Reglas LOCALES de referencia (experimental): el agente aún no las ejecuta ni programa automáticamente en el servidor.">
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

type AgentSkill = {
  id: string
  label: string
  category: string
  description: string
  tools?: string[]
  tags?: string[]
  outputKind?: string
}

function SkillsTool() {
  const [skills, setSkills] = React.useState<AgentSkill[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    let alive = true
    const base = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}`
    const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
    fetch(`${base}/cowork/skills`, {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => { if (alive) setSkills(Array.isArray(data?.skills) ? data.skills : []) })
      .catch((e) => { if (alive) setError(e?.message || "No se pudo cargar el catálogo") })
    return () => { alive = false }
  }, [])

  // Group the REAL catalog by category.
  const groups = React.useMemo(() => {
    const map = new Map<string, AgentSkill[]>()
    for (const s of skills || []) {
      const k = s.category || "otras"
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(s)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [skills])

  return (
    <ToolShell
      eyebrow="Agent"
      title="Agent Skills"
      detail={skills ? `Catálogo real de ${skills.length} habilidades del agente (GET /api/cowork/skills).` : "Habilidades que el agente puede usar en este workspace."}
    >
      {error ? (
        <p className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-3 text-[12px] text-amber-700">No se pudo cargar el catálogo de habilidades: {error}</p>
      ) : !skills ? (
        <p className="rounded-md bg-muted/35 px-3 py-3 text-[12px] text-muted-foreground">Cargando catálogo…</p>
      ) : skills.length === 0 ? (
        <p className="rounded-md bg-muted/35 px-3 py-3 text-[12px] text-muted-foreground">No hay habilidades disponibles para tu plan.</p>
      ) : (
        <div className="space-y-4">
          {groups.map(([category, rows]) => (
            <section key={category}>
              <h3 className="mb-2 text-[13px] font-semibold capitalize text-foreground">{category}</h3>
              <div className="grid gap-2 md:grid-cols-2">
                {rows.map((skill) => (
                  <PanelCard key={skill.id} title={skill.label} detail={skill.description} icon={<Wrench className="h-4 w-4" />}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusPill status="success" />
                      {(skill.tags || []).slice(0, 4).map((tag) => (
                        <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>
                      ))}
                      {typeof skill.outputKind === "string" && skill.outputKind ? (
                        <span className="ml-auto text-[10px] text-muted-foreground">→ {skill.outputKind}</span>
                      ) : null}
                    </div>
                  </PanelCard>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
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
  const [running, setRunning] = React.useState(false)

  // Fast, always-available static checks over the in-memory workspace.
  const staticChecks = React.useCallback((): ValidationResult[] => {
    const paths = Object.keys(files)
    const hasPackage = paths.some((path) => path.endsWith("package.json"))
    const hasEntry = paths.some((path) => /(^|\/)(index|app|main)\.(tsx?|jsx?|html)$/.test(path))
    const hasLargeFile = Object.values(files).some((file) => file.content.length > 120_000)
    return [
      { id: "files", label: "Workspace files", detail: `${paths.length} archivos detectados`, status: paths.length ? "pass" : "fail" },
      { id: "entry", label: "Entry point", detail: hasEntry ? "Entrada detectada" : "No se encontro index/app/main", status: hasEntry ? "pass" : "warn" },
      { id: "package", label: "Node project", detail: hasPackage ? "package.json presente" : "Proyecto estatico o sin package.json", status: hasPackage ? "pass" : "warn" },
      { id: "size", label: "Large files", detail: hasLargeFile ? "Hay archivos muy grandes" : "Tamano razonable", status: hasLargeFile ? "warn" : "pass" },
    ]
  }, [files])

  const run = React.useCallback(async () => {
    setRunning(true)
    const rows = staticChecks()
    setResults(rows)
    const runId = getActiveHostRunId()
    // REAL server-side checks when a dev server is live: tsc --noEmit (type
    // check) + headless-chromium render verdict. Both endpoints already exist.
    if (runId) {
      try {
        const [types, runtime] = await Promise.all([
          hostRunnerService.verify(runId),
          hostRunnerService.verifyRuntime(runId),
        ])
        const typeRow: ValidationResult = types.skipped
          ? { id: "types", label: "TypeScript (tsc --noEmit)", detail: types.reason || "sin tsconfig — omitido", status: "warn" }
          : types.ok
            ? { id: "types", label: "TypeScript (tsc --noEmit)", detail: "sin errores de tipos", status: "pass" }
            : { id: "types", label: "TypeScript (tsc --noEmit)", detail: `${types.errorCount ?? types.errors?.length ?? 0} error(es) de tipos`, status: "fail" }
        const renderRow: ValidationResult = runtime.skipped
          ? { id: "render", label: "Render real (chromium)", detail: runtime.reason || "verificación no disponible", status: "warn" }
          : runtime.ok
            ? { id: "render", label: "Render real (chromium)", detail: runtime.summary || "la app renderiza correctamente", status: "pass" }
            : { id: "render", label: "Render real (chromium)", detail: runtime.summary || (runtime.findings?.[0]?.message) || "la app no renderiza bien", status: "fail" }
        setResults([renderRow, typeRow, ...rows])
      } catch {
        setResults([{ id: "server", label: "Verificación en servidor", detail: "no se pudo contactar al runner", status: "warn" }, ...rows])
      }
    }
    setRunning(false)
  }, [staticChecks])

  const hasRun = typeof window !== "undefined" && !!getActiveHostRunId()
  return (
    <ToolShell
      eyebrow="Checks"
      title="Validation"
      detail={hasRun
        ? "Verificación REAL: tipos (tsc) + render (chromium) del dev server, más checks estáticos."
        : "Checks estáticos del workspace. Arranca la app (▶ Ejecutar) para verificar tipos + render reales."}
      action={<Button size="sm" className="h-8 gap-1.5" onClick={() => void run()} disabled={running}><Play className="h-3.5 w-3.5" />{running ? "Verificando…" : "Ejecutar"}</Button>}
    >
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
        <PanelCard title="Tool coverage" detail={`${ALL_TOOLS.length} herramientas listas`} icon={<ListChecks className="h-4 w-4" />}>
          <div className="max-h-80 overflow-auto rounded-md border border-border/60">
            {ALL_TOOLS.map((tool) => {
              const Icon = tool.icon
              return (
                <div key={tool.id} className="flex items-center gap-3 border-b border-border/50 px-3 py-2 last:border-b-0">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/45 text-muted-foreground">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium text-foreground">{tool.label}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{TOOL_RUNTIME_NOTES[tool.id]}</p>
                  </div>
                  <span className="rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">
                    {tool.behavior === "screen" ? "Panel" : "Accion"}
                  </span>
                </div>
              )
            })}
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

  const run = async (row: WorkflowRun) => {
    const consoleId = makeId("console")
    const startedAt = Date.now()
    const isDevServer = /\b(npm|pnpm|yarn|bun)\s+run\s+dev\b|\bvite\b|\bnext\s+dev\b/i.test(row.command)
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

    // A dev-server command isn't a one-shot exec — boot the preview (host runner
    // installs + starts it) and point the user at the live Console tail.
    if (isDevServer) {
      window.dispatchEvent(new CustomEvent("siragpt:code-run-app"))
      finishConsole(consoleId, row.id, "success", [
        { stream: "stdout", text: "Dev server solicitado en Preview — mira la salida en vivo en Console." },
      ])
      return
    }

    // One-shot command: run it FOR REAL against the live workspace if a dev
    // server is up (the exec backend needs a run). Otherwise be honest.
    const runId = getActiveHostRunId()
    if (!runId) {
      finishConsole(consoleId, row.id, "failed", [
        { stream: "stderr", text: "No hay un servidor activo. Pulsa ▶ Ejecutar para arrancar la app y poder correr comandos reales." },
      ])
      return
    }
    try {
      const res = await hostRunnerService.exec(runId, row.command)
      if (res.unavailable) {
        finishConsole(consoleId, row.id, "failed", [
          { stream: "stderr", text: "El servidor de desarrollo ya no está activo. Reinícialo con ▶ Ejecutar." },
        ])
        return
      }
      const outLines = (res.output || "").split(/\r?\n/).filter(Boolean).map((text) => ({
        stream: (res.ok ? "stdout" : "stderr") as "stdout" | "stderr",
        text,
      }))
      finishConsole(consoleId, row.id, res.ok ? "success" : "failed", [
        ...outLines,
        { stream: "system", text: res.timedOut ? "El comando excedió el tiempo límite" : `Exit code ${res.exitCode ?? (res.ok ? 0 : 1)}` },
      ])
    } catch {
      finishConsole(consoleId, row.id, "failed", [
        { stream: "stderr", text: "No se pudo ejecutar el comando." },
      ])
    }
  }

  // Close out a workflow run + its Console entry with real result lines.
  const finishConsole = (
    consoleId: string,
    rowId: string,
    status: "success" | "failed",
    extraLines: Array<{ stream: "stdout" | "stderr" | "system"; text: string }>,
  ) => {
    setRuns((prev) => prev.map((item) => item.id === rowId ? { ...item, status, lastRun: Date.now() } : item))
    setConsoleRuns((prev) => prev.map((item) => item.id === consoleId
      ? { ...item, status, endedAt: Date.now(), lines: [...item.lines, ...extraLines] }
      : item,
    ))
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
                if (row) void run(row)
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
            <Button size="sm" variant={row.status === "running" ? "outline" : "default"} className="h-8 w-20 gap-1.5" onClick={() => row.status === "running" ? stop(row.id) : void run(row)}>
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

// Live dev-server output: subscribes to the active host run (broadcast by
// preview-pane) and polls its real log tail. Returns [] when no run is live.
function useLiveRunnerTail() {
  const [runId, setRunId] = React.useState<string | null>(() => getActiveHostRunId())
  const [tail, setTail] = React.useState<string[]>([])
  const [phase, setPhase] = React.useState<string>("")
  React.useEffect(() => {
    const onActive = (e: Event) => {
      const id = (e as CustomEvent<{ runId: string | null }>).detail?.runId ?? null
      setRunId(id)
      if (!id) {
        setTail([])
        setPhase("")
      }
    }
    window.addEventListener(CODE_RUNNER_ACTIVE_EVENT, onActive as EventListener)
    return () => window.removeEventListener(CODE_RUNNER_ACTIVE_EVENT, onActive as EventListener)
  }, [])
  React.useEffect(() => {
    if (!runId) return
    let alive = true
    const poll = async () => {
      const st = await hostRunnerService.status(runId)
      if (!alive) return
      if (Array.isArray(st.tail)) setTail(st.tail)
      if (st.phase) setPhase(st.phase)
    }
    void poll()
    const t = window.setInterval(poll, 2500)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [runId])
  return { runId, tail, phase }
}

function ConsoleTool() {
  const [runs, setRuns] = useWorkspacePersistedState<ConsoleRun[]>("console-runs", [])
  const live = useLiveRunnerTail()
  const [latestOnly, setLatestOnly] = React.useState(true)
  const visibleRuns = latestOnly ? runs.slice(0, 1) : runs
  const latestError = React.useMemo(() => {
    for (const row of runs) {
      if (row.status === "failed" || row.lines.some((line) => line.stream === "stderr")) {
        return [`$ ${row.command}`, ...row.lines.map((line) => line.text)].join("\n")
      }
    }
    return ""
  }, [runs])

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
      detail={live.runId
        ? "Salida en vivo del dev server + historial de ejecuciones."
        : "Arranca la app (▶ Ejecutar) para ver la salida en vivo. Historial de runs abajo."}
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
      {live.runId ? (
        <div className="mb-3 rounded-lg border border-emerald-500/25 bg-[#0d1117]">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
            <span className="flex items-center gap-2 font-mono text-[12px] text-emerald-300">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
              Salida en vivo · dev server{live.phase ? ` (${live.phase})` : ""}
            </span>
            <span className="font-mono text-[11px] text-white/40">{live.tail.length} líneas</span>
          </div>
          <pre className="max-h-56 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-[#d1d5db]">
            {live.tail.length ? live.tail.join("\n") : "esperando salida del servidor…"}
          </pre>
        </div>
      ) : null}
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
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={() =>
                window.dispatchEvent(
                  latestError
                    ? new CustomEvent("siragpt:code-fix-error", { detail: { text: latestError } })
                    : new CustomEvent("siragpt:code-composer-mode", { detail: { mode: "debug" } }),
                )
              }
            >
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
