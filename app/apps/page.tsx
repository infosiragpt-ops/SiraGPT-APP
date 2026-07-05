"use client"

import * as React from "react"
import { Code, Key, BarChart3, Bot, Shield, Search, Wrench } from "lucide-react"
import { AgentsList } from "@/components/enterprise/agents-list"
import { ApiKeysCard } from "@/components/enterprise/api-keys-card"
import { UsageDashboard } from "@/components/enterprise/usage-dashboard"

type Tab = "agents" | "code" | "keys" | "usage"

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "agents", label: "Enterprise Agents", icon: Bot },
  { id: "code", label: "Code Agent", icon: Code },
  { id: "keys", label: "API Keys", icon: Key },
  { id: "usage", label: "Usage", icon: BarChart3 },
]

function AppsPage() {
  const [tab, setTab] = React.useState<Tab>("agents")

  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-white/10 px-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors " +
              (tab === t.id
                ? "bg-white/10 text-white"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-white/5")
            }
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
        <div className="ml-auto text-xs text-zinc-500">SiraGPT Agents SDK v0.1</div>
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto">
        {tab === "agents" && <AgentsList />}
        {tab === "code" && (
          <div className="flex flex-1 items-center justify-center p-8 text-zinc-500 text-sm">
            Code Agent available at /code
          </div>
        )}
        {tab === "keys" && <ApiKeysCard />}
        {tab === "usage" && <UsageDashboard />}
      </div>
    </div>
  )
}
// Next.js requires a default export for a route page — the named export
// alone breaks `next build` (AppPageConfig validator).
export default AppsPage
