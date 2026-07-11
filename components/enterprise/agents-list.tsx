"use client"

import * as React from "react"
import { Bot, Shield, Search, Wrench } from "lucide-react"
import { authenticatedFetch } from "@/lib/authenticated-fetch"

interface AgentCard {
  id: string
  name: string
  description: string
  model: string
  tools: string[]
  icon: React.ElementType
}

const AGENTS: AgentCard[] = [
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description: "Revisa código en busca de bugs, vulnerabilidades de seguridad, problemas de rendimiento y estilo.",
    model: "Claude Sonnet 4",
    tools: ["read", "glob", "grep", "web_search"],
    icon: Shield,
  },
  {
    id: "builder",
    name: "Builder Full-Stack",
    description: "Construye aplicaciones web completas con Next.js 14, React, Tailwind CSS y shadcn/ui.",
    model: "Claude Sonnet 4",
    tools: ["read", "write", "edit", "bash", "glob", "grep", "web_search", "web_fetch", "spawn_subagent"],
    icon: Wrench,
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Investiga temas en profundidad usando búsqueda web. Produce informes con fuentes verificables.",
    model: "Claude Sonnet 4",
    tools: ["web_search", "web_fetch"],
    icon: Search,
  },
]

const TOOL_LABELS: Record<string, string> = {
  read: "Read files",
  write: "Write files",
  edit: "Edit files",
  bash: "Shell",
  glob: "File search",
  grep: "Code search",
  web_search: "Web search",
  web_fetch: "Web fetch",
  spawn_subagent: "Subagents",
}

export function AgentsList() {
  const [selected, setSelected] = React.useState<string | null>(null)
  const [prompt, setPrompt] = React.useState("")
  const [running, setRunning] = React.useState(false)
  const [output, setOutput] = React.useState("")

  const runAgent = async () => {
    if (!selected || !prompt) return
    setRunning(true)
    setOutput("")

    try {
      const res = await authenticatedFetch("/api/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: selected, prompt, mode: "auto" }),
      })

      const reader = res.body?.getReader()
      if (!reader) throw new Error("No stream")

      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6))
              if (data.t) setOutput((prev) => prev + data.t)
            } catch {}
          }
        }
      }
    } catch (e) {
      setOutput("Error: " + String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex h-full w-full">
      <div className="w-80 shrink-0 border-r border-white/10 p-4 space-y-3 overflow-auto">
        <h2 className="text-sm font-semibold text-zinc-300">Enterprise Agents</h2>
        {AGENTS.map((agent) => (
          <button
            key={agent.id}
            onClick={() => setSelected(agent.id)}
            className={
              "w-full rounded-lg border p-3 text-left transition-colors " +
              (selected === agent.id
                ? "border-blue-500/50 bg-blue-500/10"
                : "border-white/10 hover:border-white/20 bg-white/5")
            }
          >
            <div className="flex items-center gap-2">
              <agent.icon className="h-4 w-4 text-blue-400" />
              <span className="text-sm font-medium text-zinc-200">{agent.name}</span>
            </div>
            <p className="mt-1 text-xs text-zinc-500 leading-relaxed">{agent.description}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {agent.tools.map((t) => (
                <span key={t} className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-zinc-400">
                  {TOOL_LABELS[t] || t}
                </span>
              ))}
            </div>
            <div className="mt-1 text-[10px] text-zinc-600">{agent.model}</div>
          </button>
        ))}
      </div>
      <div className="flex flex-1 flex-col p-4">
        {selected ? (
          <>
            <div className="flex gap-2">
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe what you want the agent to do..."
                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/50"
                disabled={running}
              />
              <button
                onClick={runAgent}
                disabled={running || !prompt}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {running ? "Running..." : "Run"}
              </button>
            </div>
            {output && (
              <div className="mt-4 flex-1 overflow-auto rounded-lg border border-white/10 bg-white/5 p-4">
                <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-mono">{output}</pre>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">
            Select an agent to get started
          </div>
        )}
      </div>
    </div>
  )
}