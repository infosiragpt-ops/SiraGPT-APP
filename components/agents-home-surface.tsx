"use client"

/**
 * Canonical agents home surface — same ChatInterface chrome as the
 * former /chat page. Product noun is «agentes», not «chat».
 */

import * as React from "react"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { AGENTS_HOME_PATH } from "@/lib/agents-home-path"
import { useAuth } from "@/lib/auth-context-integrated"

function AgentsHomeLoading() {
  return (
    <div
      className="flex h-[var(--app-viewport-height,100dvh)] w-full items-center justify-center bg-background text-foreground"
      role="status"
      aria-live="polite"
      aria-label="Cargando agentes"
      data-testid="agents-home-loading"
    >
      <div className="flex flex-col items-center gap-4 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border/60 bg-card shadow-sm">
          <ThinkingIndicator size="md" className="text-primary" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Cargando Sira GPT</p>
          <p className="text-xs text-muted-foreground">Preparando tus agentes…</p>
        </div>
      </div>
    </div>
  )
}

const ChatInterface = dynamic(
  () => import("@/components/chat-interface-enhanced"),
  { ssr: false, loading: AgentsHomeLoading },
)

// Same module specifier as the dynamic() above: webpack serves both from one chunk.
const prefetchChatInterface = () => import("@/components/chat-interface-enhanced")

function hasStoredSession(): boolean {
  try {
    return Boolean(window.localStorage.getItem("auth-token"))
  } catch {
    // Storage blocked: assume a session may exist and let the prefetch run.
    return true
  }
}

export function AgentsHomeSurface() {
  const { user, isLoading } = useAuth()
  const router = useRouter()

  // Overlap the chat chunk download with the /auth/me round-trip instead of
  // requesting it only after auth resolves (webpack dedupes the import, so
  // the dynamic() above resolves from cache). Skipped for visitors with no
  // session, who are about to be redirected to the login page.
  React.useEffect(() => {
    if (user || (isLoading && hasStoredSession())) {
      void prefetchChatInterface().catch(() => {})
    }
  }, [isLoading, user])

  React.useEffect(() => {
    if (isLoading || user) return
    const next = typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search}${window.location.hash}`
      : AGENTS_HOME_PATH
    router.replace(`/auth/login?next=${encodeURIComponent(next)}`)
  }, [isLoading, user, router])

  if (isLoading) return <AgentsHomeLoading />
  if (!user) return <AgentsHomeLoading />

  return (
    <div className="relative h-full min-h-0" data-testid="agents-home">
      <ChatInterface />
    </div>
  )
}

export default AgentsHomeSurface
