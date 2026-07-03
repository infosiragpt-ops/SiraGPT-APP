"use client"

import * as React from "react"
import { BarChart3, Zap, Coins, Activity } from "lucide-react"

interface UsageStats {
  totalRuns: number
  totalTokens: number
  totalCost: number
  byAgent: { agent: string; runs: number; tokens: number; cost: number }[]
}

const DEFAULT_STATS: UsageStats = {
  totalRuns: 0,
  totalTokens: 0,
  totalCost: 0,
  byAgent: [
    { agent: "code-reviewer", runs: 0, tokens: 0, cost: 0 },
    { agent: "builder", runs: 0, tokens: 0, cost: 0 },
    { agent: "researcher", runs: 0, tokens: 0, cost: 0 },
  ],
}

export function UsageDashboard() {
  const [stats, setStats] = React.useState<UsageStats>(DEFAULT_STATS)

  React.useEffect(() => {
    fetch("/api/agents/usage")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => d && setStats(d))
      .catch(() => {})
  }, [])

  return (
    <div className="flex-1 p-6 space-y-6 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-zinc-200">Usage Dashboard</h2>
        <p className="mt-1 text-sm text-zinc-500">Monitor agent execution metrics, token consumption, and costs.</p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-400" />
            <span className="text-xs text-zinc-500">Total Runs</span>
          </div>
          <p className="mt-2 text-2xl font-semibold text-zinc-200">{stats.totalRuns}</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-yellow-400" />
            <span className="text-xs text-zinc-500">Total Tokens</span>
          </div>
          <p className="mt-2 text-2xl font-semibold text-zinc-200">{(stats.totalTokens / 1000).toFixed(1)}k</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 p-4">
          <div className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-green-400" />
            <span className="text-xs text-zinc-500">Total Cost</span>
          </div>
          <p className="mt-2 text-2xl font-semibold text-zinc-200">${stats.totalCost.toFixed(4)}</p>
        </div>
      </div>

      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h3 className="text-sm font-medium text-zinc-300 mb-3">Breakdown by Agent</h3>
        <div className="space-y-2">
          {stats.byAgent.map((a) => (
            <div key={a.agent} className="flex items-center gap-4 text-sm">
              <span className="w-28 text-zinc-400 font-mono text-xs">{a.agent}</span>
              <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full rounded-full bg-blue-500/50 transition-all"
                  style={{ width: stats.totalRuns > 0 ? (a.runs / Math.max(...stats.byAgent.map((x) => x.runs), 1)) * 100 + "%" : "0%" }}
                />
              </div>
              <span className="w-12 text-right text-zinc-500">{a.runs} runs</span>
              <span className="w-20 text-right text-zinc-500">{(a.tokens / 1000).toFixed(1)}k tok</span>
              <span className="w-20 text-right text-zinc-400 font-mono">${a.cost.toFixed(4)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}