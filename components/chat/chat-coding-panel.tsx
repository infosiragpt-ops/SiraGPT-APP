"use client"

import * as React from "react"
import { CodingIdeShell } from "@/components/agentes/coding-ide-shell"
import { coreCodexApi } from "@/lib/codex/api/core"

export default function ChatCodingPanel({ chatId, onClose, onProjectReady }: {
  chatId: string
  onClose: () => void
  onProjectReady: (ready: boolean) => void
}) {
  const [state, setState] = React.useState<"loading" | "ready" | "error">("loading")
  const [error, setError] = React.useState("")
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    let cancelled = false
    setState("loading")
    onProjectReady(false)
    void coreCodexApi.access().then((access) => {
      if (cancelled) return
      if (!access.enabled || !access.canRun) throw new Error("La programación no está habilitada para esta cuenta. Solicita acceso al administrador.")
      setState("ready")
    }).catch((err) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : "No se pudo comprobar el acceso al proyecto.")
      setState("error")
    })
    return () => { cancelled = true }
  }, [chatId, attempt, onProjectReady])
  if (state === "ready") return <CodingIdeShell key={chatId} conversationId={chatId} embedded onClose={onClose} onProjectReady={onProjectReady} />
  return <section className="flex h-full flex-col gap-4 border-l border-border bg-background p-4" aria-label="Código" data-testid="chat-coding-panel-status">
    <div className="flex items-center justify-between"><h2 className="font-medium">Código</h2><button type="button" onClick={onClose}>Cerrar</button></div>
    {state === "loading" ? <p role="status">Preparando tu espacio de código…</p> : <><p role="alert">{error}</p><button type="button" onClick={() => setAttempt((n) => n + 1)}>Reintentar</button></>}
  </section>
}
