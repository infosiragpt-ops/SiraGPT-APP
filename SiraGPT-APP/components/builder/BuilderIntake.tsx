"use client"

import { Check, Sparkles, TriangleAlert, Wand2 } from "lucide-react"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { DIMENSION_META } from "@/lib/builder/dimensions"
import { useIntake } from "@/lib/builder/useIntake"
import type { AnswerValue } from "@/lib/builder/intake-service"
import { QuestionCard } from "./QuestionCard"
import { CoverageRail } from "./CoverageRail"
import { ResultPanel } from "./ResultPanel"

const accent = "hsl(var(--accent-violet))"

function renderValue(value: AnswerValue): string {
  return Array.isArray(value) ? value.join(", ") : value
}

export function BuilderIntake() {
  const intake = useIntake()
  const {
    phase, coverage, question, transcript, integrations, constraints,
    result, busy, error, setIntegrations, setConstraints, submit, generate, reset,
  } = intake

  if (phase === "result" && result) {
    return <ResultPanel result={result} onReset={reset} />
  }

  const complete = coverage?.complete ?? false

  return (
    <div className="grid gap-8 md:grid-cols-[200px_1fr]">
      {/* Coverage rail */}
      <aside className="md:sticky md:top-24 md:self-start">
        <CoverageRail coverage={coverage} active={question?.dimension ?? null} />
      </aside>

      {/* Conversation */}
      <div className="min-w-0">
        {error && (
          <div className="mb-5 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Answered so far */}
        {transcript.length > 0 && (
          <div className="mb-6 space-y-2.5">
            {transcript.map((entry) => {
              const meta = DIMENSION_META[entry.card.dimension]
              return (
                <div
                  key={entry.card.dimension}
                  className="flex items-start gap-3 rounded-lg border border-border/60 bg-card/40 px-3 py-2 animate-in fade-in"
                >
                  <Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: accent }} />
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {meta.label}
                    </p>
                    <p className="truncate text-sm text-foreground">{renderValue(entry.value)}</p>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {phase === "loading" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ThinkingIndicator size="sm" /> Preparando la entrevista…
          </div>
        )}

        {phase === "generating" && (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <ThinkingIndicator size="md" label="Generando proyecto" className="mx-auto mb-3" />
            <p className="text-sm font-medium text-foreground">Generando tu proyecto…</p>
            <p className="mt-1 text-xs text-muted-foreground">Brief → blueprint → archivos starter</p>
          </div>
        )}

        {/* Current question */}
        {phase === "intake" && question && (
          <div className="rounded-xl border border-border bg-card/50 p-5 sm:p-6">
            <QuestionCard card={question} busy={busy} onSubmit={(value) => submit(question, value)} />
          </div>
        )}

        {/* Completion → generate */}
        {phase === "intake" && complete && (
          <div className="mt-2 rounded-xl border bg-card/50 p-5 sm:p-6" style={{ borderColor: `hsl(var(--accent-violet) / 0.4)` }}>
            <div className="mb-4 flex items-center gap-2">
              <Sparkles className="h-4 w-4" style={{ color: accent }} />
              <h2 className="text-lg font-semibold text-foreground">Contexto completo · listo para construir</h2>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Integraciones (opcional)
                </label>
                <Input
                  defaultValue={integrations.join(", ")}
                  onChange={(e) => setIntegrations(e.target.value.split(/[,;]+/).map((s) => s.trim()).filter(Boolean))}
                  placeholder="Stripe, SendGrid, Google Maps…"
                  className="h-10 border-border bg-card"
                />
              </div>
              <div>
                <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Restricciones (opcional)
                </label>
                <Textarea
                  value={constraints}
                  onChange={(e) => setConstraints(e.target.value)}
                  placeholder="Entregar en 2 semanas, presupuesto bajo…"
                  className="min-h-[40px] resize-none border-border bg-card"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <Button
                onClick={generate}
                disabled={busy}
                size="lg"
                className="gap-2 text-white shadow-lg"
                style={{ background: accent, boxShadow: `0 12px 32px -12px ${accent}` }}
              >
                <Wand2 className="h-4 w-4" />
                Generar proyecto
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
