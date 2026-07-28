"use client"

import * as React from "react"
import {
  ChevronRight,
  CheckCircle2,
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
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { AgentDepartmentDefinition } from "@/lib/code-agent-company"
import type {
  CompanySocialOperations,
  CompanySocialPlatform,
  CompanySocialProvider,
} from "@/lib/company-social-api"
import { isCompanyResourceActive } from "@/lib/company-resource-access"
import {
  companySocialResourceIdentityKey,
  companySocialResourceKey,
  isLegacyCompanySocialResourceKey,
} from "@/lib/company-resource-keys"
import type { CoworkConnector } from "@/lib/cowork-api"
import {
  codexApi,
  type CodexCompanyResourceState,
} from "@/lib/codex/codex-api"
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
  availableToCompany?: boolean
  assignable: boolean
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
    localIcon: "/icons/gmail.svg",
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

function storageKey(
  base: string,
  workspaceId: string | null | undefined,
  ownerId: string | null | undefined,
) {
  return `${base}:${ownerId || "__anonymous__"}:${workspaceId || "__default__"}`
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

function localResourceState(
  workspaceId: string | null | undefined,
  ownerId: string | null | undefined,
): CodexCompanyResourceState {
  return {
    assignments: readMap(storageKey(RESOURCE_ASSIGNMENTS_KEY, workspaceId, ownerId)),
    pinned: readIdList(storageKey(RESOURCE_PINS_KEY, workspaceId, ownerId)),
    revision: 0,
  }
}

function writeLocalResourceState(
  workspaceId: string | null | undefined,
  ownerId: string | null | undefined,
  state: CodexCompanyResourceState,
) {
  writeMap(storageKey(RESOURCE_ASSIGNMENTS_KEY, workspaceId, ownerId), state.assignments)
  writeIdList(storageKey(RESOURCE_PINS_KEY, workspaceId, ownerId), state.pinned)
}

function clearLocalResourceState(
  workspaceId: string | null | undefined,
  ownerId: string | null | undefined,
) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(storageKey(RESOURCE_ASSIGNMENTS_KEY, workspaceId, ownerId))
    window.localStorage.removeItem(storageKey(RESOURCE_PINS_KEY, workspaceId, ownerId))
  } catch {
    /* ignore */
  }
}

function hasResourceState(state: CodexCompanyResourceState) {
  return Object.keys(state.assignments).length > 0 || state.pinned.length > 0
}

function withoutLegacySocialResources(
  state: CodexCompanyResourceState,
): CodexCompanyResourceState {
  return {
    assignments: Object.fromEntries(
      Object.entries(state.assignments)
        .filter(([resourceKey]) => !isLegacyCompanySocialResourceKey(resourceKey)),
    ),
    pinned: state.pinned
      .filter((resourceKey) => !isLegacyCompanySocialResourceKey(resourceKey)),
    revision: state.revision,
  }
}

function mergeResourceStates(
  local: CodexCompanyResourceState,
  durable: CodexCompanyResourceState,
): CodexCompanyResourceState {
  const safeLocal = withoutLegacySocialResources(local)
  const safeDurable = withoutLegacySocialResources(durable)
  return {
    assignments: { ...safeLocal.assignments, ...safeDurable.assignments },
    pinned: [...new Set(
      [...safeDurable.pinned, ...safeLocal.pinned],
    )],
    revision: durable.revision,
  }
}

function sameResourceState(
  left: CodexCompanyResourceState,
  right: CodexCompanyResourceState,
) {
  if (left.pinned.length !== right.pinned.length) return false
  if (left.pinned.some((key) => !right.pinned.includes(key))) return false
  const leftEntries = Object.entries(left.assignments)
  const rightEntries = Object.entries(right.assignments)
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value]) => right.assignments[key] === value)
}

type CompanyResourceWriteError = Error & {
  resourceStateUnknown?: boolean
  currentResources?: CodexCompanyResourceState
}

function isAmbiguousResourceWriteError(error: unknown) {
  const status = Number((error as { status?: number } | null)?.status || 0)
  return status === 0 || status === 409 || status >= 500
}

async function persistCompanyResourcesConfirmed(
  codexProjectId: string,
  desired: CodexCompanyResourceState,
  rebase: (current: CodexCompanyResourceState) => CodexCompanyResourceState,
): Promise<CodexCompanyResourceState> {
  try {
    return await codexApi.updateCompanyResources(codexProjectId, desired)
  } catch (firstError) {
    if (!isAmbiguousResourceWriteError(firstError)) throw firstError

    let current: CodexCompanyResourceState
    try {
      current = await codexApi.getCompanyResources(codexProjectId)
    } catch {
      throw Object.assign(
        new Error("No se pudo confirmar si el servidor guardó el cambio. Se bloqueó la edición para evitar una reversión insegura."),
        { resourceStateUnknown: true },
      ) as CompanyResourceWriteError
    }
    if (sameResourceState(current, desired)) return current

    const rebased = rebase(current)
    if (sameResourceState(current, rebased)) return current
    try {
      return await codexApi.updateCompanyResources(codexProjectId, rebased)
    } catch (retryError) {
      if (!isAmbiguousResourceWriteError(retryError)) {
        throw Object.assign(retryError as object, {
          currentResources: current,
        }) as CompanyResourceWriteError
      }
      let finalState: CodexCompanyResourceState
      try {
        finalState = await codexApi.getCompanyResources(codexProjectId)
      } catch {
        throw Object.assign(
          new Error("No se pudo confirmar el estado final del recurso. No se revirtió el conector para evitar pérdida de acceso."),
          { resourceStateUnknown: true },
        ) as CompanyResourceWriteError
      }
      if (sameResourceState(finalState, rebased)) return finalState
      throw Object.assign(retryError as object, {
        currentResources: finalState,
      }) as CompanyResourceWriteError
    }
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
  availableConnectorAccountIds: ReadonlySet<string>,
): CompanyResourceItem[] {
  const byKey = new Map<string, CompanyResourceItem>()
  const renderedSocialPlatforms = new Set<CompanySocialPlatform>()

  for (const provider of operations.providers) {
    const catalog = CATALOG.find((row) => row.socialPlatform === provider.platform)
    const connected = Boolean(provider.connection?.connected)
    const grantKey = companySocialResourceKey(provider)
    const key = companySocialResourceIdentityKey(
      provider.platform,
      provider.connection,
    ) || `catalog:social-${provider.platform}`
    renderedSocialPlatforms.add(provider.platform)
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
        ? `${provider.scopes?.length || 0} permiso${provider.scopes?.length === 1 ? "" : "s"} · OAuth2`
        : undefined,
      connected,
      assignable: Boolean(grantKey),
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
    const durableAccount = Boolean(
      connector.account?.id
      && !connector.account.id.startsWith("legacy:"),
    )
    const connected = connector.account?.status === "connected" && durableAccount
    const availableToCompany = Boolean(
      durableAccount
      && connector.account?.id
      && availableConnectorAccountIds.has(connector.account.id),
    )
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
      status: connected
        ? availableToCompany ? "active" : "available"
        : availableToCompany ? "attention" : "available",
      statusLabel: connected
        ? availableToCompany ? "Activo" : "Habilitar"
        : durableAccount ? "Reconectar" : "Conectar",
      toolsHint: connected
        ? `${connector.account?.scopes?.length || connector.capabilities.length || 0} capacidad${(connector.account?.scopes?.length || connector.capabilities.length) === 1 ? "" : "es"} · ${connector.authType || "OAuth"}`
        : undefined,
      connected,
      availableToCompany,
      assignable: connected,
      pinnedToAgent: pinnedKeys.has(key),
      canConnect: true,
      localIcon: catalog?.localIcon,
      connector,
    })
  }

  for (const entry of CATALOG) {
    const connectorKey = entry.connectorId ? `connector:${entry.connectorId}` : null
    if (
      (entry.socialPlatform && renderedSocialPlatforms.has(entry.socialPlatform))
      || (connectorKey && byKey.has(connectorKey))
    ) continue
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
        || entry.authType.toLowerCase().includes("sin autentic")
        ? "browser"
        : "coming_soon",
      statusLabel: entry.authType.toLowerCase().includes("navegador")
        || entry.authType.toLowerCase().includes("sin autentic")
        ? "Abrir"
        : "Próximamente",
      connected: false,
      assignable: entry.authType.toLowerCase().includes("navegador")
        || entry.authType.toLowerCase().includes("sin autentic"),
      pinnedToAgent: pinnedKeys.has(key),
      canConnect: Boolean(
        entry.socialPlatform
        || entry.authType.toLowerCase().includes("navegador")
        || entry.authType.toLowerCase().includes("sin autentic"),
      ),
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
  const marketing = departments.find((d) => d.id === "marketing")
  const product = departments.find((d) => /product|engineering|ingenier/i.test(`${d.id} ${d.name}`))
  const ceo = departments.find((d) => d.id === "ceo-office") || departments[0] || null
  if (item.category === "social" || item.category === "email") return marketing?.id || ceo?.id || null
  if (item.category === "development") return product?.id || ceo?.id || null
  return ceo?.id || marketing?.id || null
}

function connectorAccountIdForCompany(item: CompanyResourceItem): string | null {
  const accountId = item.connector?.account?.id
  return accountId && !accountId.startsWith("legacy:") ? accountId : null
}

function isResourceActiveForCompany(
  item: CompanyResourceItem,
  assignedToCompany: boolean,
): boolean {
  return isCompanyResourceActive({
    assignedToDepartment: assignedToCompany,
    connected: item.connected,
    connectorResource: item.kind === "connector",
    availableToCompany: item.availableToCompany,
  })
}

export function CompanyResourcesSurface({
  companyName,
  workspaceId,
  codexProjectId,
  ownerId,
  departments,
  availableConnectorAccountIds = [],
  operations,
  businessConnectors,
  connectorsLoadError,
  loading,
  providerBusy,
  connectorBusy,
  onRefresh,
  onConnectSocial,
  onConnectConnector,
  onAssignConnectorToCompany,
  onResourceStateChange,
  onOpenCeo,
}: {
  companyName: string
  workspaceId: string | null
  codexProjectId: string | null
  ownerId?: string | null
  departments: readonly AgentDepartmentDefinition[]
  availableConnectorAccountIds?: readonly string[]
  operations: CompanySocialOperations
  businessConnectors: CoworkConnector[]
  connectorsLoadError?: string | null
  loading: boolean
  providerBusy: CompanySocialPlatform | null
  connectorBusy: string | null
  onRefresh: () => void
  onConnectSocial: (platform: CompanySocialPlatform) => void
  onConnectConnector: (connector: CoworkConnector) => void
  onAssignConnectorToCompany?: (connector: CoworkConnector) => Promise<boolean>
  onResourceStateChange?: (state: CodexCompanyResourceState) => void
  onOpenCeo: () => void
}) {
  const [query, setQuery] = React.useState("")
  const [category, setCategory] = React.useState<"all" | CompanyResourceItem["category"]>("all")
  const [assignments, setAssignments] = React.useState<Record<string, string>>({})
  const [pinnedKeys, setPinnedKeys] = React.useState<string[]>([])
  const [resourcesHydrated, setResourcesHydrated] = React.useState(false)
  const [resourcesLoadError, setResourcesLoadError] = React.useState<string | null>(null)
  const [resourceHydrationVersion, setResourceHydrationVersion] = React.useState(0)
  const [resourceActionBusy, setResourceActionBusy] = React.useState(false)
  const resourceStateRef = React.useRef<CodexCompanyResourceState>({ assignments: {}, pinned: [], revision: 0 })
  const resourceScopeRef = React.useRef("")
  const resourceActionBusyRef = React.useRef(false)
  const resourceHydrationGenerationRef = React.useRef(0)

  React.useEffect(() => {
    let cancelled = false
    const generation = ++resourceHydrationGenerationRef.current
    const scope = `${codexProjectId || "local"}:${ownerId || "anonymous"}:${workspaceId || "default"}`
    resourceScopeRef.current = scope
    setResourcesHydrated(false)
    setResourcesLoadError(null)
    resourceStateRef.current = { assignments: {}, pinned: [], revision: 0 }
    setAssignments({})
    setPinnedKeys([])
    onResourceStateChange?.({ assignments: {}, pinned: [], revision: 0 })

    const hydrate = async () => {
      try {
        let state: CodexCompanyResourceState
        if (codexProjectId) {
          const durableState = await codexApi.getCompanyResources(codexProjectId)
          if (
            cancelled
            || resourceHydrationGenerationRef.current !== generation
            || resourceScopeRef.current !== scope
          ) return
          const localState = localResourceState(workspaceId, ownerId)
          if (hasResourceState(localState)) {
            let migrationLocalState = withoutLegacySocialResources(localState)
            const invalidConnectorKeys = new Set<string>()
            const localConnectorKeys = new Set([
              ...Object.keys(migrationLocalState.assignments),
              ...migrationLocalState.pinned,
            ])
            for (const resourceKey of localConnectorKeys) {
              if (!resourceKey.startsWith("connector:")) continue
              const connectorId = resourceKey.slice("connector:".length)
              const connector = businessConnectors.find((entry) => entry.id === connectorId)
              if (!connector) {
                throw new Error(`No se pudo confirmar el conector ${connectorId}. Actualiza y reintenta.`)
              }
              const connectorAccountId = connector.account?.id
              if (!connectorAccountId || connectorAccountId.startsWith("legacy:")) {
                invalidConnectorKeys.add(resourceKey)
              }
            }
            if (invalidConnectorKeys.size > 0) {
              migrationLocalState = {
                assignments: Object.fromEntries(
                  Object.entries(migrationLocalState.assignments)
                    .filter(([resourceKey]) => !invalidConnectorKeys.has(resourceKey)),
                ),
                pinned: migrationLocalState.pinned
                  .filter((resourceKey) => !invalidConnectorKeys.has(resourceKey)),
                revision: migrationLocalState.revision,
              }
            }

            const mergedState = mergeResourceStates(migrationLocalState, durableState)
            const connectorAccounts = new Set<string>()
            for (const resourceKey of Object.keys(migrationLocalState.assignments)) {
              if (!resourceKey.startsWith("connector:")) continue
              const connectorId = resourceKey.slice("connector:".length)
              const connector = businessConnectors.find((entry) => entry.id === connectorId)
              if (!connector) {
                throw new Error(`No se pudo preparar el conector ${connectorId} para esta empresa.`)
              }
              const connectorAccountId = connector?.account?.id
              if (
                !connectorAccountId
                || connectorAccountId.startsWith("legacy:")
                || connectorAccounts.has(connectorAccountId)
              ) continue
              connectorAccounts.add(connectorAccountId)
              if (!onAssignConnectorToCompany) {
                throw new Error("No se pudo preparar el conector para esta empresa.")
              }
              await onAssignConnectorToCompany(connector)
            }
            // Availability is established first. If this CAS write fails, the
            // account remains available to the company but has no department
            // grant, so every external effect stays fail-closed.
            state = sameResourceState(mergedState, durableState)
              ? withoutLegacySocialResources(durableState)
              : await persistCompanyResourcesConfirmed(
                codexProjectId,
                mergedState,
                (current) => mergeResourceStates(migrationLocalState, current),
              )
            clearLocalResourceState(workspaceId, ownerId)
            if (!cancelled && resourceScopeRef.current === scope) {
              toast.success("Los recursos locales se migraron al entorno persistente.")
            }
          } else {
            state = withoutLegacySocialResources(durableState)
          }
        } else {
          state = withoutLegacySocialResources(localResourceState(workspaceId, ownerId))
        }
        if (
          cancelled
          || resourceHydrationGenerationRef.current !== generation
          || resourceScopeRef.current !== scope
        ) return
        resourceStateRef.current = state
        setAssignments(state.assignments)
        setPinnedKeys(state.pinned)
        onResourceStateChange?.(state)
        setResourcesHydrated(true)
      } catch (error) {
        if (
          cancelled
          || resourceHydrationGenerationRef.current !== generation
          || resourceScopeRef.current !== scope
        ) return
        const message = error instanceof Error
          ? `No se pudieron cargar los recursos de esta empresa: ${error.message}`
          : "No se pudieron cargar los recursos de esta empresa."
        setResourcesLoadError(message)
        setResourcesHydrated(false)
        toast.error(message)
      }
    }

    void hydrate()
    return () => {
      cancelled = true
    }
  }, [
    businessConnectors,
    codexProjectId,
    onAssignConnectorToCompany,
    onResourceStateChange,
    ownerId,
    resourceHydrationVersion,
    workspaceId,
  ])

  const pinSet = React.useMemo(() => new Set(pinnedKeys), [pinnedKeys])
  const availableConnectorAccountIdSet = React.useMemo(
    () => new Set(availableConnectorAccountIds),
    [availableConnectorAccountIds],
  )
  const items = React.useMemo(
    () => buildResourceItems(
      operations,
      businessConnectors,
      pinSet,
      availableConnectorAccountIdSet,
    ),
    [availableConnectorAccountIdSet, businessConnectors, operations, pinSet],
  )

  const assignedItems = items.filter((item) => Boolean(assignments[item.key]))
  const connectedItems = assignedItems.filter((item) => (
    isResourceActiveForCompany(item, true)
  ))
  const emailConnected = connectedItems.filter((item) => item.category === "email" || item.id === "gmail")
  const appsConnected = connectedItems.filter((item) => item.category !== "email" && item.id !== "gmail")
  const pinnedCount = items.filter((item) => item.pinnedToAgent).length

  const filtered = items.filter((item) => {
    if (category !== "all" && item.category !== category) return false
    const q = query.trim().toLowerCase()
    if (!q) return true
    return `${item.name} ${item.description} ${item.authType}`.toLowerCase().includes(q)
  })

  const workspaceItems = filtered.filter((item) => Boolean(assignments[item.key]) || item.pinnedToAgent)
  const catalogItems = filtered.filter((item) => !assignments[item.key] && !item.pinnedToAgent)

  const departmentById = React.useMemo(() => {
    const map = new Map(departments.map((department) => [department.id, department]))
    return map
  }, [departments])

  const commitResourceState = React.useCallback(async (
    update: (current: CodexCompanyResourceState) => CodexCompanyResourceState,
  ): Promise<CodexCompanyResourceState> => {
    const expectedScope = `${codexProjectId || "local"}:${ownerId || "anonymous"}:${workspaceId || "default"}`
    if (
      !resourcesHydrated
      || resourcesLoadError
      || resourceScopeRef.current !== expectedScope
    ) {
      throw new Error("Los recursos aún no están listos. Actualiza la vista antes de modificarla.")
    }
    const previous = resourceStateRef.current
    const next = update(previous)
    resourceStateRef.current = next
    setAssignments(next.assignments)
    setPinnedKeys(next.pinned)
    onResourceStateChange?.(next)

    try {
      const saved = codexProjectId
        ? await persistCompanyResourcesConfirmed(codexProjectId, next, update)
        : next
      if (!codexProjectId) writeLocalResourceState(workspaceId, ownerId, saved)
      if (resourceScopeRef.current === expectedScope) {
        resourceStateRef.current = saved
        setAssignments(saved.assignments)
        setPinnedKeys(saved.pinned)
        onResourceStateChange?.(saved)
      }
      return saved
    } catch (error) {
      const writeError = error instanceof Error
        ? error as CompanyResourceWriteError
        : new Error("No se pudo guardar el recurso.") as CompanyResourceWriteError
      if (resourceScopeRef.current === expectedScope) {
        if (writeError.resourceStateUnknown) {
          setResourcesHydrated(false)
          setResourcesLoadError(writeError.message)
        } else {
          const current = writeError.currentResources || previous
          writeError.currentResources = current
          resourceStateRef.current = current
          setAssignments(current.assignments)
          setPinnedKeys(current.pinned)
          onResourceStateChange?.(current)
        }
      }
      throw writeError
    }
  }, [
    codexProjectId,
    onResourceStateChange,
    ownerId,
    resourcesHydrated,
    resourcesLoadError,
    workspaceId,
  ])

  const runResourceAction = React.useCallback(async (
    action: () => Promise<void>,
    fallbackMessage: string,
  ) => {
    if (resourceActionBusyRef.current || !resourcesHydrated || resourcesLoadError) return
    resourceActionBusyRef.current = true
    setResourceActionBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : fallbackMessage)
    } finally {
      resourceActionBusyRef.current = false
      setResourceActionBusy(false)
    }
  }, [resourcesHydrated, resourcesLoadError])

  const assignResource = React.useCallback(async (resourceKey: string, departmentId: string) => {
    await runResourceAction(async () => {
      const item = items.find((entry) => entry.key === resourceKey)
      const connectorAccountId = item ? connectorAccountIdForCompany(item) : null
      let connectorMadeAvailable = false
      if (
        codexProjectId
        && connectorAccountId
        && item?.connector
        && onAssignConnectorToCompany
      ) {
        connectorMadeAvailable = await onAssignConnectorToCompany(item.connector)
      }
      // Availability is not an executable permission. The CAS ledger below
      // is the authoritative department grant; if it fails, effects remain
      // blocked even when the connector is already available to the company.
      await commitResourceState((current) => ({
        ...current,
        assignments: { ...current.assignments, [resourceKey]: departmentId },
      }))
      if (connectorMadeAvailable && item) {
        toast.success(`${item.name} quedó disponible y asignado al departamento seleccionado.`)
      }
    }, "No se pudo asignar el recurso.")
  }, [
    codexProjectId,
    commitResourceState,
    items,
    onAssignConnectorToCompany,
    runResourceAction,
  ])

  const togglePin = React.useCallback(async (item: CompanyResourceItem) => {
    await runResourceAction(async () => {
      const isPinned = resourceStateRef.current.pinned.includes(item.key)
      const connectorAccountId = connectorAccountIdForCompany(item)
      let connectorMadeAvailable = false
      if (
        !isPinned
        && codexProjectId
        && connectorAccountId
        && item.connector
        && onAssignConnectorToCompany
      ) {
        connectorMadeAvailable = await onAssignConnectorToCompany(item.connector)
      }
      await commitResourceState((current) => {
        const shouldPin = !isPinned
        const nextPinned = shouldPin
          ? current.pinned.includes(item.key)
            ? current.pinned
            : [item.key, ...current.pinned]
          : current.pinned.filter((id) => id !== item.key)
        const defaultDepartmentId = current.assignments[item.key]
          || defaultDepartmentForResource(item, departments)
        return {
          assignments: shouldPin && defaultDepartmentId
            ? { ...current.assignments, [item.key]: defaultDepartmentId }
            : current.assignments,
          pinned: nextPinned,
          revision: current.revision,
        }
      })
      if (connectorMadeAvailable) {
        toast.success(`${item.name} quedó disponible para la empresa y fijado al agente.`)
      }
    }, "No se pudo actualizar el recurso.")
  }, [
    codexProjectId,
    commitResourceState,
    departments,
    onAssignConnectorToCompany,
    runResourceAction,
  ])

  const removeResource = React.useCallback(async (item: CompanyResourceItem) => {
    await runResourceAction(async () => {
      await commitResourceState((current) => {
        const nextAssignments = { ...current.assignments }
        delete nextAssignments[item.key]
        return {
          assignments: nextAssignments,
          pinned: current.pinned.filter((key) => key !== item.key),
          revision: current.revision,
        }
      })
      if (item.kind === "connector") {
        toast.success(
          item.availableToCompany
            ? `Se retiró el permiso de ${item.name}; la cuenta sigue disponible para la empresa.`
            : `Se retiró el permiso de ${item.name}; la cuenta global permanece conectada.`,
        )
      }
    }, "No se pudo quitar el recurso de esta empresa.")
  }, [
    commitResourceState,
    runResourceAction,
  ])

  const enableConnectorForCompany = React.useCallback(async (item: CompanyResourceItem) => {
    await runResourceAction(async () => {
      if (
        item.kind !== "connector"
        || !item.connector
        || !connectorAccountIdForCompany(item)
        || !onAssignConnectorToCompany
      ) {
        throw new Error("No se pudo habilitar esta cuenta para la empresa.")
      }
      const changed = await onAssignConnectorToCompany(item.connector)
      toast.success(
        changed
          ? `${item.name} quedó habilitado para esta empresa.`
          : `${item.name} ya estaba habilitado para esta empresa.`,
      )
    }, "No se pudo habilitar el recurso para esta empresa.")
  }, [onAssignConnectorToCompany, runResourceAction])

  const handlePrimary = React.useCallback((item: CompanyResourceItem) => {
    const assignedToCompany = Boolean(assignments[item.key])
    if (isResourceActiveForCompany(item, assignedToCompany)) return
    if (
      assignedToCompany
      && item.kind === "connector"
      && item.connected
      && !item.availableToCompany
    ) {
      void enableConnectorForCompany(item)
      return
    }
    if (item.connected && item.assignable) {
      const departmentId = defaultDepartmentForResource(item, departments)
      if (departmentId) void assignResource(item.key, departmentId)
      return
    }
    if (item.kind === "social" && item.platform) {
      if (item.canConnect) onConnectSocial(item.platform)
      return
    }
    if (item.kind === "connector" && item.connector) {
      onConnectConnector(item.connector)
      return
    }
    if (item.platform && item.canConnect) {
      onConnectSocial(item.platform)
      return
    }
    if (item.status === "browser") {
      window.open(`https://${item.domain}`, "_blank", "noopener,noreferrer")
    }
  }, [
    assignResource,
    assignments,
    departments,
    enableConnectorForCompany,
    onConnectConnector,
    onConnectSocial,
  ])

  const categoryCounts = React.useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of items) {
      counts[item.category] = (counts[item.category] || 0) + 1
    }
    return counts
  }, [items])
  const gmailResource = items.find((item) => item.id === "gmail") || null
  const gmailAssigned = Boolean(gmailResource && assignments[gmailResource.key])
  const gmailActive = Boolean(
    gmailResource
    && isResourceActiveForCompany(gmailResource, gmailAssigned),
  )
  const gmailNeedsCompanyAvailability = Boolean(
    gmailResource?.kind === "connector"
    && gmailAssigned
    && gmailResource.connected
    && !gmailResource.availableToCompany,
  )

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 pb-10 pt-6 sm:px-6 lg:px-8" data-testid="company-resources-surface">
      {connectorsLoadError ? (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-950 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-100"
          role="alert"
          data-testid="company-connectors-load-error"
        >
          <span>{connectorsLoadError} Las acciones de conexión están bloqueadas hasta reintentar.</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full bg-white dark:bg-zinc-950"
            onClick={onRefresh}
            disabled={loading}
          >
            <RefreshCw className={cn("mr-2 h-3.5 w-3.5", loading && "animate-spin")} />
            Reintentar
          </Button>
        </div>
      ) : null}
      {resourcesLoadError ? (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100"
          role="alert"
          data-testid="company-resources-load-error"
        >
          <span>{resourcesLoadError} No se guardará ningún cambio hasta recuperar el estado.</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full bg-white dark:bg-zinc-950"
            onClick={() => {
              onRefresh()
              setResourceHydrationVersion((version) => version + 1)
            }}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Reintentar
          </Button>
        </div>
      ) : null}
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
              label: "Correo",
              value: emailConnected.length > 0 ? `${emailConnected.length} conectado${emailConnected.length === 1 ? "" : "s"}` : "Sin conectar",
              icon: Mail,
              tone: emailConnected.length > 0 ? "ok" : "muted",
            },
            {
              label: "Apps e integraciones",
              value: `${appsConnected.length} activa${appsConnected.length === 1 ? "" : "s"}`,
              icon: PackageOpen,
              tone: appsConnected.length > 0 ? "ok" : "muted",
            },
            {
              label: "Billetera",
              value: "No configurada",
              icon: Wallet,
              tone: "muted",
            },
            {
              label: "Ingresos",
              value: "Sin datos",
              icon: Sparkles,
              tone: "muted",
            },
            {
              label: "Personajes",
              value: "Ninguno",
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
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Personajes de la empresa</h2>
              <p className="text-xs text-zinc-500">Perfiles visuales reutilizables para contenido</p>
            </div>
          </div>
          <Button type="button" variant="outline" className="h-9 rounded-full px-3 text-xs" onClick={onOpenCeo}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            Configurar con CEO Office
          </Button>
        </div>
        <div className="flex min-h-[72px] items-center gap-3 px-4 py-4 text-sm text-zinc-500">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-50 dark:bg-zinc-900">
            <UsersRound className="h-4 w-4" />
          </span>
          <div>
            <p className="font-medium text-zinc-700 dark:text-zinc-200">Aún no hay personajes</p>
            <p className="text-xs text-zinc-500">Los perfiles guardados aparecerán aquí cuando estén configurados.</p>
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
                if (gmailResource) handlePrimary(gmailResource)
              }}
              disabled={
                !resourcesHydrated
                || resourceActionBusy
                || !gmailResource
                || gmailActive
                || (!gmailResource.connected && !gmailResource.canConnect)
                || connectorBusy === gmailResource.connector?.id
              }
            >
              {connectorBusy === gmailResource?.connector?.id ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : gmailActive ? (
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <Link2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              {gmailActive
                ? "Email activo en esta empresa"
                : gmailNeedsCompanyAvailability
                  ? "Habilitar en empresa"
                : gmailAssigned
                  ? "Reconectar email"
                : gmailResource?.connected
                  ? "Añadir email a esta empresa"
                  : "Conectar mi email"}
              <BrandLogo name="Gmail" domain="gmail.com" localIcon="/icons/gmail.svg" size={18} className="ml-2 rounded-md" />
            </Button>
            <Button type="button" variant="outline" className="h-9 rounded-full px-3 text-xs" onClick={onOpenCeo}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Crear email de Matrix
            </Button>
          </div>
        </div>
        {(emailConnected.length ? emailConnected : items.filter((item) => item.id === "gmail")).slice(0, 3).map((item) => {
          const deptId = assignments[item.key] || null
          const dept = deptId ? departmentById.get(deptId) : null
          const busy = item.platform
            ? providerBusy === item.platform
            : item.connector
              ? connectorBusy === item.connector.id
              : false
          const activeForCompany = isResourceActiveForCompany(
            item,
            Boolean(assignments[item.key]),
          )
          const needsCompanyAvailability = Boolean(
            assignments[item.key]
            && item.kind === "connector"
            && item.connected
            && !item.availableToCompany,
          )
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
                {busy
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : activeForCompany
                    ? "Activo en la empresa"
                    : needsCompanyAvailability
                      ? "Habilitar en empresa"
                    : assignments[item.key]
                      ? "Requiere reconexión"
                    : item.connected
                      ? "Cuenta disponible"
                      : "Sin conectar"}
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
              aria-label="Buscar apps e integraciones"
              className="h-10 rounded-full border-zinc-200 bg-zinc-50/80 pl-9 text-sm dark:border-white/10 dark:bg-zinc-900"
            />
          </div>
        </div>

        <div className="space-y-5 px-4 py-4">
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              En esta empresa
            </p>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {workspaceItems.map((item) => (
                <ResourceCard
                  key={item.key}
                  item={item}
                  departments={departments}
                  departmentId={assignments[item.key] || null}
                  assignedToCompany={Boolean(assignments[item.key])}
                  busy={
                    !resourcesHydrated
                    || resourceActionBusy
                    || (item.platform
                      ? providerBusy === item.platform
                      : item.connector
                        ? connectorBusy === item.connector.id
                        : false)
                  }
                  onPrimary={() => handlePrimary(item)}
                  onTogglePin={() => void togglePin(item)}
                  onRemove={() => void removeResource(item)}
                  onAssign={(departmentId) => void assignResource(item.key, departmentId)}
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
                : (categoryCounts[id] || 0)
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCategory(id)}
                  aria-pressed={category === id}
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
                departmentId={assignments[item.key] || null}
                assignedToCompany={Boolean(assignments[item.key])}
                busy={
                  !resourcesHydrated
                  || resourceActionBusy
                  || (item.platform
                    ? providerBusy === item.platform
                    : item.connector
                      ? connectorBusy === item.connector.id
                      : false)
                }
                onPrimary={() => handlePrimary(item)}
                onTogglePin={() => void togglePin(item)}
                onRemove={() => void removeResource(item)}
                onAssign={(departmentId) => void assignResource(item.key, departmentId)}
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
  assignedToCompany,
  busy,
  onPrimary,
  onTogglePin,
  onRemove,
  onAssign,
}: {
  item: CompanyResourceItem
  departments: readonly AgentDepartmentDefinition[]
  departmentId: string | null
  assignedToCompany: boolean
  busy: boolean
  onPrimary: () => void
  onTogglePin: () => void
  onRemove: () => void
  onAssign: (departmentId: string) => void
}) {
  const department = departmentId
    ? departments.find((entry) => entry.id === departmentId) || null
    : null
  const activeForCompany = isResourceActiveForCompany(item, assignedToCompany)
  const needsCompanyAvailability = Boolean(
    assignedToCompany
    && item.kind === "connector"
    && item.connected
    && !item.availableToCompany,
  )

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
                        item.status === "attention" || needsCompanyAvailability
                          ? "bg-amber-500"
                          : "bg-emerald-500",
                      )} />
                      {needsCompanyAvailability
                        ? "Habilitar para esta empresa"
                        : item.status === "attention"
                          ? "Requiere atención"
                          : item.toolsHint}
                    </span>
                  )
                  : item.description}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {assignedToCompany ? (
                <button
                  type="button"
                  onClick={onRemove}
                  disabled={busy}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:hover:bg-rose-950/30"
                  aria-label="Quitar de esta empresa"
                  title="Quitar de esta empresa (la cuenta seguirá conectada)"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={onTogglePin}
                disabled={busy || (!item.assignable && item.status !== "browser")}
                className={cn(
                  "inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200",
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
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Departamento gestor</span>
          <select
            value={departmentId || ""}
            onChange={(event) => {
              if (event.target.value) onAssign(event.target.value)
            }}
            disabled={busy || (!item.assignable && item.status !== "browser")}
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
          disabled={
            busy
            || activeForCompany
            || (
              !item.connected
              && !item.canConnect
              && item.status !== "browser"
            )
          }
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-xs font-semibold transition-colors disabled:opacity-50",
            activeForCompany
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
              {activeForCompany
                ? "Activo"
                : needsCompanyAvailability
                  ? "Habilitar en empresa"
                : assignedToCompany
                  ? "Reconectar"
                : item.connected
                  ? item.assignable ? "Añadir" : "Reconectar"
                : item.statusLabel}
              {activeForCompany
                ? <CheckCircle2 className="h-3.5 w-3.5 opacity-70" />
                : <ChevronRight className="h-3.5 w-3.5 opacity-60" />}
            </>
          )}
        </button>
      </div>

      {department ? (
        <p className="mt-2 text-[10px] text-zinc-400">
          {activeForCompany || item.status === "browser"
            ? `${department.name} gestiona este recurso para la empresa.`
            : needsCompanyAvailability
              ? `${department.name} podrá gestionarlo cuando lo habilites para esta empresa.`
            : `${department.name} lo gestionará cuando esté conectado.`}
        </p>
      ) : null}
    </article>
  )
}

export default CompanyResourcesSurface
