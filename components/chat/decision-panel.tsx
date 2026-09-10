"use client"

import * as React from "react"
import { ArrowRight, ChevronLeft, ChevronRight, Pencil, X } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { apiClient } from "@/lib/api"
import { agentTaskService } from "@/lib/agent-task-service"
import {
  formatDecisionAnswers,
  recommendedOption,
  type ChatDecisionOption,
  type ChatDecisionQuestion,
  type ChatDecisionRequest,
} from "@/lib/chat-work-status"

export type ChatDecisionPanelProps = {
  request: ChatDecisionRequest
  onReply: (text: string) => void
  onResolved?: () => void
}

type AnswerMap = Record<string, ChatDecisionOption>

function pickDefault(question: ChatDecisionQuestion): ChatDecisionOption | null {
  return recommendedOption(question)
}

export function ChatDecisionPanel({ request, onReply, onResolved }: ChatDecisionPanelProps) {
  const questions = request.questions
  const [index, setIndex] = React.useState(0)
  const [answers, setAnswers] = React.useState<AnswerMap>({})
  const [busy, setBusy] = React.useState(false)
  const [answered, setAnswered] = React.useState(false)
  const [customOpen, setCustomOpen] = React.useState(false)
  const [customText, setCustomText] = React.useState("")
  const question = questions[index]
  const selected = (question && answers[question.id]) || pickDefault(question)

  React.useEffect(() => {
    setIndex(0)
    setAnswers({})
    setCustomOpen(false)
    setCustomText("")
    setAnswered(false)
    setBusy(false)
  }, [request.permissionId, request.runId, questions.map((item) => item.id).join("|")])

  if (answered || !question) return null

  const total = questions.length
  const finishWith = async (finalAnswers: AnswerMap) => {
    if (busy) return
    setBusy(true)
    const first = questions[0] ? finalAnswers[questions[0].id] : null
    try {
      if (request.kind === "permission" && request.permissionId && first) {
        const decision = first.id as "allow" | "always_allow_in_chat" | "deny"
        await apiClient.resolveAgentPermission(request.permissionId, decision)
      } else if (request.kind === "approval" && request.runId && first && (first.id === "approve" || first.id === "reject")) {
        const result = await agentTaskService.resolveApproval(request.runId, first.id)
        if (!result.ok) throw new Error(result.error || "No se pudo registrar la aprobación")
      } else {
        const text = formatDecisionAnswers(questions, finalAnswers)
        if (text) onReply(text)
      }
      setAnswered(true)
      onResolved?.()
    } catch (error: any) {
      toast.error(error?.message || "No se pudo enviar tu respuesta. Inténtalo de nuevo.")
      setBusy(false)
    }
  }

  const recordAndAdvance = (option: ChatDecisionOption) => {
    if (busy || !question) return
    const nextAnswers = { ...answers, [question.id]: option }
    setAnswers(nextAnswers)
    setCustomOpen(false)
    setCustomText("")
    if (index < total - 1) {
      setIndex(index + 1)
      return
    }
    void finishWith(nextAnswers)
  }

  const skipCurrent = () => {
    const fallback = pickDefault(question)
    if (!fallback) return
    recordAndAdvance(fallback)
  }

  const skipRemaining = () => {
    const nextAnswers = { ...answers }
    for (let i = index; i < questions.length; i += 1) {
      const item = questions[i]
      if (!item || nextAnswers[item.id]) continue
      const fallback = pickDefault(item)
      if (fallback) nextAnswers[item.id] = fallback
    }
    void finishWith(nextAnswers)
  }

  const sendCustom = () => {
    const text = customText.trim()
    if (!text || !question) return
    recordAndAdvance({
      id: `custom-${question.id}`,
      label: text,
      replyText: text,
    })
  }

  return (
    <section
      data-testid="chat-decision-panel"
      aria-label="El agente necesita tu decisión"
      className="rounded-2xl border border-border/80 bg-background px-3.5 py-3 shadow-[0_8px_24px_-20px_hsl(220_24%_14%_/_0.28)]"
    >
      <header className="flex items-start gap-3">
        <h2 className="min-w-0 flex-1 text-[14.5px] font-medium leading-5 text-foreground">
          {question.text}
        </h2>
        <div className="flex shrink-0 items-center gap-0.5 pt-0.5 text-[12px] text-muted-foreground">
          {total > 1 ? (
            <>
              <button
                type="button"
                disabled={busy || index === 0}
                onClick={() => setIndex((value) => Math.max(0, value - 1))}
                aria-label="Pregunta anterior"
                className="inline-grid h-7 w-7 place-items-center rounded-md hover:bg-muted disabled:opacity-30"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="tabular-nums">{index + 1} de {total}</span>
              <button
                type="button"
                disabled={busy || index >= total - 1}
                onClick={() => setIndex((value) => Math.min(total - 1, value + 1))}
                aria-label="Pregunta siguiente"
                className="inline-grid h-7 w-7 place-items-center rounded-md hover:bg-muted disabled:opacity-30"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </>
          ) : null}
          {request.allowSkip ? (
            <button
              type="button"
              disabled={busy}
              onClick={skipRemaining}
              aria-label="Omitir y continuar"
              className="inline-grid h-7 w-7 place-items-center rounded-md hover:bg-muted"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="mt-2.5 rounded-xl border border-border/80 bg-muted/15 p-1">
        {question.options.map((option, optionIndex) => {
          const isSelected = selected?.id === option.id
          const recommended = Boolean(option.recommended)
          return (
            <button
              key={option.id}
              type="button"
              disabled={busy}
              onClick={() => recordAndAdvance(option)}
              className={cn(
                "flex w-full items-start gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors",
                optionIndex > 0 ? "mt-0.5" : "",
                isSelected
                  ? "bg-background shadow-[inset_0_0_0_1.5px_#3B82F6]"
                  : "hover:bg-background/70",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-medium",
                  isSelected ? "bg-foreground/10 text-foreground" : "bg-muted text-muted-foreground",
                )}
              >
                {optionIndex + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium leading-5 text-foreground">
                  {option.label}
                  {recommended ? (
                    <span className="font-medium text-foreground/80"> (Recomendado)</span>
                  ) : null}
                </span>
                {option.description ? (
                  <span className="mt-0.5 block text-[12.5px] leading-5 text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
              {isSelected ? (
                <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              ) : null}
            </button>
          )
        })}
      </div>

      {customOpen ? (
        <div className="mt-2.5 flex items-center gap-1.5">
          <input
            value={customText}
            autoFocus
            onChange={(event) => setCustomText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                sendCustom()
              }
            }}
            placeholder="Escribe tu respuesta…"
            disabled={busy}
            className="h-9 min-w-0 flex-1 rounded-full border border-border/70 bg-background px-3 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          <button
            type="button"
            disabled={busy || !customText.trim()}
            onClick={sendCustom}
            className="inline-flex h-9 items-center rounded-full bg-foreground px-3 text-[12px] font-medium text-background disabled:opacity-40"
          >
            Enviar
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-2">
          {request.allowCustomReply ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setCustomOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
              Algo más
            </button>
          ) : <span />}
          {request.allowSkip ? (
            <button
              type="button"
              disabled={busy}
              onClick={skipCurrent}
              className="inline-flex h-8 items-center rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Omitir
            </button>
          ) : null}
        </div>
      )}
    </section>
  )
}
