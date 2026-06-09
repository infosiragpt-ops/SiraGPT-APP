"use client"

import * as React from "react"
import {
  BrainCircuit,
  Check,
  Clipboard,
  GitBranch,
  RefreshCw,
  Share2,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  VolumeX,
  X as XIcon} from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { writeText as copyTextSafe } from "@/lib/native/clipboard"
import { cn } from "@/lib/utils"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
type FeedbackKind = "liked" | "disliked"
type ActionKind = "copy" | "speak" | "like" | "dislike" | "regenerate" | "share" | "branch" | "remember"

export interface MessageActionRailProps {
  /** Message identity — passed straight through to telemetry. */
  messageId: string
  chatId: string
  /** Optional model id. Used for telemetry and (when present) rendered
   *  as a subtle, non-interactive pill at the end of the action rail
   *  so the user can see which model produced this answer. #99 */
  model?: string

  /** Plaintext content used for: copy clipboard payload, TTS source,
   *  and emptiness checks (Copy/Speak hide entirely if empty). */
  content: string

  /** When true the parent message is in an error/empty state — only
   *  Regenerate is offered (everything else hides). */
  hasError?: boolean

  /** 1-based count for regenerated assistant variants. Original
   *  responses keep this at 0 and render no badge. */
  regenerationAttempt?: number

  /** Streaming or any in-flight LLM call disables every action so the
   *  user can't double-click into a race. */
  isStreaming?: boolean

  /** Feature gates — pass `false` to hide a button outright. Defaults
   *  to true for backwards compat with old call sites. */
  canCopy?: boolean
  canVoice?: boolean
  canFeedback?: boolean
  canRegenerate?: boolean
  canShare?: boolean
  /** Branch / fork the conversation from this message. Defaults to true,
   *  but the button only renders when an `onBranch` handler is supplied —
   *  this keeps it opt-in for call sites that don't yet support forking. */
  canBranch?: boolean
  /** Save this answer to the user's persistent agent memory. Defaults to
   *  true, but the button only renders when an `onRemember` handler is
   *  supplied. */
  canRemember?: boolean

  /** TTS state owned by the parent (so multiple messages share one
   *  audio context). */
  isSpeaking?: boolean
  isLoadingAudio?: boolean

  /** Persisted feedback. The rail handles single-selection toggling
   *  internally and calls onFeedback when it changes. */
  feedback?: FeedbackKind | null

  /** Action hooks — every one is wired to a real handler in the parent. */
  onCopy?: () => Promise<void> | void
  onSpeak?: () => void
  onFeedback?: (kind: FeedbackKind) => Promise<void> | void
  onRegenerate?: () => void
  onShare?: () => Promise<void> | void
  /** Fork the conversation from this message into a new branch. When
   *  omitted the Branch button is hidden entirely. */
  onBranch?: () => Promise<void> | void
  /** Persist this answer to the user's long-term agent memory. When
   *  omitted the Remember button is hidden entirely. */
  onRemember?: () => Promise<void> | void

  /** Telemetry hook — fires after every action with timing + outcome.
   *  Defaults to console.log so dev sees it; wire to a real
   *  posthog/segment/internal endpoint in production. */
  onTelemetry?: (event: {
    clicked_action: ActionKind
    message_id: string
    chat_id: string
    model?: string
    latency_ms: number
    success: boolean
    error_code?: string
  }) => void
}

const DEFAULT_TELEMETRY: NonNullable<MessageActionRailProps["onTelemetry"]> = (e) => {
  if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.log("[message_action]", e)
  }
}

/**
 * Animated three-bar equalizer shown inside the Speak button while audio
 * is playing — a clearer, more futuristic "now reading" affordance than a
 * static mute glyph. Pure CSS, GPU-friendly (transform/scaleY only), and
 * respects `prefers-reduced-motion` via the keyframes injected by the rail.
 */
function SpeakingEqualizer() {
  return (
    <span aria-hidden="true" className="flex h-4 w-4 items-end justify-center gap-[2px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-[2.5px] origin-bottom rounded-full bg-current motion-safe:animate-[rail-eq_900ms_ease-in-out_infinite]"
          style={{ height: "70%", animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  )
}

/**
 * Single icon button used by the rail. All sizing/state styling lives
 * here so every action looks identical and the rail is self-consistent.
 *
 * The visual language is intentionally "futuristic glass": a soft layered
 * gradient + inset hairline ring on hover, an accent glow when active, and
 * a crisp tactile press. It reads as professional on both light and dark
 * surfaces because every colour is derived from design-system tokens
 * (foreground / border / ring) rather than hard-coded hues.
 */
function RailButton({
  label,
  icon,
  onClick,
  disabled,
  pressed,
  loading,
  pulse,
  destructive,
  glow,
}: {
  label: string
  icon: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  /** Persistent "active" state (e.g. Liked, Speaking). */
  pressed?: boolean
  loading?: boolean
  /** Subtle attention pulse for one-shot success feedback. */
  pulse?: "success" | "error" | null
  destructive?: boolean
  /** Accent halo for live/streaming-style states (e.g. Speaking). */
  glow?: "accent" | null
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled || loading}
          onClick={onClick}
          className={cn(
            // 36px hit area (h-9 w-9). Icon optical size stays 14-15px via
            // RailButton callers. rounded-xl + relative for the glow layer.
            "group/rb relative inline-flex h-9 w-9 items-center justify-center rounded-xl",
            "text-muted-foreground/80 transition-all duration-200 ease-out will-change-transform",
            // Futuristic glass hover: layered gradient + inset hairline +
            // a soft lift shadow.
            "hover:text-foreground",
            "hover:bg-[linear-gradient(180deg,hsl(var(--foreground)/0.10),hsl(var(--foreground)/0.03))]",
            "hover:shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6),0_2px_10px_-3px_hsl(var(--foreground)/0.18)]",
            "active:scale-[0.92]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground/80 disabled:hover:shadow-none disabled:active:scale-100",
            pressed && !destructive && "bg-[linear-gradient(180deg,hsl(var(--foreground)/0.12),hsl(var(--foreground)/0.04))] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.8)]",
            pressed && destructive && "bg-red-500/10 text-red-500 dark:text-red-400 shadow-[inset_0_0_0_1px_hsl(0_84%_60%/0.35)]",
            glow === "accent" && "text-sky-500 dark:text-sky-400 shadow-[inset_0_0_0_1px_hsl(199_89%_55%/0.35),0_0_16px_-3px_hsl(199_89%_55%/0.6)]",
            pulse === "success" && "text-emerald-500 dark:text-emerald-400",
            pulse === "error" && "text-red-500 dark:text-red-400",
          )}
        >
          {/* Soft animated halo behind the icon while a state is "live". */}
          {glow === "accent" && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-xl bg-sky-400/10 motion-safe:animate-[rail-halo_1800ms_ease-in-out_infinite]"
            />
          )}
          <span className="relative inline-flex items-center justify-center">
            {loading ? <ThinkingIndicator size="sm" /> : icon}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="text-[11.5px] font-medium">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function MessageActionRail({
  messageId,
  chatId,
  model,
  content,
  hasError = false,
  regenerationAttempt = 0,
  isStreaming = false,
  canCopy = true,
  canVoice = true,
  canFeedback = true,
  canRegenerate = true,
  canShare = true,
  canBranch = true,
  isSpeaking = false,
  isLoadingAudio = false,
  feedback = null,
  onCopy,
  onSpeak,
  onFeedback,
  onRegenerate,
  onShare,
  onBranch,
  onRemember,
  canRemember = true,
  onTelemetry = DEFAULT_TELEMETRY,
}: MessageActionRailProps) {
  // ── Local UI state ───────────────────────────────────────────────
  const [copyPulse, setCopyPulse] = React.useState<"success" | "error" | null>(null)
  const [sharePulse, setSharePulse] = React.useState<"success" | "error" | null>(null)
  const [isCopying, setIsCopying] = React.useState(false)
  const [isSharing, setIsSharing] = React.useState(false)
  const [isBranching, setIsBranching] = React.useState(false)
  const [isRemembering, setIsRemembering] = React.useState(false)
  const [rememberPulse, setRememberPulse] = React.useState<"success" | "error" | null>(null)
  const [remembered, setRemembered] = React.useState(false)
  const [isSubmittingFeedback, setIsSubmittingFeedback] = React.useState<FeedbackKind | null>(null)
  const [localFeedback, setLocalFeedback] = React.useState<FeedbackKind | null>(feedback)

  // Sync external feedback changes (e.g. parent loaded persisted state).
  React.useEffect(() => { setLocalFeedback(feedback) }, [feedback])

  // ── Contextual visibility ────────────────────────────────────────
  const trimmed = (content || "").trim()
  const hasText = trimmed.length > 0
  // Action rail is hidden in its entirety while the model is still
  // producing a response. Copy / Speak / Feedback / Share are
  // meaningless against a half-streamed bubble (and the fenced
  // `agent-task-state` block that drives the thinking indicator
  // counts as text for the trim check, which is why every action
  // used to leak through during streaming). Regenerate was already
  // hidden; the other four now match.
  const isLive = isStreaming
  const showCopy = canCopy && hasText && !hasError && !isLive
  const showSpeak = canVoice && hasText && !hasError && !isLive
  const showFeedback = canFeedback && hasText && !hasError && !isLive
  const showRegenerate = canRegenerate && !isLive && (hasText || hasError)
  const showShare = canShare && hasText && !hasError && !isLive
  // Branching is opt-in: the button only appears when the parent actually
  // wired an `onBranch` handler (forking the conversation tree).
  const showBranch = canBranch && !!onBranch && hasText && !hasError && !isLive
  // Remember (persistent agent memory) is opt-in too — only assistant answers
  // worth keeping should expose it, so it's gated on an `onRemember` handler.
  const showRemember = canRemember && !!onRemember && hasText && !hasError && !isLive
  const regenerationBadge = Number.isFinite(regenerationAttempt) && regenerationAttempt > 0
    ? (regenerationAttempt > 99 ? "99+" : String(Math.floor(regenerationAttempt)))
    : null

  // #99 — prettify model id for the trailing pill (kept inline so we
  // don't ship another import for ~10 lines of mapping).
  const prettyModel = React.useMemo(() => prettifyModelId(model), [model])
  const showModelBadge = !isLive && !hasError && hasText && !!prettyModel

  // Nothing to render? Don't render the container either — keeps the
  // bubble visually clean for messages that genuinely have no actions.
  if (!showCopy && !showSpeak && !showFeedback && !showRegenerate && !showShare && !showBranch && !showRemember && !showModelBadge) {
    return null
  }

  // ── Action wrappers — each instruments telemetry + handles loading
  //    + emits visual pulse on success/error. ─────────────────────────
  const fire = async <T,>(
    kind: ActionKind,
    fn: () => Promise<T> | T,
    pulseSetter?: (v: "success" | "error" | null) => void,
  ): Promise<T | undefined> => {
    const t0 = performance.now()
    try {
      const result = await fn()
      onTelemetry({
        clicked_action: kind,
        message_id: messageId,
        chat_id: chatId,
        model,
        latency_ms: Math.round(performance.now() - t0),
        success: true,
      })
      if (pulseSetter) {
        pulseSetter("success")
        window.setTimeout(() => pulseSetter(null), 1500)
      }
      return result
    } catch (err: any) {
      onTelemetry({
        clicked_action: kind,
        message_id: messageId,
        chat_id: chatId,
        model,
        latency_ms: Math.round(performance.now() - t0),
        success: false,
        error_code: err?.code || err?.message || "unknown",
      })
      if (pulseSetter) {
        pulseSetter("error")
        window.setTimeout(() => pulseSetter(null), 2000)
      }
      throw err
    }
  }

  const handleCopy = async () => {
    setIsCopying(true)
    try {
      await fire("copy", async () => {
        if (onCopy) {
          await onCopy()
        } else {
          const result = await copyTextSafe(trimmed)
          if (!result.ok) throw new Error(result.error || "clipboard_unavailable")
        }
      }, setCopyPulse)
    } catch { /* pulse already handled */ }
    finally { setIsCopying(false) }
  }

  const handleFeedbackClick = async (kind: FeedbackKind) => {
    if (isSubmittingFeedback) return
    // Allow toggling off by pressing the same button twice.
    const next: FeedbackKind | null = localFeedback === kind ? null : kind
    setIsSubmittingFeedback(kind)
    const previous = localFeedback
    setLocalFeedback(next) // optimistic
    try {
      if (onFeedback && next) {
        await fire("like" as ActionKind, () => onFeedback(next))
      } else if (onFeedback && previous) {
        // Untoggle = no API call; we just revert local state. The parent
        // can re-sync via the `feedback` prop on next mount if needed.
      }
    } catch {
      setLocalFeedback(previous) // rollback
    } finally {
      setIsSubmittingFeedback(null)
    }
  }

  const handleShareClick = async () => {
    if (isSharing || !onShare) return
    setIsSharing(true)
    try {
      await fire("share", () => onShare(), setSharePulse)
    } catch { /* pulse already handled */ }
    finally { setIsSharing(false) }
  }

  const handleRegenerateClick = () => {
    if (!onRegenerate) return
    fire("regenerate", () => onRegenerate()).catch(() => {})
  }

  const handleBranchClick = async () => {
    if (isBranching || !onBranch) return
    setIsBranching(true)
    try {
      await fire("branch", () => onBranch())
    } catch { /* telemetry already recorded */ }
    finally { setIsBranching(false) }
  }

  const handleRememberClick = async () => {
    if (isRemembering || !onRemember) return
    setIsRemembering(true)
    try {
      await fire("remember", () => onRemember(), setRememberPulse)
      // Latch a persistent "saved" affordance so the user knows this answer
      // already lives in their agent's long-term memory.
      setRemembered(true)
    } catch { /* pulse already handled */ }
    finally { setIsRemembering(false) }
  }

  const handleSpeakClick = () => {
    if (!onSpeak) return
    fire("speak", () => onSpeak()).catch(() => {})
  }

  // While streaming: non-regenerate actions remain disabled so the user can't
  // trigger races against the in-flight generation.
  const allDisabled = isStreaming

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={0}>
      <div
        role="toolbar"
        aria-label="Acciones del mensaje"
        // Borderless rail — icons sit tight under the response.
        // -ml-1.5 visually aligns the first icon's optical center with
        // the text edge above (each RailButton has 4px internal padding
        // on its left). mt-0.5 keeps the rail close enough to feel
        // attached to the message instead of floating below it.
        className={cn(
          "mt-0.5 -ml-1.5 inline-flex items-center gap-0",
        )}
      >
        {showCopy && (
          <RailButton
            label="Copiar"
            disabled={allDisabled}
            loading={isCopying}
            pulse={copyPulse}
            onClick={handleCopy}
            icon={copyPulse === "success" ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
          />
        )}
        {showSpeak && (
          <RailButton
            label={isSpeaking ? "Detener lectura" : "Leer en voz alta"}
            disabled={allDisabled}
            loading={isLoadingAudio}
            pressed={isSpeaking}
            glow={isSpeaking ? "accent" : null}
            onClick={handleSpeakClick}
            icon={
              isSpeaking ? (
                <span className="group/sp relative inline-flex h-4 w-4 items-center justify-center">
                  {/* Equalizer by default; swaps to a Stop glyph on hover so
                      the click affordance stays obvious. */}
                  <span className="group-hover/sp:opacity-0 transition-opacity">
                    <SpeakingEqualizer />
                  </span>
                  <VolumeX className="absolute h-4 w-4 opacity-0 transition-opacity group-hover/sp:opacity-100" />
                </span>
              ) : (
                <Volume2 className="h-4 w-4" />
              )
            }
          />
        )}
        {showFeedback && (
          <>
            <RailButton
              label={localFeedback === "liked" ? "Quitar me gusta" : "Me gusta"}
              disabled={allDisabled}
              loading={isSubmittingFeedback === "liked"}
              pressed={localFeedback === "liked"}
              onClick={() => handleFeedbackClick("liked")}
              icon={<ThumbsUp className="h-4 w-4" strokeWidth={localFeedback === "liked" ? 2.5 : 1.75} />}
            />
            <RailButton
              label={localFeedback === "disliked" ? "Quitar valoración negativa" : "No me gusta"}
              disabled={allDisabled}
              loading={isSubmittingFeedback === "disliked"}
              pressed={localFeedback === "disliked"}
              destructive={localFeedback === "disliked"}
              onClick={() => handleFeedbackClick("disliked")}
              icon={<ThumbsDown className="h-4 w-4" strokeWidth={localFeedback === "disliked" ? 2.5 : 1.75} />}
            />
          </>
        )}
        {showRegenerate && (
          <RailButton
            label={regenerationBadge ? `Regenerar respuesta · versión ${regenerationBadge}` : "Regenerar respuesta"}
            disabled={allDisabled}
            onClick={handleRegenerateClick}
            icon={
              <span className="relative inline-flex h-4 w-4 items-center justify-center">
                <RefreshCw className="h-4 w-4" />
                {regenerationBadge && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute -right-2 -top-2 inline-flex min-w-[13px] h-[13px] items-center justify-center rounded-full px-[3px]",
                      "bg-foreground text-background text-[8px] font-semibold leading-none tabular-nums",
                      "shadow-[0_1px_2px_rgba(0,0,0,0.14)]",
                    )}
                  >
                    {regenerationBadge}
                  </span>
                )}
              </span>
            }
          />
        )}
        {showShare && (
          <RailButton
            label="Copiar enlace al mensaje"
            disabled={allDisabled}
            loading={isSharing}
            pulse={sharePulse}
            onClick={handleShareClick}
            icon={sharePulse === "success" ? <Check className="h-4 w-4" /> : sharePulse === "error" ? <XIcon className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
          />
        )}
        {showBranch && (
          // ── "Bifurcar conversación" ──────────────────────────────────
          // The new, future-facing action. As AI moves from single linear
          // chats to *exploring a tree of reasoning paths*, branching a
          // conversation from any answer (git-style, without losing the
          // original) becomes a core primitive — non-destructive
          // experimentation with prompts, models and directions. Wired as
          // an optional handler so it lights up only where the host app
          // supports forking.
          <RailButton
            label="Bifurcar conversación"
            disabled={allDisabled}
            loading={isBranching}
            onClick={handleBranchClick}
            icon={<GitBranch className="h-4 w-4" />}
          />
        )}
        {showRemember && (
          // ── "Recordar" (memoria persistente del agente) ──────────────
          // The most future-facing action of all: software that *remembers*.
          // The next generation of AI tools is defined by agents with durable,
          // cross-session memory — pin an answer and the assistant keeps it as
          // a long-term fact about you, so future chats start already knowing
          // it. Self-contained: the parent persists it to the user's memory
          // document. Once saved, the icon latches to a filled/accent state.
          <RailButton
            label={remembered ? "Guardado en memoria" : "Recordar esto"}
            disabled={allDisabled}
            loading={isRemembering}
            pressed={remembered}
            pulse={rememberPulse}
            glow={remembered ? "accent" : null}
            onClick={handleRememberClick}
            icon={
              rememberPulse === "success" || remembered
                ? <BrainCircuit className="h-4 w-4" strokeWidth={2.25} />
                : <BrainCircuit className="h-4 w-4" />
            }
          />
        )}
        {showModelBadge && (
          // #99 — Modelo respondedor. Pill no interactiva, color muy
          // suave para no competir con las acciones. Tooltip muestra
          // el id crudo por si el usuario lo necesita para reportar
          // un bug. ml-1 separa del último icono; aria-label da el
          // texto completo a lectores de pantalla.
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={`Respuesta generada por ${prettyModel}`}
                className={cn(
                  "ml-1 inline-flex h-7 items-center rounded-full px-2",
                  "text-[11px] font-medium text-muted-foreground/75",
                  "border border-border/40 bg-muted/30",
                  "select-none cursor-default tabular-nums",
                )}
              >
                {prettyModel}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6} className="text-[11.5px] font-medium">
              {model}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  )
}

// #99 — Map common model ids to a human label. Anything we don't
// recognise just gets returned as-is (truncated) so future models
// still show up without code changes.
function prettifyModelId(raw?: string): string | null {
  if (!raw || typeof raw !== "string") return null
  const id = raw.trim()
  if (!id) return null
  const lower = id.toLowerCase()
  const map: Array<[RegExp, string]> = [
    [/^gpt-?5(?:[-.]|$)/, "GPT-5"],
    [/^gpt-?4o-mini\b/, "GPT-4o mini"],
    [/^gpt-?4o\b/, "GPT-4o"],
    [/^gpt-?4\.1\b/, "GPT-4.1"],
    [/^gpt-?4\b/, "GPT-4"],
    [/^o4-mini\b/, "o4-mini"],
    [/^o3-mini\b/, "o3-mini"],
    [/^o3\b/, "o3"],
    [/^o1\b/, "o1"],
    [/^claude.*opus.*4/, "Claude Opus 4"],
    [/^claude.*sonnet.*4/, "Claude Sonnet 4"],
    [/^claude.*haiku/, "Claude Haiku"],
    [/^claude.*opus/, "Claude Opus"],
    [/^claude.*sonnet/, "Claude Sonnet"],
    [/^gemini-?2\.5.*pro/, "Gemini 2.5 Pro"],
    [/^gemini-?2\.5.*flash/, "Gemini 2.5 Flash"],
    [/^gemini-?2\.0.*flash/, "Gemini 2.0 Flash"],
    [/^gemini.*pro/, "Gemini Pro"],
    [/^gemini.*flash/, "Gemini Flash"],
    [/^deepseek-?r1/, "DeepSeek R1"],
    [/^deepseek-?v3/, "DeepSeek V3"],
    [/^llama-?3\.3/, "Llama 3.3"],
    [/^llama-?3\.1/, "Llama 3.1"],
    [/^mistral-?large/, "Mistral Large"],
    [/^grok/, "Grok"],
    [/^qwen/, "Qwen"],
  ]
  for (const [rx, label] of map) {
    if (rx.test(lower)) return label
  }
  // Unknown id — show a short, readable version (cap at 24 chars).
  return id.length > 24 ? id.slice(0, 23) + "…" : id
}

export default MessageActionRail
