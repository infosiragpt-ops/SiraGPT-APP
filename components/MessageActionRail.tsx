"use client"

import * as React from "react"
import {
  Check,
  Clipboard,
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
import { cn } from "@/lib/utils"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
type FeedbackKind = "liked" | "disliked"
type ActionKind = "copy" | "speak" | "like" | "dislike" | "regenerate" | "share"

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
 * Single icon button used by the rail. All sizing/state styling lives
 * here so every action looks identical and the rail is self-consistent.
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
            // 36px hit area (h-9 w-9) — tighter than 40px which felt
            // heavy when the rail had no container. Icon optical size
            // stays 14-15px via RailButton callers.
            "group/rb inline-flex h-9 w-9 items-center justify-center rounded-lg",
            "text-muted-foreground/85 transition-all duration-fast ease-smooth",
            "hover:bg-foreground/[0.06] hover:text-foreground",
            "active:scale-[0.94]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground disabled:active:scale-100",
            pressed && !destructive && "bg-foreground/[0.08] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]",
            pressed && destructive && "bg-red-500/10 text-red-500 dark:text-red-400 shadow-[inset_0_0_0_1px_hsl(0_84%_60%/0.3)]",
            pulse === "success" && "text-emerald-500 dark:text-emerald-400",
            pulse === "error" && "text-red-500 dark:text-red-400",
          )}
        >
          {loading ? <ThinkingIndicator size="sm" /> : icon}
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
  isStreaming = false,
  canCopy = true,
  canVoice = true,
  canFeedback = true,
  canRegenerate = true,
  canShare = true,
  isSpeaking = false,
  isLoadingAudio = false,
  feedback = null,
  onCopy,
  onSpeak,
  onFeedback,
  onRegenerate,
  onShare,
  onTelemetry = DEFAULT_TELEMETRY,
}: MessageActionRailProps) {
  // ── Local UI state ───────────────────────────────────────────────
  const [copyPulse, setCopyPulse] = React.useState<"success" | "error" | null>(null)
  const [sharePulse, setSharePulse] = React.useState<"success" | "error" | null>(null)
  const [isCopying, setIsCopying] = React.useState(false)
  const [isSharing, setIsSharing] = React.useState(false)
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

  // #99 — prettify model id for the trailing pill (kept inline so we
  // don't ship another import for ~10 lines of mapping).
  const prettyModel = React.useMemo(() => prettifyModelId(model), [model])
  const showModelBadge = !isLive && !hasError && hasText && !!prettyModel

  // Nothing to render? Don't render the container either — keeps the
  // bubble visually clean for messages that genuinely have no actions.
  if (!showCopy && !showSpeak && !showFeedback && !showRegenerate && !showShare && !showModelBadge) {
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
          await navigator.clipboard.writeText(trimmed)
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
            onClick={handleSpeakClick}
            icon={isSpeaking ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
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
            label="Regenerar respuesta"
            disabled={allDisabled}
            onClick={handleRegenerateClick}
            icon={<RefreshCw className="h-4 w-4" />}
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
