"use client"

/**
 * ChatPanel — left column on the canvas page. Pairs the rich
 * DesignComposer (model picker, effort dial, visibility badge) with
 * the message history. Each send call threads the user's model
 * choice through to /api/design/:id/generate, so the backend
 * provider router picks OpenAI / OpenRouter / Gemini as the name
 * dictates.
 *
 * We don't render partial HTML into the iframe — a half-generated
 * <div> with unclosed tags produces meaningless layout thrash. The
 * generating pulse shows live char count; the iframe swaps on the
 * `final` event only.
 */

import * as React from "react"
import { motion } from "framer-motion"
import { Sparkles } from "lucide-react"
import { toast } from "sonner"

import { DesignComposer } from "./design-composer"
import {
  designService, type DesignDetail, type DesignQualityReport,
} from "@/lib/design-service"

interface Props {
  design: DesignDetail
  onUpdated: (html: string, updatedAt: string, instruction: string, quality?: DesignQualityReport | null) => void
}

export function ChatPanel({ design, onUpdated }: Props) {
  const [running, setRunning] = React.useState(false)
  const [progressChars, setProgressChars] = React.useState(0)
  const [stage, setStage] = React.useState<"generating" | "reviewing" | "repairing">("generating")
  const [quality, setQuality] = React.useState<DesignQualityReport | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [design.messages.length, running])

  async function handleSend({
    instruction, model, effort,
  }: {
    instruction: string
    model: string
    effort: "rapid" | "balanced" | "thorough"
  }) {
    if (running) return
    setRunning(true)
    setStage("generating")
    setQuality(null)
    setProgressChars(0)
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      for await (const ev of designService.generate(design.id, instruction, {
        model,
        effort,
        signal: ctrl.signal,
      })) {
        if (ev.type === "progress") setProgressChars(ev.chars)
        else if (ev.type === "review") {
          setStage("reviewing")
          setQuality(ev.quality)
        }
        else if (ev.type === "repair") {
          setStage("repairing")
          setQuality(ev.quality)
        }
        else if (ev.type === "final") onUpdated(ev.html, ev.updatedAt, instruction, ev.quality)
        else if (ev.type === "error") {
          if (ev.error !== "aborted") toast.error(ev.error)
          break
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") toast.error(err?.message || "Generation failed")
    } finally {
      abortRef.current = null
      setRunning(false)
    }
  }

  function handleStop() {
    abortRef.current?.abort()
  }

  const hasMessages = design.messages.length > 0

  return (
    <aside className="w-full lg:w-[400px] shrink-0 flex flex-col border-r border-border/60 bg-card">
      {/* Kind / name header */}
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Sparkles className="h-3 w-3" />
          {design.kind === "prototype" ? `Prototype · ${design.fidelity}` :
           design.kind === "slide_deck" ? "Slide deck" : "Project"}
        </div>
        <h1 className="text-base font-semibold tracking-tight truncate">{design.name}</h1>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {!hasMessages && !running && (
          <EmptyTips kind={design.kind} />
        )}

        {design.messages.map((m, i) => (
          <MessageBubble key={i} role={m.role} content={m.content} />
        ))}
      </div>

      {/* Composer */}
      <div className="border-t border-border/60 p-3">
        <DesignComposer
          running={running}
          progressChars={progressChars}
          stage={stage}
          quality={quality}
          onSend={handleSend}
          onStop={handleStop}
          placeholder={
            hasMessages
              ? "Solicitar cambios de seguimiento"
              : design.kind === "slide_deck"
              ? "Describe la presentación que quieres construir…"
              : design.kind === "prototype"
              ? "Describe el prototipo que quieres construir…"
              : "Describe el diseño…"
          }
        />
      </div>
    </aside>
  )
}

// ─── Subcomponents ─────────────────────────────────────────────────────────

function MessageBubble({
  role, content,
}: {
  role: "user" | "assistant"
  content: string
}) {
  if (role === "user") {
    return (
      <div className="text-right">
        <div className="inline-block rounded-2xl bg-foreground text-background px-3 py-2 text-sm max-w-[85%] text-left whitespace-pre-wrap">
          {content}
        </div>
      </div>
    )
  }
  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground rounded-full border border-border/60 bg-muted/30 px-2.5 py-1">
      <Sparkles className="h-3 w-3" />
      {content}
    </div>
  )
}

function EmptyTips({ kind }: { kind: string }) {
  const tips: string[] =
    kind === "slide_deck" ? [
      "Create a 6-slide pitch deck for a thesis-writing assistant…",
      "Design a conference keynote intro with a bold hero slide",
      "Make an internal kickoff deck in warm minimalist tones",
    ] : kind === "prototype" ? [
      "Design a dashboard showing monthly revenue with filters",
      "Build an onboarding flow with 4 screens introducing the main features",
      "Create a form for collecting feedback with conditional questions",
    ] : [
      "Build a landing page with hero, code examples and pricing",
      "Design an internal tool to review and approve submissions",
    ]
  return (
    <div className="text-xs text-muted-foreground">
      <div className="font-medium mb-2 text-foreground/80">Prompt ideas</div>
      <ul className="space-y-1.5">
        {tips.map((t, i) => (
          <li key={i} className="leading-snug pl-2 border-l-2 border-muted-foreground/20">
            {t}
          </li>
        ))}
      </ul>
    </div>
  )
}
