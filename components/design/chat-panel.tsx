"use client"

/**
 * ChatPanel — left column on the canvas page. User types an
 * instruction, hits send, stream fires, iframe on the right updates
 * once the full HTML is ready.
 *
 * We don't render partial HTML streams into the iframe — a half-
 * generated `<div>` with unclosed tags produces meaningless layout
 * thrash. The toolbar shows a generating pulse while the model
 * writes; the iframe swap happens on `final`.
 */

import * as React from "react"
import { motion } from "framer-motion"
import { Send, Square, Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  designService, type DesignDetail,
} from "@/lib/design-service"

interface Props {
  design: DesignDetail
  onUpdated: (html: string, updatedAt: string) => void
}

export function ChatPanel({ design, onUpdated }: Props) {
  const [instruction, setInstruction] = React.useState("")
  const [running, setRunning] = React.useState(false)
  const [progressChars, setProgressChars] = React.useState(0)
  const abortRef = React.useRef<AbortController | null>(null)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  // Scroll the chat to bottom whenever messages change
  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [design.messages.length, running])

  async function send() {
    const q = instruction.trim()
    if (!q || running) return
    setInstruction("")
    setRunning(true)
    setProgressChars(0)
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      for await (const ev of designService.generate(design.id, q, ctrl.signal)) {
        if (ev.type === "progress") setProgressChars(ev.chars)
        else if (ev.type === "final") onUpdated(ev.html, ev.updatedAt)
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

  function stop() {
    abortRef.current?.abort()
  }

  const hasMessages = design.messages.length > 0

  return (
    <aside className="w-full lg:w-[380px] shrink-0 flex flex-col border-r border-border/60 bg-card">
      {/* Header */}
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

        {running && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Generating{progressChars > 0 && ` · ${progressChars.toLocaleString()} chars`}</span>
          </motion.div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-border/60 p-3">
        <div className="rounded-xl border border-border/60 bg-background focus-within:border-foreground/40 transition-colors">
          <Textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={hasMessages ? "Refine or ask for changes…" : "Describe what to build…"}
            rows={3}
            disabled={running}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            className="border-0 resize-none text-sm focus-visible:ring-0 focus-visible:ring-offset-0 min-h-[64px]"
          />
          <div className="flex items-center justify-end px-2 pb-2">
            {running ? (
              <Button onClick={stop} variant="outline" size="sm" className="gap-1.5 h-8">
                <Square className="h-3 w-3" /> Stop
              </Button>
            ) : (
              <Button
                onClick={send}
                disabled={!instruction.trim()}
                size="sm"
                className={cn("gap-1.5 h-8")}
              >
                <Send className="h-3 w-3" />
                Send
              </Button>
            )}
          </div>
        </div>
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
