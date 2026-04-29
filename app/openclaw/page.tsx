"use client"

import * as React from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Settings2,
  ShieldCheck} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { apiClient } from "@/lib/api"
import { useAuth } from "@/lib/auth-context-integrated"
import { cn } from "@/lib/utils"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
type OpenClawStatus = {
  release: {
    tag: string
    url: string
    installScriptUrl: string
  }
  userWorkspace: {
    profile: string
    workspacePath: string
    gatewayPort: number
    isolated: boolean
  }
  policy: {
    plan: string
    monthlyTokens: number
    usedTokens: number
    concurrentInstances: number
    allowedModels: string[]
    features: string[]
    openClawEnabled: boolean
  }
  runtime: {
    installed: boolean
    bin: string
    version: string | null
    error: string | null
    enabledByEnv: boolean
  }
  instance: {
    status: "running" | "stopped"
    pid: number | null
    startedAt: string | null
    gatewayUrl: string
  }
  installCommand: string
}

type OpenClawNativeSession = {
  status: OpenClawStatus
  gatewayUrl: string
  gatewayWsUrl: string
  frameUrl: string
  directUrl: string
  connected: boolean
}

export default function OpenClawPage() {
  const t = useTranslations("openclaw")
  const { user, isLoading: authLoading } = useAuth()
  const [session, setSession] = React.useState<OpenClawNativeSession | null>(null)
  const [status, setStatus] = React.useState<OpenClawStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [working, setWorking] = React.useState(false)
  const [planLocked, setPlanLocked] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [nativeStoragePrimed, setNativeStoragePrimed] = React.useState(false)

  const loadNativeSession = React.useCallback(async () => {
    if (!user) return
    setLoading(true)
    setLoadError(null)
    try {
      setNativeStoragePrimed(false)
      const response = await apiClient.getOpenClawNativeSession()
      const nextSession = response.session as OpenClawNativeSession
      setSession(nextSession)
      setStatus(nextSession.status)
      setPlanLocked(!nextSession.status?.policy?.openClawEnabled)
    } catch (error: any) {
      const code = error?.code || error?.errorData?.code
      const message = error?.message || "No se pudo abrir OpenClaw nativo."
      setSession(null)
      setNativeStoragePrimed(false)
      if (code === "plan_locked") {
        setPlanLocked(true)
      } else {
        setLoadError(message)
        toast.error(message)
      }
    } finally {
      setLoading(false)
    }
  }, [user])

  React.useEffect(() => {
    if (!authLoading) {
      void loadNativeSession()
    }
  }, [authLoading, loadNativeSession])

  React.useLayoutEffect(() => {
    if (!session?.frameUrl) {
      setNativeStoragePrimed(false)
      return
    }

    try {
      const frameUrl = new URL(session.frameUrl, window.location.origin)
      const params = frameUrl.hash
        ? new URLSearchParams(frameUrl.hash.startsWith("#") ? frameUrl.hash.slice(1) : frameUrl.hash)
        : frameUrl.searchParams
      const gatewayUrl = params.get("gatewayUrl") || session.gatewayWsUrl
      const token = params.get("token")
      const sessionKey = params.get("session") || "main"
      if (!gatewayUrl || !token) {
        setNativeStoragePrimed(true)
        return
      }

      const gatewayKey = normalizeOpenClawGatewayStorageKey(gatewayUrl)
      const settings = {
        gatewayUrl,
        sessionKey,
        lastActiveSessionKey: sessionKey,
        theme: "claw",
        themeMode: "system",
        chatFocusMode: false,
        chatShowThinking: true,
        chatShowToolCalls: true,
        splitRatio: 0.6,
        navCollapsed: false,
        navWidth: 220,
        navGroupsCollapsed: {},
        borderRadius: 50,
      }

      window.localStorage.setItem(`openclaw.control.token.v1:${gatewayKey}`, token)
      window.localStorage.setItem(`openclaw.control.settings.v1:${gatewayKey}`, JSON.stringify(settings))
      window.localStorage.setItem("openclaw.control.settings.v1:default", JSON.stringify(settings))
      try {
        window.sessionStorage.setItem(`openclaw.control.token.v1:${gatewayKey}`, token)
      } catch {
        // The native bootstrap also writes this value; session storage can
        // fail in hardened browser contexts without blocking the embed.
      }
      setNativeStoragePrimed(true)
    } catch {
      setNativeStoragePrimed(true)
    }
  }, [session?.frameUrl, session?.gatewayWsUrl])

  const bootstrapWorkspace = React.useCallback(async () => {
    setWorking(true)
    setLoadError(null)
    try {
      const response = await apiClient.bootstrapOpenClawWorkspace()
      setStatus(response.status)
      toast.success("Workspace OpenClaw preparado.")
      await loadNativeSession()
    } catch (error: any) {
      const code = error?.code || error?.errorData?.code
      const message = error?.message || "No se pudo preparar OpenClaw."
      if (code === "plan_locked") {
        setPlanLocked(true)
        toast.message(message)
      } else {
        toast.error(message)
        setLoadError(message)
      }
    } finally {
      setWorking(false)
    }
  }, [loadNativeSession])

  if (authLoading) {
    return <OpenClawSkeleton />
  }

  if (!user) {
    return (
      <OpenClawCenteredCard
        accent="rose"
        title={t("loginRequired")}
        description={t("loginRequiredDescription")}
        emoji="🦞"
      />
    )
  }

  if (planLocked && status) {
    return (
      <OpenClawCenteredCard
        accent="amber"
        title={t("planLockedTitle")}
        description={t("planLockedDescription")}
        emoji="🔒"
        primaryAction={{ label: t("viewPlans"), href: "/billing" }}
        secondaryAction={{ label: t("retry"), onClick: () => void loadNativeSession() }}
      />
    )
  }

  const viewStatus = session?.status || status
  const gatewayOnline = Boolean(session?.connected || viewStatus?.instance.status === "running")
  const runtimeReady = Boolean(viewStatus?.runtime.installed && viewStatus?.runtime.enabledByEnv)
  const version =
    viewStatus?.runtime.version?.replace(/^OpenClaw\s+/i, "") ||
    viewStatus?.release.tag?.replace(/^v/, "") ||
    "2026.4.26"

  return (
    <main className="flex h-screen min-w-0 flex-col overflow-hidden bg-[#f6f7f9] text-[#24252b]">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[#e7e7eb] bg-white/92 px-4 backdrop-blur">
        <div className="flex h-9 w-9 items-center justify-center rounded-[12px] border border-[#ffd4d4] bg-[#fff2f2] text-lg shadow-sm">
          🦞
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#a0a1aa]">
            <span>Administracion</span>
            <span className="text-[#d4d4d8]">/</span>
            <span className="text-[#f05252]">OpenClaw nativo</span>
          </div>
          <h1 className="truncate text-sm font-semibold tracking-tight text-[#292a30]">
            Interfaz nativa dentro de SiraGPT
          </h1>
        </div>

        <div className="ml-auto hidden items-center gap-2 rounded-full border border-[#e7e7eb] bg-[#fafafa] px-3 py-1.5 text-xs text-[#73737d] md:flex">
          <StatusDot active={gatewayOnline} />
          <span>{loading ? "Sincronizando gateway" : gatewayOnline ? "Gateway conectado" : "Gateway detenido"}</span>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-full border border-[#e7e7eb] bg-white text-[#767782] shadow-sm hover:bg-[#f4f4f5]"
          onClick={() => void loadNativeSession()}
          title="Actualizar"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-9 rounded-full border border-[#ffd4d4] bg-[#fff5f5] px-3 text-xs font-semibold text-[#f05252] shadow-sm hover:bg-[#fff0f0]"
          onClick={() => void bootstrapWorkspace()}
          disabled={working}
        >
          {working ? <ThinkingIndicator size="sm" className="mr-2 h-3.5 w-3.5" /> : <Settings2 className="mr-2 h-3.5 w-3.5" />}
          Preparar
        </Button>
      </header>

      <section className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="grid shrink-0 gap-3 md:grid-cols-4">
          <MetricCard label="Runtime" value={runtimeReady ? "Listo" : "Pendiente"} active={runtimeReady} />
          <MetricCard label="Gateway" value={gatewayOnline ? "Conectado" : "Detenido"} active={gatewayOnline} />
          <MetricCard label="Plan" value={viewStatus?.policy.plan || "PRO"} active />
          <MetricCard label="Version" value={version} active />
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden rounded-[18px] border border-[#e1e3e8] bg-white shadow-[0_24px_80px_-42px_rgba(15,23,42,0.4)]">
          {session?.frameUrl && nativeStoragePrimed ? (
            <iframe
              key={session.frameUrl}
              title="OpenClaw nativo"
              src={session.frameUrl}
              className="h-full w-full border-0 bg-white"
              allow="clipboard-read; clipboard-write; fullscreen; microphone"
            />
          ) : null}

          {loading || (session?.frameUrl && !nativeStoragePrimed) ? (
            <OpenClawFrameOverlay
              icon={<ThinkingIndicator size="md" />}
              title="Cargando interfaz nativa"
              description="SiraGPT esta conectando el gateway local de OpenClaw."
            />
          ) : loadError ? (
            <OpenClawFrameOverlay
              tone="danger"
              icon={<AlertTriangle className="h-5 w-5" />}
              title="No se pudo iniciar OpenClaw nativo"
              description={loadError}
              action={{ label: "Reintentar", onClick: () => void loadNativeSession() }}
            />
          ) : !session?.frameUrl ? (
            <OpenClawFrameOverlay
              icon={<ShieldCheck className="h-5 w-5" />}
              title="OpenClaw listo para preparar"
              description="Prepara el workspace para abrir la aplicacion nativa dentro de SiraGPT."
              action={{ label: "Preparar", onClick: () => void bootstrapWorkspace() }}
            />
          ) : null}
        </div>
      </section>
    </main>
  )
}

function normalizeOpenClawGatewayStorageKey(value: string) {
  try {
    const url = new URL(value, window.location.href)
    const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "") || url.pathname
    return `${url.protocol}//${url.host}${pathname}`
  } catch {
    return value
  }
}

function MetricCard({
  label,
  value,
  active,
}: {
  label: string
  value: string
  active: boolean
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-[12px] border border-[#e7e7eb] bg-white px-3 py-2 shadow-sm">
      <StatusDot active={active} />
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#9a9ba4]">{label}</div>
        <div className="truncate text-sm font-semibold text-[#30313a]">{value}</div>
      </div>
    </div>
  )
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-2.5 w-2.5 shrink-0 rounded-full ring-4",
        active ? "bg-[#22c55e] ring-[#22c55e1a]" : "bg-[#a1a1aa] ring-[#a1a1aa1f]",
      )}
    />
  )
}

type CenteredAction = { label: string; href?: string; onClick?: () => void }

function OpenClawCenteredCard({
  accent,
  title,
  description,
  emoji,
  primaryAction,
  secondaryAction,
}: {
  accent: "rose" | "amber"
  title: string
  description: string
  emoji: string
  primaryAction?: CenteredAction
  secondaryAction?: CenteredAction
}) {
  const accents = {
    rose: "border-[#ffd2d2] bg-[#fff4f4]",
    amber: "border-[#fde68a] bg-[#fffbeb]",
  } as const

  return (
    <main
      role="status"
      aria-live="polite"
      className="flex min-h-screen items-center justify-center bg-[#f5f6f8] p-6 text-[#191a1f]"
    >
      <div className="w-full max-w-sm rounded-[22px] border border-[#e5e7eb] bg-white p-8 text-center shadow-[0_24px_70px_-32px_rgba(15,23,42,0.35)]">
        <div
          aria-hidden="true"
          className={cn(
            "mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[16px] border text-xl",
            accents[accent],
          )}
        >
          {emoji}
        </div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-[#71717a]">{description}</p>
        {primaryAction || secondaryAction ? (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {primaryAction ? (
              primaryAction.href ? (
                <Button asChild className="h-9 rounded-full bg-[#f05252] px-4 text-sm font-semibold text-white hover:bg-[#e04444]">
                  <Link href={primaryAction.href}>{primaryAction.label}</Link>
                </Button>
              ) : (
                <Button
                  type="button"
                  className="h-9 rounded-full bg-[#f05252] px-4 text-sm font-semibold text-white hover:bg-[#e04444]"
                  onClick={primaryAction.onClick}
                >
                  {primaryAction.label}
                </Button>
              )
            ) : null}
            {secondaryAction ? (
              <Button
                type="button"
                variant="ghost"
                className="h-9 rounded-full border border-[#e5e7eb] bg-white px-4 text-sm font-semibold text-[#24252b] hover:bg-[#f6f6f7]"
                onClick={secondaryAction.onClick}
              >
                {secondaryAction.label}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </main>
  )
}

function OpenClawFrameOverlay({
  icon,
  title,
  description,
  action,
  tone = "neutral",
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: { label: string; onClick: () => void }
  tone?: "neutral" | "danger"
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-white/90 p-6 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-[18px] border border-[#e7e7eb] bg-white p-6 text-center shadow-[0_24px_70px_-36px_rgba(15,23,42,0.45)]">
        <div
          className={cn(
            "mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-[14px] border",
            tone === "danger"
              ? "border-[#fecaca] bg-[#fff1f2] text-[#e11d48]"
              : "border-[#dbeafe] bg-[#eff6ff] text-[#2563eb]",
          )}
        >
          {icon}
        </div>
        <h2 className="text-base font-semibold tracking-tight text-[#27272f]">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-[#71717a]">{description}</p>
        {action ? (
          <Button
            type="button"
            className="mt-5 h-9 rounded-full bg-[#f05252] px-4 text-sm font-semibold text-white hover:bg-[#e04444]"
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function OpenClawSkeleton() {
  return (
    <main className="flex h-screen min-w-0 flex-col overflow-hidden bg-[#f6f7f9]">
      <div className="h-14 shrink-0 border-b border-[#e7e7eb] bg-white/90" />
      <div className="grid shrink-0 gap-3 p-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-14 animate-pulse rounded-[12px] border border-[#e7e7eb] bg-white" />
        ))}
      </div>
      <div className="min-h-0 flex-1 p-4 pt-0">
        <div className="h-full animate-pulse rounded-[18px] border border-[#e1e3e8] bg-white" />
      </div>
    </main>
  )
}
