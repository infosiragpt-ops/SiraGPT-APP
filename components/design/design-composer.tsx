"use client"

/**
 * DesignComposer — the rich composer for the design canvas.
 *
 * Mirrors siraGPT's main chat composer: + attachment, safety badge
 * with dropdown, model picker (REAL — drives the generator provider
 * routing), effort dial, mic, and an arrow send button. Matches the
 * reference screenshot from the user's brief.
 *
 * Stubs are labelled explicitly:
 *   - + attachment         → toast "próximamente" (adding images to
 *                            the prompt needs multimodal routing per
 *                            provider; scoped for a follow-up).
 *   - safety badge         → dropdown with PRIVATE | ORG (PRIVATE
 *                            selected; ORG coming with sharing).
 *   - mic                  → toast "próximamente" (re-uses existing
 *                            Whisper flow, but the design surface
 *                            doesn't plumb transcripts yet).
 *
 * REAL:
 *   - model picker         → fetches /api/ai/models, curates a small
 *                            list of design-appropriate models plus
 *                            "more…" for the full 345, and threads
 *                            the selection into the generate call.
 *   - effort dial          → UI stub that maps to a future knob on
 *                            the generator (temperature / max_tokens
 *                            / creativity). For MVP the button reads
 *                            the current effort label.
 */

import * as React from "react"
import {
  Plus, ShieldAlert, ChevronDown, Brain, Mic, ArrowUp, Square, Check} from "lucide-react"
import { toast } from "sonner"
import { motion, AnimatePresence } from "framer-motion"

import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { DesignQualityReport } from "@/lib/design-service"
import { normalizeChatInput, shouldWarnUser } from "@/lib/chat-input-normalize"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
// ─── Models API + curation ────────────────────────────────────────────────

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

interface AiModel {
  id: string
  name: string
  displayName?: string
  provider?: string
}

// Featured set for design-studio tasks. If none of these are present
// in the DB, we fall back to whatever models the API returns.
// These ids come from siraGPT's seed — we check both bare and
// slug-prefixed names because the registry has both shapes.
const FEATURED_PATTERNS: Array<{ id: string; display: string; match: (n: string) => boolean }> = [
  { id: "anthropic/claude-opus-4.7",    display: "Claude Opus 4.7",      match: n => /anthropic\/claude-opus-4\.?7$/i.test(n) },
  { id: "anthropic/claude-opus-4.6-fast", display: "Claude Opus 4.6 Fast", match: n => /anthropic\/claude-opus-4\.?6-fast/i.test(n) },
  { id: "anthropic/claude-opus-4.6",    display: "Claude Opus 4.6",      match: n => /^anthropic\/claude-opus-4\.?6$/i.test(n) },
  { id: "anthropic/claude-sonnet-4.6",  display: "Claude Sonnet 4.6",    match: n => /anthropic\/claude-sonnet-4\.?6/i.test(n) },
  { id: "gpt-4o",                       display: "GPT-4o",               match: n => /^gpt-4o$/i.test(n) },
  { id: "gpt-4o-mini",                  display: "GPT-4o mini",          match: n => /^gpt-4o-mini$/i.test(n) },
]

async function fetchModels(): Promise<AiModel[]> {
  const res = await fetch(`${API_ROOT}/ai/models?type=TEXT`)
  if (!res.ok) return []
  const json = await res.json()
  return Array.isArray(json.models) ? json.models : []
}

// ─── Effort levels ────────────────────────────────────────────────────────

type Effort = "rapid" | "balanced" | "thorough"
const EFFORT_LABELS: Record<Effort, { label: string; desc: string }> = {
  rapid:     { label: "Rápido",      desc: "Respuestas más cortas y veloces" },
  balanced:  { label: "Equilibrado", desc: "El punto medio (recomendado)" },
  thorough:  { label: "Completo",    desc: "Más detalle y pulido; más tokens" },
}

// ─── Safety visibility ────────────────────────────────────────────────────

type Visibility = "private" | "org"
const VIS_LABELS: Record<Visibility, { label: string; desc: string; available: boolean }> = {
  private: { label: "Solo tú",        desc: "Nadie más puede ver este proyecto", available: true },
  org:     { label: "Organización",    desc: "Compartir dentro de tu org (próximamente)", available: false },
}

// ─── Component ────────────────────────────────────────────────────────────

interface Props {
  disabled?: boolean
  running?: boolean
  progressChars?: number
  stage?: "generating" | "reviewing" | "repairing"
  quality?: DesignQualityReport | null
  onSend: (opts: { instruction: string; model: string; effort: Effort }) => void
  onStop?: () => void
  placeholder?: string
  initialModel?: string
}

export function DesignComposer({
  disabled, running, progressChars = 0, stage = "generating", quality = null,
  onSend, onStop, placeholder, initialModel,
}: Props) {
  const [value, setValue] = React.useState("")
  const [models, setModels] = React.useState<AiModel[]>([])
  const [modelId, setModelId] = React.useState<string>(initialModel || "gpt-4o")
  const [effort, setEffort] = React.useState<Effort>("balanced")
  const [visibility, setVisibility] = React.useState<Visibility>("private")

  // Fetch models once on mount. If the call fails or returns an
  // empty list, keep the hardcoded default — the composer should
  // still work even without a live models endpoint.
  React.useEffect(() => {
    fetchModels()
      .then(rows => {
        if (rows.length > 0) setModels(rows)
      })
      .catch(() => { /* silent — UI keeps the default */ })
  }, [])

  // Resolve featured models that are actually present in the
  // returned list. If none match, we still expose the default
  // (gpt-4o) so the user isn't stranded.
  const featured = React.useMemo(() => {
    const names = new Set(models.map(m => m.name))
    const hits: Array<{ name: string; display: string }> = []
    for (const p of FEATURED_PATTERNS) {
      const match = models.find(m => p.match(m.name))
      if (match) hits.push({ name: match.name, display: p.display })
    }
    // Always include the current selection, even if not featured.
    if (!hits.some(h => h.name === modelId) && names.has(modelId)) {
      const m = models.find(mm => mm.name === modelId)!
      hits.unshift({ name: m.name, display: m.displayName || m.name })
    }
    // Absolute fallback
    if (hits.length === 0) hits.push({ name: "gpt-4o", display: "GPT-4o" })
    return hits
  }, [models, modelId])

  const currentDisplay = React.useMemo(() => {
    const hit = featured.find(f => f.name === modelId)
    if (hit) return hit.display
    const m = models.find(mm => mm.name === modelId)
    return m?.displayName || m?.name || modelId
  }, [featured, modelId, models])

  function submit() {
    const normalized = normalizeChatInput(value)
    if (shouldWarnUser(normalized)) {
      toast.error(
        `La instrucción supera el límite (${normalized.originalLength.toLocaleString()} caracteres). Se recortó.`,
        { duration: 4500 },
      )
    }
    const text = normalized.value.trim()
    if (!text || running || disabled) return
    setValue("")
    onSend({ instruction: text, model: modelId, effort })
  }

  return (
    <div className="rounded-2xl border border-border/60 bg-background focus-within:border-foreground/40 transition-colors shadow-sm">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder || "Solicitar cambios de seguimiento"}
        rows={3}
        disabled={disabled || running}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        className="border-0 resize-none text-[15px] leading-relaxed focus-visible:ring-0 focus-visible:ring-offset-0 min-h-[72px] px-4 pt-3 pb-1 bg-transparent"
      />

      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        {/* Left cluster — attach, visibility */}
        <div className="flex items-center gap-0.5">
          <IconButton
            title="Adjuntar (próximamente)"
            onClick={() => toast.info("Adjuntos · próximamente")}
            disabled={disabled || running}
          >
            <Plus className="h-4 w-4" />
          </IconButton>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={disabled || running}
                className={cn(
                  "inline-flex items-center h-8 rounded-md px-1.5 text-[#C05621] hover:bg-muted/40 transition-colors",
                  (disabled || running) && "opacity-50 cursor-not-allowed",
                )}
                aria-label="Visibility"
              >
                <ShieldAlert className="h-4 w-4" />
                <ChevronDown className="h-3 w-3 ml-0.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Visibilidad
              </DropdownMenuLabel>
              {(Object.keys(VIS_LABELS) as Visibility[]).map(v => {
                const info = VIS_LABELS[v]
                return (
                  <DropdownMenuItem
                    key={v}
                    disabled={!info.available}
                    onClick={() => {
                      if (!info.available) {
                        toast.info(`${info.label} · próximamente`)
                        return
                      }
                      setVisibility(v)
                    }}
                    className="flex items-start gap-2"
                  >
                    <span className="w-4 mt-0.5 shrink-0">
                      {visibility === v && <Check className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0">
                      <span className="text-sm font-medium">{info.label}</span>
                      <span className="block text-[11px] text-muted-foreground">{info.desc}</span>
                    </span>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Right cluster — model, effort, mic, send */}
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={disabled || running}
                className={cn(
                  "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full border border-border/60 bg-card hover:bg-muted/40 transition-colors text-sm",
                  (disabled || running) && "opacity-60 cursor-not-allowed",
                )}
              >
                <ProviderDot provider={providerFor(modelId)} />
                <span className="tabular-nums">{currentDisplay}</span>
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 max-h-[60vh] overflow-y-auto">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Modelo de diseño
              </DropdownMenuLabel>
              {featured.map(f => (
                <DropdownMenuItem
                  key={f.name}
                  onClick={() => setModelId(f.name)}
                  className="flex items-start gap-2"
                >
                  <span className="w-4 mt-0.5 shrink-0">
                    {modelId === f.name && <Check className="h-3.5 w-3.5" />}
                  </span>
                  <ProviderDot provider={providerFor(f.name)} />
                  <span className="min-w-0 flex-1">
                    <span className="text-sm">{f.display}</span>
                    <span className="block text-[10px] text-muted-foreground">{shortProvider(f.name)}</span>
                  </span>
                </DropdownMenuItem>
              ))}
              {models.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    Todos los modelos ({models.length})
                  </DropdownMenuLabel>
                  <div className="max-h-48 overflow-y-auto">
                    {models.slice(0, 80).map(m => (
                      <DropdownMenuItem
                        key={m.id}
                        onClick={() => setModelId(m.name)}
                        className="flex items-center gap-2"
                      >
                        <span className="w-4 shrink-0">
                          {modelId === m.name && <Check className="h-3.5 w-3.5" />}
                        </span>
                        <ProviderDot provider={providerFor(m.name)} />
                        <span className="text-xs truncate">{m.displayName || m.name}</span>
                      </DropdownMenuItem>
                    ))}
                  </div>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={disabled || running}
                className={cn(
                  "inline-flex items-center h-8 rounded-md px-1.5 hover:bg-muted/40 transition-colors text-muted-foreground",
                  (disabled || running) && "opacity-50 cursor-not-allowed",
                )}
                title={EFFORT_LABELS[effort].label}
                aria-label="Effort"
              >
                <Brain className="h-4 w-4" />
                <ChevronDown className="h-3 w-3 ml-0.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Esfuerzo
              </DropdownMenuLabel>
              {(Object.keys(EFFORT_LABELS) as Effort[]).map(e => (
                <DropdownMenuItem
                  key={e}
                  onClick={() => setEffort(e)}
                  className="flex items-start gap-2"
                >
                  <span className="w-4 mt-0.5 shrink-0">
                    {effort === e && <Check className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0">
                    <span className="text-sm font-medium">{EFFORT_LABELS[e].label}</span>
                    <span className="block text-[11px] text-muted-foreground">{EFFORT_LABELS[e].desc}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <IconButton
            title="Dictado (próximamente)"
            onClick={() => toast.info("Dictado · próximamente")}
            disabled={disabled || running}
          >
            <Mic className="h-4 w-4" />
          </IconButton>

          {running ? (
            <Button
              onClick={onStop}
              size="icon"
              variant="outline"
              className="h-9 w-9 rounded-full"
              title="Stop"
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              onClick={submit}
              disabled={disabled || !value.trim()}
              size="icon"
              className="h-9 w-9 rounded-full bg-foreground hover:bg-foreground/90 text-background"
              title="Send"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <AnimatePresence>
        {running && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="border-t border-border/60 px-4 py-2 flex items-center gap-2 text-[11px] text-muted-foreground"
          >
            <ThinkingIndicator size="xs" />
            <span>
              {stage === "generating" && "Generando"}
              {stage === "reviewing" && "Revisando calidad"}
              {stage === "repairing" && "Autocorrigiendo"}
              {" "}con <span className="font-medium">{currentDisplay}</span>
              {progressChars > 0 && ` · ${progressChars.toLocaleString()} chars`}
              {quality && ` · calidad ${quality.score}/100`}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── Bits ──────────────────────────────────────────────────────────────────

function IconButton({
  onClick, disabled, title, children,
}: {
  onClick?: () => void
  disabled?: boolean
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:bg-muted/40 transition-colors",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      {children}
    </button>
  )
}

function providerFor(modelName: string): "openai" | "anthropic" | "gemini" | "openrouter" | "other" {
  const m = String(modelName || "").toLowerCase()
  if (m.startsWith("anthropic/")) return "anthropic"
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("openai/")) return "openai"
  if (m.includes("gemini")) return "gemini"
  if (m.includes("/")) return "openrouter"
  return "other"
}

function ProviderDot({ provider }: { provider: ReturnType<typeof providerFor> }) {
  const color =
    provider === "anthropic" ? "bg-[#C05621]" :
    provider === "openai"    ? "bg-emerald-500" :
    provider === "gemini"    ? "bg-sky-500" :
    provider === "openrouter"? "bg-violet-500" :
                               "bg-muted-foreground/40"
  return <span className={cn("h-2 w-2 rounded-full shrink-0", color)} />
}

function shortProvider(modelName: string): string {
  const p = providerFor(modelName)
  return p === "anthropic" ? "Anthropic"
       : p === "openai"    ? "OpenAI"
       : p === "gemini"    ? "Gemini"
       : p === "openrouter"? "OpenRouter"
       : "Custom"
}
