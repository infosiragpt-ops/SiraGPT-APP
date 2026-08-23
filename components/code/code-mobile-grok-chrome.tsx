"use client"

/**
 * Phone-only Grok Bot chrome for /code.
 * Circular floating buttons, white canvas, agent pill, capsule composer.
 * Mount only when useResolvedMobile() is true — desktop layout is untouched.
 */

import * as React from "react"
import { ChevronLeft, Mic, MicOff, Plus } from "lucide-react"

import { DepartmentComputerPane, DesktopMonitorGlyph } from "@/components/code/department-computer-pane"
import { getSpeechRecognition } from "@/components/codex/dictation-button"
import { cn } from "@/lib/utils"
import { agentInitials } from "@/lib/code-mobile-grok"

/** In-flow column that receives the transcript + composer so they fill the phone canvas. */
export function CodeMobileGrokShell({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-testid="code-mobile-grok-fill"
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-white",
        className,
      )}
    >
      {children}
    </div>
  )
}

export function CodeMobileCircleButton({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "code-mobile-grok-circle inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-zinc-900",
        "shadow-[0_2px_10px_rgba(15,23,42,0.12)] ring-1 ring-black/[0.04]",
        "transition-transform duration-150 active:scale-[0.96]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400",
        "disabled:opacity-45 disabled:active:scale-100",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

export function CodeMobileGrokHeader({
  agentName,
  online = true,
  onBack,
  onOpenComputer,
  onOpenAgentMenu,
  computerOpen = false,
}: {
  agentName: string
  online?: boolean
  onBack: () => void
  onOpenComputer: () => void
  onOpenAgentMenu?: () => void
  computerOpen?: boolean
}) {
  const initials = agentInitials(agentName)
  return (
    <header
      className="code-mobile-grok-header flex shrink-0 items-center gap-2 bg-white px-3"
      style={{ paddingTop: "max(10px, env(safe-area-inset-top))" }}
      data-testid="code-mobile-grok-header"
    >
      <CodeMobileCircleButton
        aria-label="Volver a la empresa y departamentos"
        title="Volver"
        data-testid="code-mobile-grok-back"
        onClick={onBack}
      >
        <ChevronLeft className="h-5 w-5" strokeWidth={2.25} />
      </CodeMobileCircleButton>

      <button
        type="button"
        className="code-mobile-grok-pill mx-auto flex min-w-0 max-w-[min(72vw,280px)] items-center gap-2 rounded-full bg-white px-2.5 py-1.5 shadow-[0_2px_10px_rgba(15,23,42,0.12)] ring-1 ring-black/[0.04]"
        data-testid="code-mobile-grok-agent-pill"
        aria-label={onOpenAgentMenu ? `Agente ${agentName}. Abrir departamentos` : `Agente ${agentName}`}
        onClick={onOpenAgentMenu}
      >
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-800"
          aria-hidden
        >
          {initials}
        </span>
        <span
          className="min-w-0 truncate text-[15px] font-semibold text-zinc-950"
          data-testid="code-mobile-grok-agent-name"
        >
          {agentName}
        </span>
        <span
          className={cn(
            "h-2.5 w-2.5 shrink-0 rounded-full",
            online ? "bg-emerald-500" : "bg-zinc-300",
          )}
          data-testid="code-mobile-grok-online"
          aria-label={online ? "En línea" : "Desconectado"}
        />
      </button>

      <CodeMobileCircleButton
        aria-label={`Abrir computadora de ${agentName}`}
        title="Computadora"
        aria-pressed={computerOpen}
        data-testid="code-mobile-grok-computer"
        onClick={onOpenComputer}
      >
        <DesktopMonitorGlyph className="h-[18px] w-[18px]" />
      </CodeMobileCircleButton>
    </header>
  )
}

export function CodeMobileGrokMic({
  onTranscript,
  locale = "es-ES",
}: {
  onTranscript: (text: string) => void
  locale?: string
}) {
  const Ctor = typeof window !== "undefined" ? getSpeechRecognition() : null
  const [recording, setRecording] = React.useState(false)
  const recRef = React.useRef<{ stop: () => void } | null>(null)

  React.useEffect(() => () => {
    try { recRef.current?.stop() } catch { /* noop */ }
  }, [])

  const toggle = () => {
    if (!Ctor) return
    if (recording) {
      try { recRef.current?.stop() } catch { /* noop */ }
      return
    }
    try {
      const rec = new Ctor()
      rec.lang = locale
      rec.interimResults = true
      rec.continuous = false
      rec.onresult = (event: { resultIndex?: number; results?: Array<{ 0?: { transcript?: string } }> }) => {
        let text = ""
        const results = event.results || []
        for (let i = event.resultIndex || 0; i < results.length; i += 1) {
          text += results[i]?.[0]?.transcript || ""
        }
        if (text) onTranscript(text)
      }
      rec.onend = () => setRecording(false)
      rec.onerror = () => setRecording(false)
      recRef.current = rec
      rec.start()
      setRecording(true)
    } catch {
      setRecording(false)
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={!Ctor}
      aria-pressed={recording}
      aria-label={recording ? "Detener dictado" : "Dictar mensaje"}
      data-testid="code-mobile-grok-mic"
      className={cn(
        "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-zinc-700",
        recording && "bg-red-50 text-red-600",
        !Ctor && "opacity-40",
      )}
    >
      {recording ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
    </button>
  )
}

export function CodeMobileGrokPlusTrigger({
  onClick,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <CodeMobileCircleButton
      aria-label="Adjuntos y herramientas"
      title="Adjuntos y herramientas"
      data-testid="code-mobile-grok-plus"
      className={className}
      onClick={onClick}
      {...props}
    >
      <Plus className="h-5 w-5" strokeWidth={2.25} />
    </CodeMobileCircleButton>
  )
}

export function CodeMobileComputerOverlay({
  departmentName,
  departmentId,
  computerRunId,
  onClose,
}: {
  departmentName: string
  departmentId: string
  computerRunId: string
  onClose: () => void
}) {
  return (
    <div
      className="absolute inset-0 z-[60] bg-black"
      data-testid="code-mobile-grok-computer-overlay"
    >
      <DepartmentComputerPane
        departmentName={departmentName}
        departmentId={departmentId}
        computerRunId={computerRunId}
        onClose={onClose}
      />
    </div>
  )
}
