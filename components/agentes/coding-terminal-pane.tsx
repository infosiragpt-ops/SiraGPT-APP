"use client"

/**
 * WebSocket-ready terminal stub for the /agentes coding IDE.
 * xterm.js is not added in this PR (license/SBOM later). Exec goes
 * through POST /sessions/:id/exec until a WS attach exists.
 */

import * as React from "react"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

type Props = {
  sessionId: string | null
  busy?: boolean
  lastOutput?: string
  onExec: (command: string) => Promise<void>
  wsUrl?: string | null
}

export function CodingTerminalPane({ sessionId, busy, lastOutput, onExec, wsUrl = null }: Props) {
  const [command, setCommand] = React.useState("")

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const next = command.trim()
    if (!next || !sessionId || busy) return
    await onExec(next)
    setCommand("")
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="agentes-coding-terminal"
      data-ws-ready="1"
      data-ws-url={wsUrl || ""}
    >
      <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
        Terminal (pendiente de WebSocket). Los comandos usan la sesión del sandbox.
      </p>
      <pre
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs text-foreground"
        data-testid="agentes-coding-terminal-output"
      >
        {lastOutput || (sessionId
          ? "Sesión lista. Escribe un comando."
          : "Crea una sesión para usar el terminal.")}
      </pre>
      <form className="flex items-center gap-2 border-t border-border p-2" onSubmit={submit}>
        <label className="sr-only" htmlFor="agentes-coding-terminal-input">
          Comando
        </label>
        <input
          id="agentes-coding-terminal-input"
          data-testid="agentes-coding-terminal-input"
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="comando…"
          disabled={!sessionId || busy}
        />
        <button
          type="submit"
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs"
          disabled={!sessionId || busy || !command.trim()}
        >
          {busy ? <ThinkingIndicator size="xs" label="Ejecutando" /> : null}
          Ejecutar
        </button>
      </form>
    </div>
  )
}
