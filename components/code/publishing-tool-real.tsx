"use client"

/**
 * RealPublishingPanel — Replit-Deployments-style Publishing for /code.
 * Deploys the project's BOUND GitHub repo to Hostinger (build → SFTP/FTP upload).
 *
 * Layout mirrors Replit: tabs Overview · Logs · Domains · Manage.
 *   no git binding  → connect a repo in the Git tab first
 *   no host target  → "Connect Hostinger" form (creds encrypted server-side)
 *   configured      → tabbed dashboard
 */

import * as React from "react"
import {
  Rocket,
  Loader2,
  Plug,
  Trash2,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Globe,
  List,
  Settings2,
  LayoutGrid,
  Copy,
  QrCode,
  Server,
  RefreshCw,
  Power,
  SlidersHorizontal,
  AlertTriangle,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { getGitBinding } from "@/lib/code-git-mirror"
import {
  hostingService,
  type HostingTarget,
  type BuildPlan,
  type DeploymentRow,
  type Protocol,
} from "@/lib/hosting-service"

const PROTOCOLS: Protocol[] = ["sftp", "ftp", "ftps"]
type Tab = "overview" | "logs" | "domains" | "manage"

type Settings = {
  targetId: string
  branch: string
  buildCommand: string
  outputDir: string
  remotePath: string
  cleanSlate: boolean
  mode: "static" | "node"
  appName: string
  remoteCommand: string
  domain: string
  domainKind: "main" | "addon"
  configureNginx: boolean
  appPort: string
  ssl: boolean
  sslEmail: string
}
const emptySettings: Settings = {
  targetId: "",
  branch: "",
  buildCommand: "",
  outputDir: "",
  remotePath: "",
  cleanSlate: false,
  mode: "static",
  appName: "app",
  remoteCommand: "",
  domain: "",
  domainKind: "main",
  configureNginx: false,
  appPort: "3000",
  ssl: false,
  sslEmail: "",
}
const settingsKey = (p: string | null) => `siragpt:code-publishing:${p || "default"}`

function StatusDot({ status }: { status?: string }) {
  const color =
    status === "success" ? "bg-emerald-500" : status === "error" ? "bg-red-500" : status === "uploading" || status === "building" ? "bg-sky-500" : "bg-zinc-400"
  return <span className={cn("inline-block h-2 w-2 rounded-full", color)} />
}

export function RealPublishingPanel({ projectId }: { projectId: string | null }) {
  const [connectionId, setConnectionId] = React.useState<string | null>(null)
  const [targets, setTargets] = React.useState<HostingTarget[]>([])
  const [plan, setPlan] = React.useState<BuildPlan | null>(null)
  const [settings, setSettings] = React.useState<Settings>(emptySettings)
  const [history, setHistory] = React.useState<DeploymentRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [showConnect, setShowConnect] = React.useState(false)
  const [tab, setTab] = React.useState<Tab>("overview")
  const [showSettings, setShowSettings] = React.useState(false)
  const [showQr, setShowQr] = React.useState(false)

  // Live deployment
  const [deploying, setDeploying] = React.useState(false)
  const [live, setLive] = React.useState<{ status: string; url: string | null; error: string | null; tail: string[] } | null>(null)
  const [currentDeployId, setCurrentDeployId] = React.useState<string | null>(null)
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  React.useEffect(() => {
    setConnectionId(getGitBinding(projectId))
    try {
      const raw = window.localStorage.getItem(settingsKey(projectId))
      if (raw) setSettings({ ...emptySettings, ...JSON.parse(raw) })
    } catch {
      /* ignore */
    }
  }, [projectId])

  const persist = React.useCallback(
    (next: Settings) => {
      setSettings(next)
      try {
        window.localStorage.setItem(settingsKey(projectId), JSON.stringify(next))
      } catch {
        /* ignore */
      }
    },
    [projectId],
  )

  const loadTargets = React.useCallback(async () => {
    try {
      const { targets: list } = await hostingService.listTargets()
      setTargets(list)
      return list
    } catch {
      return []
    }
  }, [])

  const loadHistory = React.useCallback(async () => {
    if (!connectionId) return
    try {
      const { deployments } = await hostingService.listDeployments(connectionId)
      setHistory(deployments)
    } catch {
      /* ignore */
    }
  }, [connectionId])

  React.useEffect(() => {
    let alive = true
    ;(async () => {
      const list = await loadTargets()
      if (connectionId) {
        try {
          const { plan: p } = await hostingService.buildPlan(connectionId)
          if (alive) {
            setPlan(p)
            setSettings((s) => ({
              ...s,
              buildCommand: s.buildCommand || p.buildCommand || "",
              outputDir: s.outputDir || p.outputDir || "dist",
              targetId: s.targetId || (list[0]?.id ?? ""),
              remotePath: s.remotePath || (list.find((t) => t.id === s.targetId)?.remoteBaseDir ?? list[0]?.remoteBaseDir ?? "/public_html"),
            }))
          }
        } catch {
          /* not cloned */
        }
        await loadHistory()
      }
      if (alive) setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [connectionId, loadTargets, loadHistory])

  React.useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current)
    },
    [],
  )

  const deploy = async () => {
    if (!connectionId) return
    if (!settings.targetId) return toast.error("Elige un destino")
    setDeploying(true)
    setTab("logs")
    setLive({ status: "queued", url: null, error: null, tail: [] })
    try {
      const { deploymentId } = await hostingService.deploy(connectionId, {
        targetId: settings.targetId,
        branch: settings.branch || undefined,
        buildCommand: settings.buildCommand || undefined,
        outputDir: settings.outputDir || undefined,
        remotePath: settings.remotePath || undefined,
        cleanSlate: settings.cleanSlate,
        mode: settings.mode,
        appName: settings.appName || undefined,
        remoteCommand: settings.remoteCommand || undefined,
        domain: settings.domain || undefined,
        domainKind: settings.domainKind,
        configureNginx: settings.configureNginx,
        appPort: settings.appPort || undefined,
        ssl: settings.ssl,
        sslEmail: settings.sslEmail || undefined,
      })
      setCurrentDeployId(deploymentId)
      pollRef.current && clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const { deployment, live: l } = await hostingService.deployment(deploymentId)
          const status = l?.status || deployment.status
          setLive({
            status,
            url: l?.url || deployment.url,
            error: l?.error || deployment.error,
            tail: l?.tail || (deployment.logTail ? deployment.logTail.split("\n") : []),
          })
          if (status === "success" || status === "error") {
            if (pollRef.current) clearInterval(pollRef.current)
            setDeploying(false)
            if (status === "success") toast.success("¡Publicado!")
            else toast.error(deployment.error || "Deploy fallido")
            await loadHistory()
          }
        } catch {
          /* keep polling */
        }
      }, 2000)
    } catch (e) {
      setDeploying(false)
      setLive(null)
      toast.error((e as Error).message || "No se pudo iniciar el deploy")
    }
  }

  const cancelDeploy = async () => {
    if (!currentDeployId) return
    try {
      await hostingService.cancel(currentDeployId)
      toast.info("Deploy cancelado")
    } catch (e) {
      toast.error((e as Error).message || "No se pudo cancelar")
    }
  }

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success("Copiado"),
      () => toast.error("No se pudo copiar"),
    )
  }

  const shutDown = async (t: HostingTarget) => {
    if (!confirm(`¿Quitar el destino "${t.label}"? Tendrás que reconectarlo para volver a publicar.`)) return
    try {
      await hostingService.deleteTarget(t.id)
      toast.success("Destino eliminado")
      const list = await loadTargets()
      if (list.length === 0) setShowConnect(true)
    } catch (e) {
      toast.error((e as Error).message || "No se pudo eliminar")
    }
  }

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  if (!connectionId) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Primero conecta un repositorio en la pestaña <span className="font-medium text-foreground">Git</span>. Publishing
        despliega ese repositorio.
      </div>
    )
  }

  if (targets.length === 0 || showConnect) {
    return (
      <ConnectHostingForm
        onCancel={targets.length > 0 ? () => setShowConnect(false) : undefined}
        onConnected={async (t) => {
          await loadTargets()
          persist({ ...settings, targetId: t.id, remotePath: settings.remotePath || t.remoteBaseDir })
          setShowConnect(false)
        }}
      />
    )
  }

  const target = targets.find((t) => t.id === settings.targetId) || targets[0]
  const latest = history[0]
  const liveStatus = deploying ? live?.status : latest?.status
  const siteUrl = target?.siteUrl || latest?.url || ""
  const logLines = deploying && live ? live.tail : latest?.logTail ? latest.logTail.split("\n") : []

  const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "overview", label: "Overview", icon: Globe },
    { id: "logs", label: "Logs", icon: List },
    { id: "domains", label: "Domains", icon: Globe },
    { id: "manage", label: "Manage", icon: Settings2 },
  ]

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
              tab === t.id ? "border-sky-500 text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {tab === "overview" && (
        <div className="space-y-4">
          {/* Action bar */}
          <div className="flex flex-wrap gap-2">
            <Button className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={deploying} onClick={deploy}>
              {deploying ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Rocket className="mr-1.5 h-4 w-4" />}
              {deploying ? "Publicando…" : "Publicar"}
            </Button>
            {deploying && (
              <Button variant="outline" className="text-red-500 hover:text-red-600" onClick={cancelDeploy}>
                <Power className="mr-1.5 h-4 w-4" /> Cancelar
              </Button>
            )}
            <Button variant="outline" onClick={() => setShowSettings((s) => !s)}>
              <SlidersHorizontal className="mr-1.5 h-4 w-4" /> Ajustes
            </Button>
          </div>

          {/* Production card */}
          <div className="rounded-lg border border-border">
            <div className="border-b border-border px-4 py-2 text-sm font-semibold">Production</div>
            <dl className="divide-y divide-border/60 text-sm">
              <Row label="Status">
                <span className="inline-flex items-center gap-2">
                  <StatusDot status={liveStatus} />
                  {liveStatus || "sin desplegar"}
                </span>
              </Row>
              <Row label="Visibility">
                <span className="inline-flex items-center gap-1.5">
                  <Globe className="h-3.5 w-3.5 text-muted-foreground" /> Public
                </span>
              </Row>
              <Row label="Domain">
                {siteUrl ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <a href={siteUrl} target="_blank" rel="noreferrer" className="text-sky-500 hover:underline">
                        {siteUrl}
                      </a>
                      <button className="text-muted-foreground hover:text-foreground" onClick={() => copy(siteUrl)} title="Copiar">
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button className="text-muted-foreground hover:text-foreground" onClick={() => setShowQr((q) => !q)} title="QR">
                        <QrCode className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {showQr && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        alt="QR"
                        width={120}
                        height={120}
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(siteUrl)}`}
                        className="rounded border border-border"
                      />
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground">— (configura la URL del sitio)</span>
                )}
              </Row>
              <Row label="Type">
                <span className="inline-flex items-center gap-1.5">
                  <Server className="h-3.5 w-3.5 text-muted-foreground" />
                  {target?.protocol?.toUpperCase()} · {target?.username}@{target?.host}
                </span>
              </Row>
              <Row label="Remote path">{settings.remotePath || target?.remoteBaseDir}</Row>
              <Row label="Last deploy">
                {latest ? `${latest.status} · ${new Date(latest.createdAt).toLocaleString()}` : "—"}
              </Row>
            </dl>
          </div>

          {showSettings && (
            <SettingsForm plan={plan} settings={settings} persist={persist} />
          )}
        </div>
      )}

      {/* ── LOGS ── */}
      {tab === "logs" && (
        <LogsTab lines={logLines} deploying={deploying} url={live?.url || latest?.url} status={liveStatus} />
      )}

      {/* ── DOMAINS ── */}
      {tab === "domains" && target && (
        <DomainsTab
          target={target}
          settings={settings}
          persist={persist}
          siteUrl={siteUrl}
          published={history.some((d) => d.status === "success")}
        />
      )}

      {/* ── MANAGE ── */}
      {tab === "manage" && (
        <div className="space-y-3">
          <h3 className="text-[15px] font-semibold">Gestionar publicación</h3>

          <ManageRow
            title="Volver a publicar"
            detail="Construye y sube de nuevo la última versión del repo."
            action={
              <Button size="sm" disabled={deploying} onClick={deploy}>
                {deploying ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Rocket className="mr-1 h-3.5 w-3.5" />}
                Re-deploy
              </Button>
            }
          />
          <ManageRow
            title="Cambiar destino / ajustes"
            detail="Cambia el servidor, protocolo o la ruta remota."
            action={
              <Button size="sm" variant="outline" onClick={() => { setTab("overview"); setShowSettings(true) }}>
                <SlidersHorizontal className="mr-1 h-3.5 w-3.5" /> Ajustes
              </Button>
            }
          />
          <ManageRow
            title="Conectar otro Hostinger"
            detail="Agrega un nuevo servidor de destino."
            action={
              <Button size="sm" variant="outline" onClick={() => setShowConnect(true)}>
                <Plug className="mr-1 h-3.5 w-3.5" /> Conectar
              </Button>
            }
          />
          <ManageRow
            title="Apagar / eliminar destino"
            detail="Quita este destino. El sitio ya subido seguirá en Hostinger hasta que lo borres allí."
            action={
              target && (
                <Button size="sm" variant="outline" className="text-red-500 hover:text-red-600" onClick={() => shutDown(target)}>
                  <Power className="mr-1 h-3.5 w-3.5" /> Apagar
                </Button>
              )
            }
          />

          {/* Build secrets */}
          <SecretsSection connectionId={connectionId} />

          {/* Targets list */}
          <div className="rounded-lg border border-border">
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">Destinos</div>
            {targets.map((t) => (
              <div key={t.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <input
                  type="radio"
                  checked={settings.targetId === t.id}
                  onChange={() => persist({ ...settings, targetId: t.id, remotePath: t.remoteBaseDir })}
                />
                <Server className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate">
                  {t.label} <span className="text-xs text-muted-foreground">· {t.protocol}://{t.username}@{t.host}</span>
                </span>
                <button className="text-muted-foreground hover:text-red-500" onClick={() => shutDown(t)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-start gap-3 px-4 py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function ManageRow({ title, detail, action }: { title: string; detail: string; action: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-muted-foreground">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  )
}

function SettingsForm({
  plan,
  settings,
  persist,
}: {
  plan: BuildPlan | null
  settings: Settings
  persist: (s: Settings) => void
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">Configuración</h4>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5 text-xs">
          {(["static", "node"] as const).map((m) => (
            <button
              key={m}
              onClick={() => persist({ ...settings, mode: m })}
              className={cn("rounded px-2 py-1", settings.mode === m ? "bg-foreground text-background" : "text-muted-foreground")}
            >
              {m === "static" ? "Static (shared)" : "Node (VPS)"}
            </button>
          ))}
        </div>
      </div>

      {settings.mode === "static" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Build command">
            <Input value={settings.buildCommand} onChange={(e) => persist({ ...settings, buildCommand: e.target.value })} placeholder={plan?.buildCommand || "npm run build"} className="h-8 text-sm" />
          </Field>
          <Field label="Output dir">
            <Input value={settings.outputDir} onChange={(e) => persist({ ...settings, outputDir: e.target.value })} placeholder={plan?.outputDir || "dist"} className="h-8 text-sm" />
          </Field>
          <Field label="Branch (opcional)">
            <Input value={settings.branch} onChange={(e) => persist({ ...settings, branch: e.target.value })} placeholder="main" className="h-8 text-sm" />
          </Field>
          <Field label="Remote path">
            <Input value={settings.remotePath} onChange={(e) => persist({ ...settings, remotePath: e.target.value })} placeholder="/public_html" className="h-8 text-sm" />
          </Field>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            Node mode (VPS): sube el código fuente y ejecuta install/build/pm2 por SSH. Requiere Node + pm2 en el VPS y
            un proxy (nginx) hacia el puerto de la app.
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="App name (pm2)">
              <Input value={settings.appName} onChange={(e) => persist({ ...settings, appName: e.target.value })} placeholder="app" className="h-8 text-sm" />
            </Field>
            <Field label="Remote dir">
              <Input value={settings.remotePath} onChange={(e) => persist({ ...settings, remotePath: e.target.value })} placeholder="/var/www/app" className="h-8 text-sm" />
            </Field>
          </div>
          <Field label="Comando remoto (opcional — sobreescribe el por defecto)">
            <Input value={settings.remoteCommand} onChange={(e) => persist({ ...settings, remoteCommand: e.target.value })} placeholder="cd /var/www/app && npm install && npm run build && pm2 restart app" className="h-8 text-sm" />
          </Field>
        </div>
      )}
      {/* VPS: auto-configure nginx so the site is served at the domain. */}
      <div className="space-y-2 rounded-md border border-border/60 p-2">
        <label className="flex items-center gap-2 text-xs font-medium">
          <input type="checkbox" checked={settings.configureNginx} onChange={(e) => persist({ ...settings, configureNginx: e.target.checked })} />
          Configurar nginx automáticamente en el VPS (Rasta A)
        </label>
        {settings.configureNginx && (
          <div className="space-y-2 pl-5">
            <p className="text-xs text-muted-foreground">
              Requiere VPS con acceso root/SSH. Pon tu dominio en la pestaña <b>Domains</b>. nginx servirá{" "}
              {settings.mode === "node" ? "un proxy a la app" : "los archivos"} en ese dominio.
            </p>
            {settings.mode === "node" && (
              <Field label="Puerto de la app (PORT)">
                <Input value={settings.appPort} onChange={(e) => persist({ ...settings, appPort: e.target.value })} placeholder="3000" className="h-8 w-32 text-sm" />
              </Field>
            )}
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={settings.ssl} onChange={(e) => persist({ ...settings, ssl: e.target.checked })} />
              Instalar SSL gratis (Let's Encrypt / certbot) — el dominio debe estar ya propagado
            </label>
            {settings.ssl && (
              <Field label="Email para SSL">
                <Input value={settings.sslEmail} onChange={(e) => persist({ ...settings, sslEmail: e.target.value })} placeholder="tu@email.com" className="h-8 text-sm" />
              </Field>
            )}
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={settings.cleanSlate} onChange={(e) => persist({ ...settings, cleanSlate: e.target.checked })} />
        Limpiar el directorio remoto antes de subir (clean slate)
      </label>
    </div>
  )
}

function LogsTab({ lines, deploying, url, status }: { lines: string[]; deploying: boolean; url?: string | null; status?: string }) {
  const [q, setQ] = React.useState("")
  const [errorsOnly, setErrorsOnly] = React.useState(false)
  const filtered = lines.filter((l) => {
    if (errorsOnly && !/error|fail|⚠|warn/i.test(l)) return false
    if (q && !l.toLowerCase().includes(q.toLowerCase())) return false
    return true
  })
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-8 text-sm" />
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
          Errors only
        </label>
        {deploying && <Loader2 className="h-4 w-4 animate-spin text-sky-500" />}
      </div>
      {status === "success" && url && (
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-sky-500 hover:underline">
          <ExternalLink className="h-3.5 w-3.5" /> {url}
        </a>
      )}
      <div className="max-h-80 overflow-y-auto rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-200">
        {filtered.length === 0 ? (
          <span className="text-zinc-500">Sin logs todavía. Pulsa Publicar para ver build + subida.</span>
        ) : (
          filtered.map((l, i) => (
            <div key={i} className={cn("whitespace-pre-wrap break-all", /error|fail|⚠/i.test(l) && "text-red-400")}>
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function DomainsTab({
  target,
  settings,
  persist,
  siteUrl,
  published,
}: {
  target: HostingTarget
  settings: Settings
  persist: (s: Settings) => void
  siteUrl: string
  published: boolean
}) {
  const [dns, setDns] = React.useState<Awaited<ReturnType<typeof hostingService.dns>>["dns"] | null>(null)
  const [loadingDns, setLoadingDns] = React.useState(false)
  const [verifying, setVerifying] = React.useState(false)
  const [verifyResult, setVerifyResult] = React.useState<{
    reachable: boolean
    status: number
    error?: string
    note?: string
  } | null>(null)

  const remotePreview =
    settings.domainKind === "addon" && settings.domain
      ? `domains/${settings.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}/public_html`
      : target.remoteBaseDir || "/public_html"

  const loadDns = async () => {
    setLoadingDns(true)
    try {
      const { dns: d } = await hostingService.dns(target.id, settings.domain)
      setDns(d)
    } catch (e) {
      toast.error((e as Error).message || "No se pudieron cargar las instrucciones DNS")
    } finally {
      setLoadingDns(false)
    }
  }

  const verify = async () => {
    const url = siteUrl || (settings.domain ? `https://${settings.domain}` : "")
    if (!url) return toast.error("Configura un dominio o URL primero")
    setVerifying(true)
    try {
      const r = await hostingService.verify(url)
      setVerifyResult(r)
      toast[r.reachable ? "success" : "error"](
        r.reachable ? `En vivo (HTTP ${r.status})${r.note ? " · " + r.note : ""}` : `No responde: ${r.error || r.status}`,
      )
    } catch (e) {
      toast.error((e as Error).message || "Verificación fallida")
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="space-y-4">
      {!published && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5" /> Publica el proyecto con éxito antes de enlazar un dominio.
        </div>
      )}

      {/* Domain config */}
      <section className="space-y-2">
        <h3 className="text-[15px] font-semibold">Dominio</h3>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <Field label="Tu dominio">
            <Input
              value={settings.domain}
              onChange={(e) => persist({ ...settings, domain: e.target.value })}
              placeholder="tudominio.com"
              className="h-8 text-sm"
            />
          </Field>
          <Field label="Tipo">
            <select
              value={settings.domainKind}
              onChange={(e) => persist({ ...settings, domainKind: e.target.value as "main" | "addon" })}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="main">Dominio principal</option>
              <option value="addon">Addon / subdominio</option>
            </select>
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          Carpeta remota destino: <code className="rounded bg-muted px-1">{remotePreview}</code>
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={loadDns} disabled={loadingDns}>
            {loadingDns ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Globe className="mr-1 h-3.5 w-3.5" />}
            Ver instrucciones DNS
          </Button>
          <Button size="sm" variant="outline" onClick={verify} disabled={verifying}>
            {verifying ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />}
            Verificar en vivo
          </Button>
        </div>
        {verifyResult && (
          <div className={cn("text-xs", verifyResult.reachable ? "text-emerald-600" : "text-red-500")}>
            {verifyResult.reachable
              ? `✓ Responde (HTTP ${verifyResult.status})${verifyResult.note ? " · " + verifyResult.note : ""}`
              : `✗ No responde: ${verifyResult.error || verifyResult.status}`}
          </div>
        )}
      </section>

      {/* DNS instructions */}
      {dns && (
        <section className="space-y-2 rounded-lg border border-border p-3 text-sm">
          <h4 className="font-semibold">Configurar DNS para {dns.domain || "tu dominio"}</h4>
          <div>
            <div className="text-xs font-medium text-muted-foreground">Nameservers de Hostinger</div>
            {dns.nameservers.map((ns) => (
              <div key={ns} className="flex items-center gap-2 font-mono text-xs">
                {ns}
                <button className="text-muted-foreground hover:text-foreground" onClick={() => navigator.clipboard?.writeText(ns)}>
                  <Copy className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          {dns.aRecords.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground">O registros A</div>
              {dns.aRecords.map((r) => (
                <div key={r.name} className="font-mono text-xs">
                  {r.type} {r.name} → {r.value} (TTL {r.ttl})
                </div>
              ))}
            </div>
          )}
          <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
            {dns.steps.map((s, i) => (
              <li key={i} className="whitespace-pre-wrap">
                {s}
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Live domains table */}
      <div className="rounded-lg border border-border">
        <div className="grid grid-cols-[1fr_auto] gap-2 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
          <span>Name</span>
          <span>Acción</span>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2.5 text-sm">
          <span className="truncate">{siteUrl || "— sin dominio configurado"}</span>
          {siteUrl ? (
            <a href={siteUrl} target="_blank" rel="noreferrer" className="text-sky-500 hover:underline">
              Abrir
            </a>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </div>
    </div>
  )
}

function SecretsSection({ connectionId }: { connectionId: string }) {
  const [keys, setKeys] = React.useState<string[]>([])
  const [pairs, setPairs] = React.useState<Array<{ k: string; v: string }>>([])
  const [saving, setSaving] = React.useState(false)
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    hostingService
      .getEnv(connectionId)
      .then(({ keys: k }) => setKeys(k))
      .catch(() => {})
  }, [connectionId])

  const addPair = () => setPairs((p) => [...p, { k: "", v: "" }])
  const save = async () => {
    const env: Record<string, string> = {}
    for (const { k, v } of pairs) if (k.trim()) env[k.trim()] = v
    setSaving(true)
    try {
      const { keys: saved } = await hostingService.setEnv(connectionId, env)
      setKeys(saved)
      setPairs([])
      toast.success("Secrets guardados")
    } catch (e) {
      toast.error((e as Error).message || "No se pudieron guardar")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-lg border border-border">
      <button className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium" onClick={() => setOpen((o) => !o)}>
        <span>Build secrets / variables (VITE_*…)</span>
        <span className="text-xs text-muted-foreground">{keys.length} definidas</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border p-3">
          {keys.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Actuales: {keys.map((k) => <code key={k} className="mr-1 rounded bg-muted px-1">{k}</code>)}
              <span className="ml-1">(los valores no se muestran)</span>
            </div>
          )}
          {pairs.map((p, i) => (
            <div key={i} className="flex gap-2">
              <Input
                value={p.k}
                onChange={(e) => setPairs((arr) => arr.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
                placeholder="VITE_API_KEY"
                className="h-8 text-sm"
              />
              <Input
                value={p.v}
                onChange={(e) => setPairs((arr) => arr.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
                placeholder="valor"
                className="h-8 text-sm"
                type="password"
              />
            </div>
          ))}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={addPair}>
              + Variable
            </Button>
            <Button size="sm" disabled={saving || pairs.length === 0} onClick={save}>
              {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Guardar (reemplaza todas)
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Se cifran en el servidor y se inyectan en el build (p. ej. <code>VITE_*</code> para Vite).
          </p>
        </div>
      )}
    </div>
  )
}

function ConnectHostingForm({
  onConnected,
  onCancel,
}: {
  onConnected: (t: HostingTarget) => void
  onCancel?: () => void
}) {
  const [form, setForm] = React.useState({
    label: "Hostinger",
    protocol: "sftp" as Protocol,
    host: "",
    port: 22,
    username: "",
    password: "",
    privateKey: "",
    passphrase: "",
    remoteBaseDir: "/public_html",
    siteUrl: "",
  })
  const [useKey, setUseKey] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const { target } = await hostingService.createTarget({
        label: form.label,
        protocol: form.protocol,
        host: form.host.trim(),
        port: Number(form.port) || (form.protocol === "sftp" ? 22 : 21),
        username: form.username.trim(),
        password: useKey ? undefined : form.password,
        privateKey: useKey ? form.privateKey : undefined,
        passphrase: useKey ? form.passphrase : undefined,
        remoteBaseDir: form.remoteBaseDir.trim(),
        siteUrl: form.siteUrl.trim() || null,
      })
      toast.success("Hostinger conectado")
      onConnected(target)
    } catch (e) {
      toast.error((e as Error).message || "No se pudo conectar (revisa credenciales)")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <h3 className="text-[15px] font-semibold">Conectar Hostinger</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Nombre">
          <Input value={form.label} onChange={(e) => set({ label: e.target.value })} className="h-8 text-sm" />
        </Field>
        <Field label="Protocolo">
          <select value={form.protocol} onChange={(e) => set({ protocol: e.target.value as Protocol, port: e.target.value === "sftp" ? 22 : 21 })} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm">
            {PROTOCOLS.map((p) => (
              <option key={p} value={p}>
                {p.toUpperCase()}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Host">
          <Input value={form.host} onChange={(e) => set({ host: e.target.value })} placeholder="123.45.67.89 / ftp.tudominio.com" className="h-8 text-sm" />
        </Field>
        <Field label="Puerto">
          <Input type="number" value={form.port} onChange={(e) => set({ port: Number(e.target.value) })} className="h-8 text-sm" />
        </Field>
        <Field label="Usuario">
          <Input value={form.username} onChange={(e) => set({ username: e.target.value })} className="h-8 text-sm" />
        </Field>
        <Field label="Directorio remoto">
          <Input value={form.remoteBaseDir} onChange={(e) => set({ remoteBaseDir: e.target.value })} className="h-8 text-sm" />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={useKey} onChange={(e) => setUseKey(e.target.checked)} />
        Usar clave SSH en vez de contraseña
      </label>
      {useKey ? (
        <>
          <Field label="Clave privada (SSH)">
            <textarea value={form.privateKey} onChange={(e) => set({ privateKey: e.target.value })} rows={3} className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs" placeholder="Pega tu clave privada SSH (formato OpenSSH/PEM)" />
          </Field>
          <Field label="Passphrase (opcional)">
            <Input type="password" value={form.passphrase} onChange={(e) => set({ passphrase: e.target.value })} className="h-8 text-sm" />
          </Field>
        </>
      ) : (
        <Field label="Contraseña">
          <Input type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} className="h-8 text-sm" />
        </Field>
      )}
      <Field label="URL del sitio (live URL)">
        <Input value={form.siteUrl} onChange={(e) => set({ siteUrl: e.target.value })} placeholder="https://tudominio.com" className="h-8 text-sm" />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !form.host || !form.username}>
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Plug className="mr-1 h-3.5 w-3.5" />}
          Probar y guardar
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Las credenciales se cifran en el servidor (AES-256) y nunca se devuelven.</p>
    </form>
  )
}
