"use client"

import { useEffect, useMemo, useState, type CSSProperties } from "react"
import { ArrowRight, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { DIMENSION_META } from "@/lib/builder/dimensions"
import type { AnswerValue, QuestionCard as QuestionCardType } from "@/lib/builder/intake-service"

interface QuestionCardProps {
  card: QuestionCardType
  busy?: boolean
  onSubmit: (value: AnswerValue) => void
}

const accent = "hsl(var(--accent-violet))"
const ringStyle = { "--tw-ring-color": accent } as CSSProperties

/** A single intake question, rendered per its `type`. */
export function QuestionCard({ card, busy = false, onSubmit }: QuestionCardProps) {
  const meta = DIMENSION_META[card.dimension]
  const Icon = meta.icon
  const isMulti = card.type === "multiselect"

  const [picked, setPicked] = useState<string[]>([])
  const [text, setText] = useState("")

  // Reset local state whenever the question changes.
  useEffect(() => {
    setPicked([])
    setText("")
  }, [card.id])

  const canSubmit = useMemo(() => {
    if (card.type === "text") return text.trim().length > 0
    return picked.length > 0 || text.trim().length > 0
  }, [card.type, picked, text])

  function toggle(option: string) {
    if (isMulti) {
      setPicked((prev) => (prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option]))
    } else {
      // Single-select: choosing an option with no free-text submits immediately.
      if (!card.allowFreeText) {
        onSubmit(option)
        return
      }
      setPicked([option])
    }
  }

  function handleSubmit() {
    if (!canSubmit || busy) return
    const extras = text
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)

    if (card.type === "text") {
      onSubmit(text.trim())
      return
    }
    if (isMulti) {
      onSubmit([...new Set([...picked, ...extras])])
      return
    }
    // single select / chips
    onSubmit(text.trim() ? text.trim() : picked[0])
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
      {/* Dimension tag */}
      <div className="mb-3 flex items-center gap-2">
        <span
          className="grid h-7 w-7 place-items-center rounded-md border border-border"
          style={{ background: "hsl(var(--accent))" }}
        >
          <Icon className="h-3.5 w-3.5" style={{ color: accent }} />
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {meta.label}
        </span>
      </div>

      {/* Prompt */}
      <h2 className="mb-5 text-balance text-xl font-semibold leading-snug text-foreground sm:text-2xl">
        {card.prompt}
      </h2>

      {/* Inputs */}
      {card.type === "text" ? (
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit()
          }}
          placeholder="Escribe tu respuesta…  (⌘/Ctrl + Enter para continuar)"
          className="min-h-[120px] resize-none border-border bg-card text-base focus-visible:ring-1"
          style={ringStyle}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {card.options.map((option) => {
              const active = picked.includes(option)
              return (
                <button
                  key={option}
                  type="button"
                  disabled={busy}
                  onClick={() => toggle(option)}
                  className={cn(
                    "group relative rounded-full border px-4 py-2 text-sm font-medium transition-all",
                    "hover:-translate-y-0.5 disabled:opacity-50",
                    active
                      ? "border-transparent text-white shadow-lg"
                      : "border-border bg-card text-foreground hover:border-foreground/30",
                  )}
                  style={active ? { background: accent, boxShadow: `0 8px 24px -8px ${accent}` } : undefined}
                >
                  {option}
                </button>
              )
            })}
          </div>

          {card.allowFreeText && (
            <div className="flex items-center gap-2">
              <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    handleSubmit()
                  }
                }}
                placeholder={isMulti ? "Añadir otra, separadas por comas…" : "O escribe la tuya…"}
                className="h-10 border-border bg-card focus-visible:ring-1"
                style={ringStyle}
              />
            </div>
          )}
        </div>
      )}

      {/* Continue — hidden for single-select chips with no free text (they auto-advance) */}
      {!(card.type !== "text" && !isMulti && !card.allowFreeText) && (
        <div className="mt-6 flex justify-end">
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit || busy}
            className="gap-2 text-white"
            style={{ background: accent }}
          >
            Continuar
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
