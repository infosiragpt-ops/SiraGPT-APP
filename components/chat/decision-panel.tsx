"use client"

import * as React from "react"
import { Hand } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { apiClient } from "@/lib/api"
import { agentTaskService } from "@/lib/agent-task-service"
import type { ChatDecisionOption, ChatDecisionRequest } from "@/lib/chat-work-status"

export type ChatDecisionPanelProps = {
  request: ChatDecisionRequest
  onReply: (text: string) => void
  onResolved?: () => void
}

export function ChatDecisionPanel({ request, onReply, onResolved }: ChatDecisionPanelProps) {
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [customReply, setCustomReply] = React.useState("")
  const [answered, setAnswered] = React.useState(false)

  if (answered) return null

  const finish = () => {
    setAnswered(true)
    onResolved?.()
  }

  const choose = async (option: ChatDecisionOption) => {
    if (busyId) return
    setBusyId(option.id)
    try {
      if (request.kind === "permission" && request.permissionId) {
        const decision = option.id as "allow" | "always_allow_in_chat" | "deny"
        await apiClient.resolveAgentPermission(request.permissionId, decision)
      } else if (request.kind === "approval" && request.runId && (option.id === "approve" || option.id === "reject")) {
        const result = await agentTaskService.resolveApproval(request.runId, option.id)
        if (!result.ok) throw new Error(result.error || "No se pudo registrar la aprobación")
      } else {
        onReply(option.replyText || option.label)
      }
      finish()
    } catch (error: any) {
      toast.error(error?.message || "No se pudo enviar tu respuesta. Inténtalo de nuevo.")
      setBusyId(null)
    }
  }

  const sendCustom = () => {
    const text = customReply.trim()
    if (!text || busyId) return
    setBusyId("custom")
    onReply(text)
    finish()
  }

  return (
    <section
      data-testid="chat-decision-panel"
      aria-label="El agente necesita tu decisión"
      className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-5 shrink-0 items-center gap-0.5" aria-hidden="true">
          <span className="h-2 w-2 rounded-full bg-amber-400" />
          <Hand className="h-3.5 w-3.5 text-amber-500" strokeWidth={2.25} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-medium text-foreground/90">{request.title}</h2>
          {request.body ? (
            <p className="mt-0.5 text-[12px] text-muted-foreground">{request.body}</p>
          ) : null}
          {request.questions.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {request.questions.map((question) => (
                <li key={question} className="text-[12.5px] leading-5 text-foreground/85">
                  {question}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-2.5 flex flex-col gap-1.5">
            {request.options.map((option) => {
              const recommended = Boolean(option.recommended)
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={Boolean(busyId)}
                  onClick={() => void choose(option)}
                  className={cn(
                    "flex min-h-9 items-center justify-between gap-2 rounded-full px-3 text-left text-[12.5px] font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    recommended
                      ? "bg-foreground text-background"
                      : "border border-border/70 bg-background text-foreground/85 hover:bg-muted/60",
                    busyId && busyId !== option.id ? "opacity-60" : "",
                  )}
                >
                  <span className="min-w-0 truncate">{option.label}</span>
                  {recommended ? (
                    <span className="shrink-0 rounded-full bg-background px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-foreground">
                      Recomendado
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          {request.allowCustomReply ? (
            <div className="mt-2.5 flex items-center gap-1.5">
              <input
                value={customReply}
                onChange={(event) => setCustomReply(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    sendCustom()
                  }
                }}
                placeholder="Escribe tu respuesta…"
                disabled={Boolean(busyId)}
                className="h-9 min-w-0 flex-1 rounded-full border border-border/70 bg-background px-3 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
              <button
                type="button"
                disabled={Boolean(busyId) || !customReply.trim()}
                onClick={sendCustom}
                className="inline-flex h-9 items-center rounded-full bg-foreground px-3 text-[12px] font-medium text-background disabled:opacity-40"
              >
                Enviar
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
