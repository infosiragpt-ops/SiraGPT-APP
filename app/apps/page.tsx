"use client"

/**
 * /apps — SiraGPT Apps + Enterprise Agents SDK.
 *
 * Primary surface: CodexAgentPanel in "apps" mode (Claude Code / Codex style
 * builder with plan → build → preview, subagents, enterprise_analyst).
 * Secondary tabs: Enterprise Agents (TOML registry + real tool sandbox),
 * API Keys and Usage for the public Agents SDK.
 */

import dynamic from "next/dynamic"
import * as React from "react"
import { useRouter } from "next/navigation"
import { Bot, Boxes, Key, BarChart3 } from "lucide-react"

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

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "builder", label: "App Builder", icon: Boxes },
  { id: "agents", label: "Enterprise Agents", icon: Bot },
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
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-white/10 px-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors " +
              (tab === t.id
                ? "bg-white/10 text-white"
                : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200")
            }
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-[11px] text-zinc-500">
          <span className="hidden sm:inline">Plan → Build → Preview · Subagents · SDK v0.2</span>
          <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-200">
            Agents SDK
          </span>
        </div>
      </div>

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
        <div className="h-4 w-24 animate-pulse rounded bg-white/10" />
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
