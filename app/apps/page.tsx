"use client"

/**
 * /apps — Claude Code / Codex-style software builder + Enterprise Agents SDK.
 *
 * Agent-first layout:
 *   - Primary: full-height Codex App Builder (plan → auto-build → preview,
 *     enterprise subagents, sandbox runner).
 *   - Secondary tabs: Enterprise Agents (TOML + real tools), API Keys, Usage.
 */

import dynamic from "next/dynamic"
import * as React from "react"
import { useRouter } from "next/navigation"
import { Bot, Boxes, Key, BarChart3, Sparkles } from "lucide-react"

import { CodeWorkspaceProvider } from "@/lib/code-workspace-context"
import { useAuth } from "@/lib/auth-context-integrated"
import { AgentsList } from "@/components/enterprise/agents-list"
import { ApiKeysCard } from "@/components/enterprise/api-keys-card"
import { UsageDashboard } from "@/components/enterprise/usage-dashboard"

const CodexAgentPanel = dynamic(
  () => import("@/components/codex/codex-agent-panel").then((mod) => mod.CodexAgentPanel),
  { ssr: false, loading: () => <AppsSkeleton /> },
)

type Tab = "builder" | "agents" | "keys" | "usage"

const TABS: { id: Tab; label: string; icon: React.ElementType; hint?: string }[] = [
  { id: "builder", label: "Builder", icon: Boxes, hint: "Claude Code mode" },
  { id: "agents", label: "Agents SDK", icon: Bot, hint: "Enterprise" },
  { id: "keys", label: "API Keys", icon: Key },
  { id: "usage", label: "Usage", icon: BarChart3 },
]

export default function AppsPage() {
  return (
    <AppsGate>
      <CodeWorkspaceProvider>
        <AppsShell />
      </CodeWorkspaceProvider>
    </AppsGate>
  )
}

function AppsShell() {
  const [tab, setTab] = React.useState<Tab>("builder")

  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-white/10 px-2 sm:px-3">
        <div className="mr-2 hidden items-center gap-1.5 sm:flex">
          <Sparkles className="h-3.5 w-3.5 text-violet-300" />
          <span className="text-xs font-semibold tracking-wide text-zinc-200">SiraGPT APPS</span>
        </div>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            title={t.hint}
            className={
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3 " +
              (tab === t.id
                ? "bg-violet-500/20 text-violet-100 ring-1 ring-violet-500/40"
                : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200")
            }
          >
            <t.icon className="h-3.5 w-3.5" />
            <span>{t.label}</span>
          </button>
        ))}
        <div className="ml-auto hidden text-[10px] text-zinc-500 md:block">
          Subagents · Plan/Build · Preview · Sandbox
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {tab === "builder" && (
          <div className="min-h-0 min-w-0 flex-1">
            <CodexAgentPanel surface="apps" />
          </div>
        )}
        {tab === "agents" && <AgentsList />}
        {tab === "keys" && (
          <div className="min-h-0 flex-1 overflow-auto">
            <ApiKeysCard />
          </div>
        )}
        {tab === "usage" && (
          <div className="min-h-0 flex-1 overflow-auto">
            <UsageDashboard />
          </div>
        )}
      </div>
    </div>
  )
}

function AppsGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth()
  const router = useRouter()

  React.useEffect(() => {
    if (!isLoading && !user) router.replace("/auth/login?next=/apps")
  }, [isLoading, router, user])

  if (isLoading || !user) return <AppsSkeleton />
  return <>{children}</>
}

function AppsSkeleton() {
  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-white/10 px-3">
        <div className="h-4 w-28 animate-pulse rounded bg-white/10" />
        <div className="h-4 w-20 animate-pulse rounded bg-white/10" />
        <div className="ml-auto h-7 w-24 animate-pulse rounded-md bg-white/10" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-[42%] min-w-[280px] border-r border-white/10 p-3">
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-white/[0.06]" />
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-1 p-3">
          <div className="h-full animate-pulse rounded-xl bg-white/[0.04]" />
        </div>
      </div>
    </div>
  )
}
