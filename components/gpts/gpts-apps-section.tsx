"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Check, Plug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useSettings } from "@/lib/settings-context"
import { useAuth } from "@/lib/auth-context-integrated"
import { toast } from "sonner"
import { apiClient } from "@/lib/api"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { getNormalizedApiBaseUrl } from "@/lib/api-base-url"
import { agentsHomeHref } from "@/lib/agents-home-path"
import {
  CONNECT_COPY,
  connectButtonLabel,
  connectGptStoreApp,
  isHealthConnected,
  resolveFirstPartyProvider,
  type ConnectGptStoreAppDeps,
} from "@/lib/gpts-apps-connect"
import {
  GPT_STORE_APP_CATEGORIES,
  GPT_STORE_APPS,
  gptStoreAppLogoSources,
  gptStoreAppLogoUrl,
  type GptStoreApp,
  type GptStoreAppCategory,
} from "@/lib/gpts-apps-catalog"

const INITIAL_VISIBLE = 16

const AVATAR_TONES = [
  "bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-100",
  "bg-violet-100 text-violet-800 dark:bg-violet-900/60 dark:text-violet-100",
  "bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-100",
  "bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-100",
  "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100",
]

function initials(name: string) {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "A"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
}

function toneFor(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return AVATAR_TONES[hash % AVATAR_TONES.length]
}

function AppLogo({ app }: { app: GptStoreApp }) {
  const sources = gptStoreAppLogoSources(app)
  const [sourceIndex, setSourceIndex] = useState(0)
  const src = sources[sourceIndex] ?? gptStoreAppLogoUrl(app)

  if (src && sourceIndex < sources.length) {
    return (
      <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl bg-white p-2 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={`${app.name} logo`}
          width={64}
          height={64}
          loading="lazy"
          decoding="async"
          onError={() => setSourceIndex((index) => index + 1)}
          className="h-full w-full object-contain"
        />
      </div>
    )
  }

  return (
    <div className={cn("grid h-16 w-16 shrink-0 place-items-center rounded-2xl text-[0.92rem] font-semibold", toneFor(app.id))}>
      {initials(app.name)}
    </div>
  )
}

function AppCard({
  app,
  connected,
  connecting,
  onConnect,
  onDisconnect,
}: {
  app: GptStoreApp
  connected: boolean
  connecting: boolean
  onConnect: (app: GptStoreApp) => void
  onDisconnect: (app: GptStoreApp) => void
}) {
  return (
    <article
      data-testid={`gpts-app-card-${app.id}`}
      className="group relative flex min-h-[104px] items-center gap-4 rounded-2xl bg-[#f8f8f8] p-4 transition duration-200 hover:bg-[#f1f1f1] dark:bg-zinc-900 dark:hover:bg-zinc-800/80"
    >
      <AppLogo app={app} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <h3 className="line-clamp-1 text-[1rem] font-semibold leading-tight tracking-[-0.025em] text-zinc-950 dark:text-zinc-50">
            {app.name}
          </h3>
          {connected ? (
            <div className="flex shrink-0 items-center gap-1">
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[0.68rem] font-semibold text-emerald-700 dark:text-emerald-400">
                <Check className="h-3 w-3" />
                {CONNECT_COPY.connected}
              </span>
              <button
                type="button"
                data-testid={`gpts-app-reconnect-${app.id}`}
                disabled={connecting}
                onClick={() => onConnect(app)}
                className="rounded-full px-2 py-1 text-[0.72rem] font-medium text-zinc-500 hover:text-zinc-900 disabled:opacity-60 dark:hover:text-zinc-100"
              >
                {connecting ? CONNECT_COPY.connecting : CONNECT_COPY.reconnect}
              </button>
              <button
                type="button"
                onClick={() => onDisconnect(app)}
                className="rounded-full px-2 py-1 text-[0.72rem] font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                {CONNECT_COPY.remove}
              </button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              data-testid={`gpts-app-connect-${app.id}`}
              disabled={connecting}
              onClick={() => onConnect(app)}
              className="h-8 shrink-0 rounded-full bg-black px-3 text-[0.78rem] font-semibold text-white hover:bg-zinc-800 disabled:opacity-70 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              {connectButtonLabel({ connected: false, connecting })}
            </Button>
          )}
        </div>
        <p className="mt-1 line-clamp-2 max-w-[22rem] text-[0.82rem] leading-[1.22rem] text-zinc-800 dark:text-zinc-300">
          {app.description}
        </p>
        <p className="mt-1.5 text-[0.78rem] text-zinc-400 dark:text-zinc-500">{app.category}</p>
      </div>
    </article>
  )
}

function storedConversationId(): string | null {
  if (typeof window === "undefined") return null
  const id = String(window.localStorage.getItem("currentChatId") || "").trim()
  return id && id !== "pending" ? id : null
}

function storedAuthToken(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem("auth-token")
  } catch {
    return null
  }
}

function authHeaders(): Record<string, string> {
  const token = storedAuthToken()
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function fetchConnectJson(requestPath: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await authenticatedFetch(`${getNormalizedApiBaseUrl()}${requestPath}`, {
    credentials: "include",
    headers: authHeaders(),
    signal: AbortSignal.timeout(20_000),
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  return { ok: res.ok, status: res.status, body }
}

async function ensureComputerSession(conversationId: string) {
  const res = await authenticatedFetch(`${getNormalizedApiBaseUrl()}/agent-computer/sessions`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    body: JSON.stringify({ conversationId }),
    signal: AbortSignal.timeout(60_000),
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(String(body.message || body.error || CONNECT_COPY.computerFailed))
  }
  return {
    sessionId: body.sessionId ? String(body.sessionId) : undefined,
    conversationId: body.conversationId ? String(body.conversationId) : conversationId,
    conversationBound: body.conversationBound !== false,
  }
}

async function navigateComputerSession(conversationId: string, url: string) {
  const res = await authenticatedFetch(`${getNormalizedApiBaseUrl()}/agent-computer/navigate`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    body: JSON.stringify({ conversationId, url }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(String(body.message || body.error || CONNECT_COPY.navigateFailed(url)))
  }
  return body
}

export function GptsAppsSection({
  searchQuery,
  showAll = false,
  hideHeading = false,
}: {
  searchQuery: string
  showAll?: boolean
  hideHeading?: boolean
}) {
  const { settings } = useSettings()
  const { isAuthenticated } = useAuth()
  const router = useRouter()
  const [category, setCategory] = useState<"All" | GptStoreAppCategory>("All")
  const [expanded, setExpanded] = useState(showAll)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [healthById, setHealthById] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!isAuthenticated && !storedAuthToken()) return
    let cancelled = false
    fetchConnectJson("/apps/connections")
      .then((res) => {
        if (cancelled || !res.ok) return
        const list = Array.isArray(res.body.connections) ? res.body.connections : []
        const next: Record<string, string> = {}
        for (const row of list) {
          if (!row || typeof row !== "object") continue
          const appId = String((row as { app?: unknown }).app || "").trim()
          const status = String((row as { status?: unknown }).status || "").trim()
          if (appId) next[appId] = status
        }
        setHealthById(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [isAuthenticated])

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return GPT_STORE_APPS.filter((app) => {
      const matchesCategory = category === "All" || app.category === category
      const matchesSearch = !query
        || app.name.toLowerCase().includes(query)
        || app.description.toLowerCase().includes(query)
        || app.category.toLowerCase().includes(query)
      return matchesCategory && matchesSearch
    })
  }, [category, searchQuery])

  const visible = showAll || expanded || searchQuery.trim() ? filtered : filtered.slice(0, INITIAL_VISIBLE)
  const hiddenCount = Math.max(0, filtered.length - visible.length)

  const isConnected = (id: string) => isHealthConnected(healthById[id])

  const connect = async (app: GptStoreApp) => {
    if (connectingId) return
    setConnectingId(app.id)
    const loginNext = typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search || ""}` || "/conexiones"
      : "/conexiones"
    const deps: ConnectGptStoreAppDeps = {
      isAuthenticated: Boolean(isAuthenticated || storedAuthToken()),
      defaultModel: settings.defaultModel,
      currentConversationId: storedConversationId(),
      loginNext,
      requireLogin: (next) => {
        router.push(`/auth/login?next=${encodeURIComponent(next || "/conexiones")}`)
      },
      fetchJson: fetchConnectJson,
      ensureComputer: ensureComputerSession,
      navigateComputer: navigateComputerSession,
      createConversation: async (title, model) => {
        const response = await apiClient.createChat({ title, model })
        const id = String(response?.chat?.id || response?.id || "").trim()
        if (!id) throw new Error(CONNECT_COPY.computerFailed)
        try { window.localStorage.setItem("currentChatId", id) } catch { /* ignore */ }
        return { id }
      },
      openComputerOverlay: (conversationId) => {
        router.push(agentsHomeHref(new URLSearchParams({ computer: "1" }), null, conversationId))
      },
    }
    try {
      const result = await connectGptStoreApp(app, deps)
      if (result.status === "login_required") {
        toast.error(result.message)
        return
      }
      if (result.redirectUrl) {
        window.location.href = result.redirectUrl
        return
      }
      if (result.status === "computer_opened") {
        toast.success(`${app.name}: ${CONNECT_COPY.computerOpened.toLowerCase()}`)
        return
      }
      if (!result.markConnected) {
        toast.error(result.message || CONNECT_COPY.computerFailed)
      }
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : CONNECT_COPY.computerFailed
      toast.error(message)
    } finally {
      setConnectingId(null)
    }
  }

  const disconnect = async (app: GptStoreApp) => {
    if (!resolveFirstPartyProvider(app)) {
      toast.success(CONNECT_COPY.disconnected(app.name))
      return
    }
    try {
      const res = await authenticatedFetch(`${getNormalizedApiBaseUrl()}/apps/connections/${encodeURIComponent(app.id)}`, {
        method: "DELETE",
        credentials: "include",
        headers: authHeaders(),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok && res.status !== 204) {
        toast.error(CONNECT_COPY.disconnectFailed(app.name))
        return
      }
      setHealthById((prev) => {
        const next = { ...prev }
        delete next[app.id]
        return next
      })
      toast.success(CONNECT_COPY.disconnected(app.name))
    } catch {
      toast.error(CONNECT_COPY.disconnectFailed(app.name))
    }
  }

  return (
    <section data-testid="gpts-apps-section" className={cn("mx-auto w-full pb-12", hideHeading ? "max-w-[980px]" : "mt-10 max-w-[640px]")}>
      {!hideHeading && (
        <div>
          <h2 className="text-[1.35rem] font-semibold tracking-[-0.04em] text-zinc-950 dark:text-zinc-50 md:text-[1.55rem]">Apps</h2>
          <p className="mt-0.5 text-[0.88rem] text-zinc-400 dark:text-zinc-500">
            Conecta aplicaciones para usarlas en SiraGPT
          </p>
        </div>
      )}

      <div className="mt-4 flex items-center gap-4 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {GPT_STORE_APP_CATEGORIES.map((item) => {
          const active = category === item.value
          return (
            <button
              key={item.value}
              type="button"
              onClick={() => {
                setCategory(item.value)
                setExpanded(false)
              }}
              className={cn(
                "relative shrink-0 pb-2 text-[0.82rem] font-medium tracking-[-0.025em] transition",
                active ? "text-zinc-950 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              )}
            >
              {item.label}
              {active && <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-zinc-950 dark:bg-zinc-100" />}
            </button>
          )
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="mt-4 rounded-2xl bg-[#f8f8f8] p-7 text-center dark:bg-zinc-900">
          <Plug className="mx-auto h-10 w-10 text-zinc-400 dark:text-zinc-500" />
          <h3 className="mt-4 text-xl font-semibold tracking-[-0.04em] text-zinc-950 dark:text-zinc-50">Sin apps en esta búsqueda</h3>
          <p className="mx-auto mt-2 max-w-xl text-zinc-500 dark:text-zinc-400">Prueba con otro nombre o cambia de categoría.</p>
        </div>
      ) : (
        <div className="mt-4 grid gap-2.5 md:grid-cols-2">
          {visible.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              connected={isConnected(app.id)}
              connecting={connectingId === app.id}
              onConnect={connect}
              onDisconnect={disconnect}
            />
          ))}
        </div>
      )}

      {hiddenCount > 0 && (
        <div className="mt-5 flex justify-center">
          <Button
            type="button"
            variant="outline"
            data-testid="gpts-apps-show-all"
            onClick={() => setExpanded(true)}
            className="rounded-full"
          >
            Ver las {filtered.length} apps
          </Button>
        </div>
      )}
    </section>
  )
}
