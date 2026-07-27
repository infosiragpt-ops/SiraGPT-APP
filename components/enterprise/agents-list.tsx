"use client"

/**
 * Enterprise Agents console — Claude Code-style run surface for the Agents SDK.
 * Streams SSE from /api/agents/run and renders a live tool timeline (not just tokens).
 */

import * as React from "react"
import {
  Bot,
  Shield,
  Search,
  Wrench,
  Building2,
  Loader2,
  Square,
  CheckCircle2,
  XCircle,
  Terminal,
  FileCode2,
  Globe,
} from "lucide-react"
import { authenticatedFetch } from "@/lib/authenticated-fetch"

interface AgentCard {
  id: string
  name: string
  description: string
  model: string
  tools: string[]
  icon: React.ElementType
  badge?: string
}

type TimelineEvent =
  | { kind: "token"; text: string }
  | { kind: "tool_call"; id: string; name: string; args: string }
  | { kind: "tool_result"; id: string; name: string; ok: boolean; summary: string; result: string }
  | { kind: "plan"; text: string }
  | { kind: "subagent"; name: string; result: string }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string }

const AGENTS: AgentCard[] = [
  {
    id: "enterprise-builder",
    name: "Enterprise Software",
    description:
      "CRM, ERP, inventario, facturación, RRHH, POS. Módulos, roles, KPIs y datos realistas del dominio.",
    model: "Claude Sonnet 4",
    tools: ["read", "write", "edit", "bash", "glob", "grep", "web_search", "spawn_subagent"],
    icon: Building2,
    badge: "Empresa",
  },
  {
    id: "builder",
    name: "Builder Full-Stack",
    description: "Apps web con Next.js / React / Tailwind. Planifica, escribe y verifica en el sandbox.",
    model: "Claude Sonnet 4",
    tools: ["read", "write", "edit", "bash", "glob", "grep", "web_search", "web_fetch", "spawn_subagent"],
    icon: Wrench,
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description: "Bugs, seguridad OWASP, rendimiento y estilo. Solo lectura + búsqueda.",
    model: "Claude Sonnet 4",
    tools: ["read", "glob", "grep", "web_search"],
    icon: Shield,
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Investigación profunda con web_search + web_fetch e informe con fuentes.",
    model: "Claude Sonnet 4",
    tools: ["web_search", "web_fetch"],
    icon: Search,
  },
]

const TOOL_LABELS: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  glob: "Glob",
  grep: "Grep",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  spawn_subagent: "Subagent",
}

const TOOL_ICON: Record<string, React.ElementType> = {
  bash: Terminal,
  read: FileCode2,
  write: FileCode2,
  edit: FileCode2,
  glob: FileCode2,
  grep: FileCode2,
  web_search: Globe,
  web_fetch: Globe,
  spawn_subagent: Bot,
}

const PROMPTS: Record<string, string[]> = {
  "enterprise-builder": [
    "Crea un CRM de ventas con pipeline, clientes, cotizaciones y dashboard de KPIs",
    "Construye un sistema de inventario multi-almacén con movimientos y stock mínimo",
    "App de facturación electrónica con clientes, productos, impuestos y estados de factura",
  ],
  builder: [
    "Landing page premium para una fintech de remesas con hero, pricing y CTA",
    "Dashboard SaaS de analytics con gráficos y tabla de usuarios",
  ],
  "code-reviewer": [
    "Revisa el README del workspace y propone un checklist de seguridad",
  ],
  researcher: [
    "Compara Claude Agent SDK, Cursor agents y OpenAI Codex para un producto SaaS de coding agents",
  ],
}

export function AgentsList() {
  const [selected, setSelected] = React.useState<string>("enterprise-builder")
  const [prompt, setPrompt] = React.useState("")
  const [mode, setMode] = React.useState<"auto" | "plan" | "build">("auto")
  const [running, setRunning] = React.useState(false)
  const [events, setEvents] = React.useState<TimelineEvent[]>([])
  const [sessionId, setSessionId] = React.useState<string | null>(null)
  const [files, setFiles] = React.useState<string[]>([])
  const abortRef = React.useRef<AbortController | null>(null)
  const scrollerRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight })
  }, [events])

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
  }

  const runAgent = async () => {
    if (!selected || !prompt.trim() || running) return
    setRunning(true)
    setEvents([{ kind: "status", text: `Iniciando ${selected}…` }])
    setFiles([])

    const ac = new AbortController()
    abortRef.current = ac

    try {
      const res = await authenticatedFetch("/api/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: selected,
          prompt: prompt.trim(),
          mode,
          session_id: sessionId || undefined,
        }),
        signal: ac.signal,
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => "")
        setEvents((prev) => [
          ...prev,
          { kind: "error", text: `HTTP ${res.status}: ${errText.slice(0, 400)}` },
        ])
        return
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error("No stream")

      const decoder = new TextDecoder()
      let buffer = ""
      let eventName = "message"

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split("\n\n")
        buffer = chunks.pop() || ""

        for (const chunk of chunks) {
          const lines = chunk.split("\n")
          let dataLine = ""
          for (const line of lines) {
            if (line.startsWith("event: ")) eventName = line.slice(7).trim()
            if (line.startsWith("data: ")) dataLine = line.slice(6)
          }
          if (!dataLine) continue
          let data: any
          try {
            data = JSON.parse(dataLine)
          } catch {
            continue
          }

          if (eventName === "agent_start" && data.session_id) {
            setSessionId(data.session_id)
            setEvents((prev) => [
              ...prev,
              { kind: "status", text: `Sesión ${data.session_id} · modelo ${data.model}` },
            ])
          } else if (eventName === "token" && data.t) {
            setEvents((prev) => {
              const last = prev[prev.length - 1]
              if (last?.kind === "token") {
                return [...prev.slice(0, -1), { kind: "token", text: last.text + data.t }]
              }
              return [...prev, { kind: "token", text: data.t }]
            })
          } else if (eventName === "tool_call") {
            setEvents((prev) => [
              ...prev,
              {
                kind: "tool_call",
                id: data.id,
                name: data.name,
                args: String(data.args || "").slice(0, 500),
              },
            ])
          } else if (eventName === "tool_result") {
            setEvents((prev) => [
              ...prev,
              {
                kind: "tool_result",
                id: data.id,
                name: data.name,
                ok: Boolean(data.ok),
                summary: String(data.summary || ""),
                result: String(data.result || "").slice(0, 2000),
              },
            ])
          } else if (eventName === "plan") {
            setEvents((prev) => [...prev, { kind: "plan", text: String(data.text || "") }])
          } else if (eventName === "subagent_result") {
            setEvents((prev) => [
              ...prev,
              { kind: "subagent", name: String(data.name || "sub"), result: String(data.result || "") },
            ])
          } else if (eventName === "done") {
            if (Array.isArray(data.files)) setFiles(data.files)
            if (data.session_id) setSessionId(data.session_id)
            setEvents((prev) => [
              ...prev,
              {
                kind: "status",
                text: `Listo · ${data.turns ?? 0} turns · cost $${Number(data.cost || 0).toFixed(4)}`,
              },
            ])
          } else if (eventName === "error") {
            setEvents((prev) => [...prev, { kind: "error", text: String(data.message || data) }])
          }
        }
      }
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") {
        setEvents((prev) => [...prev, { kind: "error", text: String(e) }])
      } else {
        setEvents((prev) => [...prev, { kind: "status", text: "Cancelado por el usuario" }])
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  const suggestions = PROMPTS[selected] || []

  return (
    <div className="flex h-full w-full min-h-0">
      <div className="w-80 shrink-0 space-y-3 overflow-auto border-r border-white/10 p-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">Enterprise Agents</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            Agents SDK con tools reales en sandbox (Read/Write/Edit/Bash/Glob/Grep/Web). Igual patrón que
            Claude Code / Cursor / Codex.
          </p>
        </div>
        {AGENTS.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => setSelected(agent.id)}
            className={
              "w-full rounded-lg border p-3 text-left transition-colors " +
              (selected === agent.id
                ? "border-violet-500/50 bg-violet-500/10"
                : "border-white/10 bg-white/5 hover:border-white/20")
            }
          >
            <div className="flex items-center gap-2">
              <agent.icon className="h-4 w-4 text-violet-300" />
              <span className="text-sm font-medium text-zinc-200">{agent.name}</span>
              {agent.badge && (
                <span className="ml-auto rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] text-violet-200">
                  {agent.badge}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">{agent.description}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {agent.tools.map((t) => (
                <span key={t} className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-zinc-400">
                  {TOOL_LABELS[t] || t}
                </span>
              ))}
            </div>
          </button>
        ))}
        {sessionId && (
          <div className="rounded-md border border-white/10 bg-white/[0.03] p-2 text-[10px] text-zinc-500">
            Session: <span className="font-mono text-zinc-300">{sessionId}</span>
            {files.length > 0 && (
              <div className="mt-1 max-h-24 overflow-auto">
                {files.map((f) => (
                  <div key={f} className="truncate font-mono text-zinc-400">
                    {f}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2">
          {(["auto", "plan", "build"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={
                "rounded-md px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide " +
                (mode === m ? "bg-white/15 text-white" : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300")
              }
            >
              {m}
            </button>
          ))}
          <span className="ml-auto text-[11px] text-zinc-600">
            Plan = solo plan · Auto/Build = loop con tools
          </span>
        </div>

        <div ref={scrollerRef} className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
          {events.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <Bot className="h-8 w-8 text-zinc-600" />
              <p className="max-w-md text-sm text-zinc-500">
                Elige un agente y describe el software o la tarea. Verás tools en vivo como en Claude Code.
              </p>
              <div className="flex max-w-lg flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setPrompt(s)}
                    className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-left text-[11px] text-zinc-400 hover:border-violet-500/40 hover:text-zinc-200"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            events.map((ev, i) => <TimelineRow key={i} event={ev} />)
          )}
        </div>

        <div className="border-t border-white/10 p-3">
          <div className="flex gap-2">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void runAgent()
                }
              }}
              placeholder="Describe el software empresarial o la tarea del agente… (⌘/Ctrl+Enter)"
              rows={2}
              disabled={running}
              className="min-h-[44px] flex-1 resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500/50 focus:outline-none"
            />
            {running ? (
              <button
                type="button"
                onClick={stop}
                className="flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-500/20"
              >
                <Square className="h-3.5 w-3.5" /> Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void runAgent()}
                disabled={!prompt.trim()}
                className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Run
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  if (event.kind === "token") {
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
        <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-zinc-200">{event.text}</pre>
      </div>
    )
  }
  if (event.kind === "plan") {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200">Plan</div>
        <pre className="whitespace-pre-wrap font-sans text-sm text-amber-50/90">{event.text}</pre>
      </div>
    )
  }
  if (event.kind === "tool_call") {
    const Icon = TOOL_ICON[event.name] || Terminal
    return (
      <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-sky-200">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <Icon className="h-3.5 w-3.5" />
          <span className="font-mono font-medium">{TOOL_LABELS[event.name] || event.name}</span>
        </div>
        {event.args && (
          <pre className="mt-1 max-h-24 overflow-auto font-mono text-[10px] text-sky-100/60">
            {event.args}
          </pre>
        )}
      </div>
    )
  }
  if (event.kind === "tool_result") {
    return (
      <div
        className={
          "rounded-lg border px-3 py-2 " +
          (event.ok ? "border-emerald-500/20 bg-emerald-500/5" : "border-red-500/20 bg-red-500/5")
        }
      >
        <div className="flex items-center gap-2 text-xs">
          {event.ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-red-400" />
          )}
          <span className="font-mono text-zinc-300">{TOOL_LABELS[event.name] || event.name}</span>
          <span className="text-zinc-500">{event.summary}</span>
        </div>
        {event.result && (
          <pre className="mt-1 max-h-40 overflow-auto font-mono text-[10px] text-zinc-400">{event.result}</pre>
        )}
      </div>
    )
  }
  if (event.kind === "subagent") {
    return (
      <div className="rounded-lg border border-violet-500/25 bg-violet-500/10 p-3">
        <div className="mb-1 text-[10px] font-semibold uppercase text-violet-200">Subagent · {event.name}</div>
        <pre className="whitespace-pre-wrap text-xs text-violet-50/80">{event.result}</pre>
      </div>
    )
  }
  if (event.kind === "error") {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
        {event.text}
      </div>
    )
  }
  return <div className="text-[11px] text-zinc-500">{event.text}</div>
}
