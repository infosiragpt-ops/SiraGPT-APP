"use client"

import * as React from "react"
import {
  ChevronRight,
  Link2,
  Loader2,
  Mail,
  PackageOpen,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  UsersRound,
  Wallet,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { AgentDepartmentDefinition } from "@/lib/code-agent-company"
import type {
  CompanySocialOperations,
  CompanySocialPlatform,
  CompanySocialProvider,
} from "@/lib/company-social-api"
import type { CoworkConnector } from "@/lib/cowork-api"
import { cn } from "@/lib/utils"

type ResourceKind = "social" | "connector" | "catalog"

export type CompanyResourceItem = {
  key: string
  kind: ResourceKind
  id: string
  name: string
  description: string
  category: "social" | "productivity" | "development" | "business" | "email"
  domain: string
  authType: string
  status: "active" | "attention" | "available" | "browser" | "coming_soon"
  statusLabel: string
  toolsHint?: string
  connected: boolean
  pinnedToAgent?: boolean
  canConnect: boolean
  localIcon?: string
  platform?: CompanySocialPlatform
  connector?: CoworkConnector
  provider?: CompanySocialProvider
}

const RESOURCE_ASSIGNMENTS_KEY = "code-workspace:resource-dept-assignments:v1"
const RESOURCE_PINS_KEY = "code-workspace:resource-agent-pins:v1"

const CATALOG: Array<{
  id: string
  name: string
  description: string
  category: CompanyResourceItem["category"]
  domain: string
  authType: string
  localIcon?: string
  socialPlatform?: CompanySocialPlatform
  connectorId?: string
}> = [
  {
    id: "reddit",
    name: "Reddit",
    description: "Comunidades, threads y señales de mercado.",
    category: "social",
    domain: "reddit.com",
    authType: "OAuth",
  },
  {
    id: "youtube",
    name: "YouTube",
    description: "Canal, analytics y publicación de video.",
    category: "social",
    domain: "youtube.com",
    authType: "OAuth2",
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Correo operativo de la empresa.",
    category: "email",
    domain: "gmail.com",
    authType: "OAuth2",
    localIcon: "/icons/google-g.png",
    connectorId: "gmail",
  },
  {
    id: "x",
    name: "Twitter / X",
    description: "Publicación y respuesta en tiempo real.",
    category: "social",
    domain: "x.com",
    authType: "OAuth2",
    socialPlatform: "x",
  },
  {
    id: "xiaohongshu",
    name: "Xiaohongshu",
    description: "Cuenta de navegador disponible para el agente.",
    category: "social",
    domain: "xiaohongshu.com",
    authType: "Navegador",
  },
  {
    id: "hacker-news",
    name: "Hacker News",
    description: "Noticias tech y señales de producto.",
    category: "social",
    domain: "news.ycombinator.com",
    authType: "Sin autenticación",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    description: "Red profesional y outreach B2B.",
    category: "social",
    domain: "linkedin.com",
    authType: "OAuth",
    socialPlatform: "linkedin",
  },
  {
    id: "facebook",
    name: "Facebook",
    description: "Páginas, anuncios y comunidad.",
    category: "social",
    domain: "facebook.com",
    authType: "OAuth",
    socialPlatform: "facebook",
  },
  {
    id: "instagram",
    name: "Instagram",
    description: "Contenido visual y engagement.",
    category: "social",
    domain: "instagram.com",
    authType: "OAuth",
  },
  {
    id: "tiktok",
    name: "TikTok",
    description: "Short-form video y distribución.",
    category: "social",
    domain: "tiktok.com",
    authType: "OAuth",
  },
  {
    id: "google_drive",
    name: "Google Drive",
    description: "Archivos y carpetas de la empresa.",
    category: "productivity",
    domain: "drive.google.com",
    authType: "OAuth2",
    localIcon: "/icons/google-drive.png",
    connectorId: "google_drive",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "Agenda y coordinación operativa.",
    category: "productivity",
    domain: "calendar.google.com",
    authType: "OAuth2",
    localIcon: "/icons/google-calendar.png",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Base de conocimiento y wikis.",
    category: "productivity",
    domain: "notion.so",
    authType: "OAuth",
    connectorId: "notion",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Comunicación interna del equipo.",
    category: "productivity",
    domain: "slack.com",
    authType: "OAuth",
    connectorId: "slack",
  },
]

const CATEGORY_META: Record<
  CompanyResourceItem["category"] | "all",
  { label: string; countBias?: number }
> = {
  all: { label: "Todas" },
  social: { label: "Redes sociales", countBias: 5 },
  productivity: { label: "Productividad", countBias: 159 },
  development: { label: "Desarrollo y datos", countBias: 375 },
  business: { label: "Negocios y utilidades", countBias: 508 },
  email: { label: "Correo", countBias: 12 },
}

function storageKey(base: string, workspaceId: string | null | undefined) {
  return `${base}:${workspaceId || "__default__"}`
}

function readMap(key: string): Record<string, string> {
  if (typeof window === "undefined") return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeMap(key: string, value: Record<string, string>) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

function readIdList(key: string): string[] {
  if (typeof window === "undefined") return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]")
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.map((v) => String(v || "").trim()).filter(Boolean))]
  } catch {
    return []
  }
}

function writeIdList(key: string, values: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...new Set(values.filter(Boolean))]))
  } catch {
    /* ignore */
  }
}

function brandLogoUrl(domain: string, size = 128) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`
}

function BrandLogo({
  name,
  domain,
  localIcon,
  size = 36,
  className,
}: {
  name: string
  domain: string
  localIcon?: string
  size?: number
  className?: string
}) {
  const [failed, setFailed] = React.useState(false)
  const src = !failed && localIcon
    ? localIcon
    : brandLogoUrl(domain, Math.max(64, size * 2))

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/10 dark:bg-zinc-950",
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        width={size - 8}
        height={size - 8}
        className="h-[70%] w-[70%] object-contain"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => {
          if (!failed && localIcon) setFailed(true)
        }}
      />
      <span className="sr-only">{name}</span>
    </span>
  )
}

function buildResourceItems(
  operations: CompanySocialOperations,
  connectors: CoworkConnector[],
  pinnedKeys: Set<string>,
): CompanyResourceItem[] {
  const byKey = new Map<string, CompanyResourceItem>()

  for (const provider of operations.providers) {
    const catalog = CATALOG.find((row) => row.socialPlatform === provider.platform)
    const key = `social:${provider.platform}`
    const connected = Boolean(provider.connection?.connected)
    byKey.set(key, {
      key,
      kind: "social",
      id: provider.platform,
      name: provider.label,
      description: connected
        ? provider.connection?.accountName || "Cuenta conectada"
        : provider.configured
          ? "Disponible para conectar con OAuth"
          : "Credenciales del servidor pendientes",
      category: "social",
      domain: catalog?.domain || `${provider.platform}.com`,
      authType: "OAuth2",
      status: connected ? "active" : provider.configured ? "available" : "attention",
      statusLabel: connected ? "Activo" : provider.configured ? "Añadir" : "Configurar",
      toolsHint: connected
        ? `${Math.max(12, provider.scopes?.length || 0) * 7} herramientas · OAuth2`
        : undefined,
      connected,
      pinnedToAgent: pinnedKeys.has(key),
      canConnect: provider.configured || connected,
      localIcon: catalog?.localIcon,
      platform: provider.platform,
      provider,
    })
  }

  for (const connector of connectors) {
    const catalog = CATALOG.find((row) => row.connectorId === connector.id)
    const key = `connector:${connector.id}`
    const connected = connector.account?.status === "connected"
    const category: CompanyResourceItem["category"] =
      catalog?.category
      || (connector.category === "communication" ? "email" : connector.category === "files" ? "productivity" : "business")
    byKey.set(key, {
      key,
      kind: "connector",
      id: connector.id,
      name: connector.name,
      description: connected
        ? connector.account?.accountLabel || "Cuenta conectada"
        : `${connector.capabilities.length || 0} capacidades · ${connector.authType || "OAuth"}`,
      category,
      domain: catalog?.domain || `${connector.id.replace(/_/g, "")}.com`,
      authType: connector.authType || "OAuth",
      status: connected ? "active" : "available",
      statusLabel: connected ? "Activo" : "Añadir",
      toolsHint: connected
        ? `${Math.max(8, connector.account?.scopes?.length || connector.capabilities.length || 1) * 9} herramientas · ${connector.authType || "OAuth"}`
        : undefined,
      connected,
      pinnedToAgent: pinnedKeys.has(key),
      canConnect: true,
      localIcon: catalog?.localIcon,
      connector,
    })
  }

  for (const entry of CATALOG) {
    const socialKey = entry.socialPlatform ? `social:${entry.socialPlatform}` : null
    const connectorKey = entry.connectorId ? `connector:${entry.connectorId}` : null
    if ((socialKey && byKey.has(socialKey)) || (connectorKey && byKey.has(connectorKey))) continue
    const key = `catalog:${entry.id}`
    byKey.set(key, {
      key,
      kind: "catalog",
      id: entry.id,
      name: entry.name,
      description: entry.description,
      category: entry.category,
      domain: entry.domain,
      authType: entry.authType,
      status: entry.authType.toLowerCase().includes("navegador")
        ? "browser"
        : entry.authType.toLowerCase().includes("sin autentic")
          ? "available"
          : "coming_soon",
      statusLabel: entry.authType.toLowerCase().includes("navegador")
        ? "Abrir"
        : entry.authType.toLowerCase().includes("sin autentic")
          ? "Añadir"
          : "Añadir",
      connected: false,
      pinnedToAgent: pinnedKeys.has(key),
      canConnect: Boolean(entry.socialPlatform || entry.connectorId),
      localIcon: entry.localIcon,
      platform: entry.socialPlatform,
    })
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1
    if (Boolean(a.pinnedToAgent) !== Boolean(b.pinnedToAgent)) return a.pinnedToAgent ? -1 : 1
    return a.name.localeCompare(b.name, "es")
  })
}

function defaultDepartmentForResource(
  item: CompanyResourceItem,
  departments: readonly AgentDepartmentDefinition[],
): string | null {
  const marketing = departments.find((d) => /market|marketing|growth|ventas|sales|customer|cliente/i.test(`${d.id} ${d.name}`))
  const product = departments.find((d) => /product|engineering|ingenier/i.test(`${d.id} ${d.name}`))
  const ceo = departments.find((d) => d.id === "ceo-office") || departments[0] || null
  if (item.category === "social" || item.category === "email") return marketing?.id || ceo?.id || null
  if (item.category === "development") return product?.id || ceo?.id || null
  return ceo?.id || marketing?.id || null
}

export function CompanyResourcesSurface({
  companyName,
  workspaceId,
  departments,
  operations,
  businessConnectors,
  loading,
  providerBusy,
  connectorBusy,
  onRefresh,
  onConnectSocial,
  onDisconnectSocial,
  onConnectConnector,
  onDisconnectConnector,
  onOpenCeo,
}: {
  companyName: string
  workspaceId: string | null
  departments: readonly AgentDepartmentDefinition[]
  operations: CompanySocialOperations
  businessConnectors: CoworkConnector[]
  loading: boolean
  providerBusy: CompanySocialPlatform | null
  connectorBusy: string | null
  onRefresh: () => void
  onConnectSocial: (platform: CompanySocialPlatform) => void
  onDisconnectSocial: (platform: CompanySocialPlatform) => void
  onConnectConnector: (connector: CoworkConnector) => void
  onDisconnectConnector: (connector: CoworkConnector) => void
  onOpenCeo: () => void
}) {
  const [query, setQuery] = React.useState("")
  const [category, setCategory] = React.useState<"all" | CompanyResourceItem["category"]>("all")
  const [assignments, setAssignments] = React.useState<Record<string, string>>({})
  const [pinnedKeys, setPinnedKeys] = React.useState<string[]>([])

  React.useEffect(() => {
    setAssignments(readMap(storageKey(RESOURCE_ASSIGNMENTS_KEY, workspaceId)))
    setPinnedKeys(readIdList(storageKey(RESOURCE_PINS_KEY, workspaceId)))
  }, [workspaceId])

  const pinSet = React.useMemo(() => new Set(pinnedKeys), [pinnedKeys])
  const items = React.useMemo(
    () => buildResourceItems(operations, businessConnectors, pinSet),
    [businessConnectors, operations, pinSet],
  )

  const connectedItems = items.filter((item) => item.connected)
  const emailConnected = connectedItems.filter((item) => item.category === "email" || item.id === "gmail")
  const appsConnected = connectedItems.filter((item) => item.category !== "email" || item.id !== "gmail")
  const pinnedCount = items.filter((item) => item.pinnedToAgent).length

  const filtered = items.filter((item) => {
    if (category !== "all" && item.category !== category) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return `${item.name} ${item.description} ${item.authType}`.toLowerCase().includes(q)
  })

  const workspaceItems = filtered.filter((item) => item.connected || item.pinnedToAgent)
  const catalogItems = filtered.filter((item) => !item.connected)

  const departmentById = React.useMemo(() => {
    const map = new Map(departments.map((department) => [department.id, department]))
    return map
  }, [departments])

  const assignResource = React.useCallback((resourceKey: string, departmentId: string) => {
    setAssignments((current) => {
      const next = { ...current, [resourceKey]: departmentId }
      writeMap(storageKey(RESOURCE_ASSIGNMENTS_KEY, workspaceId), next)
      return next
    })
  }, [workspaceId])

  const togglePin = React.useCallback((resourceKey: string) => {
    setPinnedKeys((current) => {
      const exists = current.includes(resourceKey)
      const next = exists ? current.filter((id) => id !== resourceKey) : [resourceKey, ...current]
      writeIdList(storageKey(RESOURCE_PINS_KEY, workspaceId), next)
      return next
    })
  }, [workspaceId])

  const handlePrimary = React.useCallback((item: CompanyResourceItem) => {
    if (item.kind === "social" && item.platform) {
      if (item.connected) onDisconnectSocial(item.platform)
      else if (item.canConnect) onConnectSocial(item.platform)
      return
    }
    if (item.kind === "connector" && item.connector) {
      if (item.connected) onDisconnectConnector(item.connector)
      else onConnectConnector(item.connector)
      return
    }
    if (item.platform && item.canConnect) {
      onConnectSocial(item.platform)
      return
    }
    if (item.status === "browser") {
      window.open(`https://${item.domain}`, "_blank", "noopener,noreferrer")
    }
  }, [onConnectConnector, onConnectSocial, onDisconnectConnector, onDisconnectSocial])

  React.useEffect(() => {
    // Auto-assign connected resources to a sensible department the first time.
    let changed = false
    const next = { ...assignments }
    for (const item of connectedItems) {
      if (next[item.key]) continue
      const deptId = defaultDepartmentForResource(item, departments)
      if (!deptId) continue
      next[item.key] = deptId
      changed = true
    }
    if (changed) {
      setAssignments(next)
      writeMap(storageKey(RESOURCE_ASSIGNMENTS_KEY, workspaceId), next)
    }
  }, [assignments, connectedItems, departments, workspaceId])

  const categoryCounts = React.useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of items) {
      counts[item.category] = (counts[item.category] || 0) + 1
    }
    return counts
  }, [items])

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 pb-10 pt-6 sm:px-6 lg:px-8" data-testid="company-resources-surface">
      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-serif text-[34px] font-medium tracking-tight text-zinc-950 dark:text-zinc-50 sm:text-[40px]">
              Activos de la empresa agente
            </h1>
            <p className="mt-2 text-sm text-zinc-500">
              {companyName} · {connectedItems.length} conectada{connectedItems.length === 1 ? "" : "s"}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-full border-zinc-200 bg-white px-4 dark:border-white/10 dark:bg-zinc-950"
            onClick={onRefresh}
            disabled={loading}
          >
            <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
            Actualizar
          </Button>
        </div>

        <div className="mt-5 grid gap-2 rounded-2xl border border-zinc-200/80 bg-white/90 p-2 shadow-[0_10px_40px_-28px_rgba(15,23,42,0.45)] dark:border-white/10 dark:bg-zinc-950/80 sm:grid-cols-2 xl:grid-cols-5">
          {[
            {
              label: "Email",
              value: emailConnected.length > 0 ? "Solo personales" : "Sin conectar",
              icon: Mail,
              tone: emailConnected.length > 0 ? "ok" : "muted",
            },
            {
              label: "Apps & Integrations",
              value: `${appsConnected.length || connectedItems.length} conectadas`,
              icon: PackageOpen,
              tone: "ok",
            },
            {
              label: "Wallet",
              value: "Listo",
              icon: Wallet,
              tone: "ok",
            },
            {
              label: "Revenue",
              value: "Guía",
              icon: Sparkles,
              tone: "ok",
            },
            {
              label: "Characters",
              value: "None yet",
              icon: UsersRound,
              tone: "muted",
            },
          ].map(({ label, value, icon: Icon, tone }) => (
            <div
              key={label}
              className="flex min-h-[64px] items-center gap-3 rounded-xl px-3 py-2"
            >
              <span className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full",
                tone === "ok" ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400",
              )}>
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] font-medium text-zinc-500">{label}</span>
                <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{value}</span>
              </span>
            </div>
          ))}
        </div>
      </header>

      <section className="mb-4 overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-[0_12px_40px_-30px_rgba(15,23,42,0.35)] dark:border-white/10 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-4 py-4 dark:border-white/5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-50 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
              <UsersRound className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Character assets</h2>
              <p className="text-xs text-zinc-500">No reusable people yet</p>
            </div>
          </div>
          <Button type="button" variant="outline" className="h-9 rounded-full px-3 text-xs" onClick={onOpenCeo}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            Register face
          </Button>
        </div>
        <div className="flex min-h-[72px] items-center gap-3 px-4 py-4 text-sm text-zinc-500">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-50 dark:bg-zinc-900">
            <UsersRound className="h-4 w-4" />
          </span>
          <div>
            <p className="font-medium text-zinc-700 dark:text-zinc-200">No character assets</p>
            <p className="text-xs text-zinc-500">Saved people appear here after registration.</p>
          </div>
        </div>
      </section>

      <section className="mb-4 overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-[0_12px_40px_-30px_rgba(15,23,42,0.35)] dark:border-white/10 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-4 py-4 dark:border-white/5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-50 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
              <Mail className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Correo</h2>
              <p className="text-xs text-zinc-500">
                {Math.max(emailConnected.length, 0)} dirección{emailConnected.length === 1 ? "" : "es"} de email
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-full px-3 text-xs"
              onClick={() => {
                const gmail = items.find((item) => item.id === "gmail")
                if (gmail) handlePrimary(gmail)
              }}
            >
              <Link2 className="mr-1.5 h-3.5 w-3.5" />
              Conectar mi email
              <BrandLogo name="Gmail" domain="gmail.com" localIcon="/icons/google-g.png" size={18} className="ml-2 rounded-md" />
            </Button>
            <Button type="button" variant="outline" className="h-9 rounded-full px-3 text-xs" onClick={onOpenCeo}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Crear email de Matrix
            </Button>
          </div>
        </div>
        {(emailConnected.length ? emailConnected : items.filter((item) => item.id === "gmail")).slice(0, 3).map((item) => {
          const deptId = assignments[item.key] || defaultDepartmentForResource(item, departments)
          const dept = deptId ? departmentById.get(deptId) : null
          const busy = item.platform
            ? providerBusy === item.platform
            : item.connector
              ? connectorBusy === item.connector.id
              : false
          return (
            <div key={item.key} className="flex min-h-[64px] items-center gap-3 border-b border-zinc-100 px-4 py-3 last:border-b-0 dark:border-white/5">
              <BrandLogo name={item.name} domain={item.domain} localIcon={item.localIcon} size={34} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{item.name}</span>
                  {dept ? (
                    <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">
                      Gestiona: {dept.name}
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 truncate text-xs text-zinc-500">{item.description}</p>
              </div>
              <span className="text-xs font-medium text-zinc-500">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : item.connected ? "Conectado" : "Disponible"}
              </span>
            </div>
          )
        })}
      </section>

      <section className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-[0_12px_40px_-30px_rgba(15,23,42,0.35)] dark:border-white/10 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 px-4 py-4 dark:border-white/5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-300">
              <PackageOpen className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Apps e integraciones</h2>
              <p className="text-xs text-zinc-500">
                {connectedItems.length} conectadas
                {pinnedCount > 0 ? ` · ${pinnedCount} fijada${pinnedCount === 1 ? "" : "s"} al agente` : ""}
              </p>
            </div>
          </div>
          <div className="relative w-full max-w-[320px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar apps e integraciones"
              className="h-10 rounded-full border-zinc-200 bg-zinc-50/80 pl-9 text-sm dark:border-white/10 dark:bg-zinc-900"
            />
          </div>
        </div>

        <div className="space-y-5 px-4 py-4">
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              This workspace
            </p>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {(workspaceItems.length ? workspaceItems : connectedItems).map((item) => (
                <ResourceCard
                  key={item.key}
                  item={item}
                  departments={departments}
                  departmentId={assignments[item.key] || defaultDepartmentForResource(item, departments)}
                  busy={
                    item.platform
                      ? providerBusy === item.platform
                      : item.connector
                        ? connectorBusy === item.connector.id
                        : false
                  }
                  onPrimary={() => handlePrimary(item)}
                  onTogglePin={() => togglePin(item.key)}
                  onAssign={(departmentId) => assignResource(item.key, departmentId)}
                />
              ))}
              {workspaceItems.length === 0 && connectedItems.length === 0 ? (
                <div className="col-span-full rounded-2xl border border-dashed border-zinc-200 px-4 py-8 text-center text-sm text-zinc-500 dark:border-white/10">
                  Conecta Gmail, LinkedIn, X u otra app para que Marketing y el resto de departamentos la gestionen.
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {([
              ["all", "Todas"],
              ["social", "Redes sociales"],
              ["productivity", "Productividad"],
              ["development", "Desarrollo y datos"],
              ["business", "Negocios y utilidades"],
            ] as const).map(([id, label]) => {
              const count = id === "all"
                ? items.length
                : (categoryCounts[id] || 0) + (CATEGORY_META[id].countBias || 0)
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCategory(id)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                    category === id
                      ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-950"
                      : "border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300",
                  )}
                >
                  {label}
                  <span className="tabular-nums opacity-70">{count}</span>
                </button>
              )
            })}
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {catalogItems.map((item) => (
              <ResourceCard
                key={item.key}
                item={item}
                departments={departments}
                departmentId={assignments[item.key] || defaultDepartmentForResource(item, departments)}
                busy={
                  item.platform
                    ? providerBusy === item.platform
                    : item.connector
                      ? connectorBusy === item.connector.id
                      : false
                }
                onPrimary={() => handlePrimary(item)}
                onTogglePin={() => togglePin(item.key)}
                onAssign={(departmentId) => assignResource(item.key, departmentId)}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

function ResourceCard({
  item,
  departments,
  departmentId,
  busy,
  onPrimary,
  onTogglePin,
  onAssign,
}: {
  item: CompanyResourceItem
  departments: readonly AgentDepartmentDefinition[]
  departmentId: string | null
  busy: boolean
  onPrimary: () => void
  onTogglePin: () => void
  onAssign: (departmentId: string) => void
}) {
  const department = departmentId
    ? departments.find((entry) => entry.id === departmentId) || null
    : null

  return (
    <article className="group flex min-h-[92px] flex-col justify-between rounded-2xl border border-zinc-200/80 bg-zinc-50/40 p-3.5 transition-colors hover:bg-white hover:shadow-[0_10px_30px_-24px_rgba(15,23,42,0.45)] dark:border-white/10 dark:bg-zinc-900/40 dark:hover:bg-zinc-900">
      <div className="flex items-start gap-3">
        <BrandLogo name={item.name} domain={item.domain} localIcon={item.localIcon} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">{item.name}</h3>
                {item.connected ? (
                  <span className="text-[10px] font-semibold text-zinc-400">✦</span>
                ) : (
                  <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800">
                    {item.authType}
                  </span>
                )}
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-zinc-500">
                {item.connected && item.toolsHint
                  ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        item.status === "attention" ? "bg-amber-500" : "bg-emerald-500",
                      )} />
                      {item.status === "attention" ? "Requiere atención" : item.toolsHint}
                    </span>
                  )
                  : item.description}
              </p>
            </div>
            <button
              type="button"
              onClick={onTogglePin}
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200",
                item.pinnedToAgent && "text-sky-600",
              )}
              aria-label={item.pinnedToAgent ? "Quitar del agente" : "Fijar al agente"}
              title={item.pinnedToAgent ? "Quitar del agente" : "Fijar al agente"}
            >
              <Pin className={cn("h-3.5 w-3.5", item.pinnedToAgent && "fill-sky-500/20")} />
            </button>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Departamento gestor</span>
          <select
            value={departmentId || ""}
            onChange={(event) => {
              if (event.target.value) onAssign(event.target.value)
            }}
            className="h-8 w-full max-w-[180px] truncate rounded-full border border-zinc-200 bg-white px-2.5 text-[11px] font-medium text-zinc-600 outline-none focus:ring-2 focus:ring-zinc-900/10 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-300"
          >
            <option value="" disabled>
              Asignar departamento
            </option>
            {departments.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={onPrimary}
          disabled={busy || (!item.canConnect && item.status === "coming_soon" && item.kind === "catalog" && !item.platform && !item.connector)}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-xs font-semibold transition-colors disabled:opacity-50",
            item.connected
              ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300"
              : item.status === "attention"
                ? "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100"
                : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-200",
          )}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <>
              {item.connected
                ? item.status === "attention"
                  ? "Check"
                  : "Activo"
                : item.statusLabel}
              <ChevronRight className="h-3.5 w-3.5 opacity-60" />
            </>
          )}
        </button>
      </div>

      {department ? (
        <p className="mt-2 text-[10px] text-zinc-400">
          {department.name} gestiona este recurso para la empresa.
        </p>
      ) : null}
    </article>
  )
}

export default CompanyResourcesSurface
