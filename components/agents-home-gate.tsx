"use client"

/**
 * `/` is marketing for guests and the agents (chat) home for signed-in
 * members. Do not restyle the chat chrome — ChatInterface is the same
 * surface previously mounted at /chat.
 */

import * as React from "react"
import dynamic from "next/dynamic"

import HomePage from "@/app/home-page"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
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

const ChatInterface = dynamic(
  () => import("@/components/chat-interface-enhanced"),
  { ssr: false, loading: AgentsHomeLoading },
)

export function AgentsHomeGate() {
  const { user, isLoading } = useAuth()

  if (isLoading) return <AgentsHomeLoading />

  if (!user) return <HomePage />

  return (
    <div className="relative h-full min-h-0" data-testid="agents-home">
      <ChatInterface />
    </div>
  )
}

export default AgentsHomeGate
