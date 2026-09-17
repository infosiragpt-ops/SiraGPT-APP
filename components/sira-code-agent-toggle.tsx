"use client"

/**
 * Construir | Planificar — OpenCode-style Tab, Spanish labels only.
 * Lives on /agentes. Does not revive /code.
 */

import * as React from "react"

import { opencodeService } from "@/lib/opencode/opencode-service"
import {
  DEFAULT_SIRA_CODE_AGENT,
  SIRA_CODE_AGENTS,
  SIRA_CODE_AGENT_STORAGE_KEY,
  type SiraCodeAgentId,
  resolveSiraCodeAgentId,
  siraCodeAgentLabel,
} from "@/lib/sira-code/agent-mode"
import { cn } from "@/lib/utils"

type Props = {
  sessionId?: string | null
  onSession?: (id: string) => void
  onAgentChange?: (id: SiraCodeAgentId) => void
  className?: string
}

export function SiraCodeAgentToggle({
  sessionId,
  onSession,
  onAgentChange,
  className,
}: Props) {
  const [agent, setAgent] = React.useState<SiraCodeAgentId>(DEFAULT_SIRA_CODE_AGENT)
  const [busy, setBusy] = React.useState(false)
  const sessionRef = React.useRef<string | null>(sessionId || null)

  React.useEffect(() => {
    if (typeof window === "undefined") return
    setAgent(resolveSiraCodeAgentId(window.localStorage.getItem(SIRA_CODE_AGENT_STORAGE_KEY)))
  }, [])

  React.useEffect(() => {
    if (sessionId) sessionRef.current = sessionId
  }, [sessionId])

  const apply = React.useCallback(async (next: SiraCodeAgentId) => {
    if (next === agent || busy) return
    setAgent(next)
    onAgentChange?.(next)
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SIRA_CODE_AGENT_STORAGE_KEY, next)
    }
    setBusy(true)
    try {
      let id = sessionRef.current
      if (!id) {
        const session = await opencodeService.createSession({ agent: next })
        id = typeof session.id === "string" ? session.id : null
        if (id) {
          sessionRef.current = id
          onSession?.(id)
        }
      } else {
        await opencodeService.switchAgent(id, next)
      }
    } catch {
      /* engine offline — local toggle still stands */
    } finally {
      setBusy(false)
    }
  }, [agent, busy, onAgentChange, onSession])

  return (
    <div
      className={cn("sira-code-agent-toggle flex items-center gap-1", className)}
      data-testid="sira-code-agent-toggle"
      role="tablist"
      aria-label="Modo del agente de código"
    >
      {SIRA_CODE_AGENTS.map((row) => {
        const selected = agent === row.id
        return (
          <button
            key={row.id}
            type="button"
            role="tab"
            aria-selected={selected}
            data-agent={row.id}
            data-testid={`sira-code-agent-${row.id}`}
            disabled={busy && !selected}
            onClick={() => { void apply(row.id) }}
            className={cn(
              "h-7 rounded-full px-2.5 text-xs font-medium transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
              selected
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            )}
          >
            {row.label}
          </button>
        )
      })}
      <span className="sr-only">{siraCodeAgentLabel(agent)}</span>
    </div>
  )
}

export default SiraCodeAgentToggle
