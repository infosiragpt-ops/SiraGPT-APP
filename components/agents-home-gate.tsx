"use client"

/**
 * `/` is marketing for guests. Signed-in members are sent to `/agentes`
 * — the product noun is «agentes», not a silent `/` copy of chat.
 */

import * as React from "react"
import { useRouter } from "next/navigation"

import HomePage from "@/app/home-page"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { chatSearchToAgentsHome } from "@/lib/agents-home-path"
import { useAuth } from "@/lib/auth-context-integrated"

function AgentsHomeLoading() {
  return (
    <div
      className="flex min-h-screen w-full items-center justify-center bg-background text-foreground"
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

export function AgentsHomeGate() {
  const { user, isLoading } = useAuth()
  const router = useRouter()

  React.useEffect(() => {
    if (isLoading || !user) return
    const search = typeof window !== "undefined" ? window.location.search : ""
    const hash = typeof window !== "undefined" ? window.location.hash : ""
    router.replace(chatSearchToAgentsHome(search, hash))
  }, [isLoading, user, router])

  if (isLoading) return <AgentsHomeLoading />
  if (user) return <AgentsHomeLoading />
  return <HomePage />
}

export default AgentsHomeGate
