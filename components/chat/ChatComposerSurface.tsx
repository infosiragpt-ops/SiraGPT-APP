"use client"

/**
 * Shared chat composer surface.
 *
 * Both the empty-state hero composer and the in-conversation dock used to
 * duplicate ~350 lines of markup. This shell owns the capsule, the context
 * tray (attachments live inside the same rounded border) and the control
 * grid that pins the model picker to the footer once the prompt stacks.
 */

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { cn } from "@/lib/utils"

/** White stroke send arrow — one professional line, not a filled glyph. */
export function ComposerSendArrow({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 19.25V5.75M12 5.75 6.4 11.35M12 5.75l5.6 5.6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Voice waveform glyph — vertical bars, Claude-style, stroke only. */
export function ComposerVoiceWaveform({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4 10.5v3M8.5 7v10M12 4.5v15M15.5 7v10M20 10.5v3"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function ChatComposerSurface({
  overlayVisible = false,
  overlay = null,
  slashMenu = null,
  mentionMenu = null,
  contextTray,
  leading,
  textarea,
  toolbar,
  footer = null,
  layout = "row",
  expanded = false,
}: {
  overlayVisible?: boolean
  overlay?: React.ReactNode
  slashMenu?: React.ReactNode
  mentionMenu?: React.ReactNode
  contextTray: React.ReactNode
  leading: React.ReactNode
  textarea: React.ReactNode
  toolbar: React.ReactNode
  footer?: React.ReactNode
  layout?: "row" | "stacked"
  expanded?: boolean
}) {
  return (
    <div className="relative">
      {overlay}
      {slashMenu}
      {mentionMenu}
      <div
        data-testid="chat-composer-surface"
        data-composer-layout={layout}
        data-expand-composer={expanded ? "1" : "0"}
        className={cn(
          "composer-surface group/composer relative",
          overlayVisible ? "overflow-visible" : "overflow-hidden",
          expanded && "is-expanded",
        )}
      >
        <div className="composer-context-tray">
          {contextTray}
        </div>
        <TooltipProvider>
          <div className="composer-input-row">
            <div className="composer-leading-controls">
              {leading}
            </div>
            {textarea}
            {toolbar}
          </div>
        </TooltipProvider>
        {footer}
      </div>
    </div>
  )
}

export function ChatComposerPrimaryAction({
  input,
  hasAttachment,
  requiresPromptBeforePrimarySend,
  busy,
  isStopButtonVisible,
  shouldPrioritizeStopButton,
  pendingStop,
  isCurrentChatStreaming,
  onSend,
  onStop,
  onVoice,
  voiceRecording = false,
}: {
  input: string
  hasAttachment: boolean
  requiresPromptBeforePrimarySend: boolean
  busy: boolean
  isStopButtonVisible: boolean
  shouldPrioritizeStopButton: boolean
  pendingStop: boolean
  isCurrentChatStreaming: boolean
  onSend: () => void
  onStop: () => void
  onVoice?: () => void
  voiceRecording?: boolean
}) {
  const hasText = input.trim().length > 0
  const needsPrompt = requiresPromptBeforePrimarySend && !hasText
  const canSend = requiresPromptBeforePrimarySend ? hasText : (hasText || hasAttachment)

  // Empty composer + voice available → the primary disc becomes the voice
  // entry point (Claude-style waveform) instead of a dead disabled arrow.
  if (!isStopButtonVisible && !canSend && !busy && !needsPrompt && onVoice) {
    const voiceLabel = voiceRecording ? "Detener dictado" : "Dictar por voz"
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            onClick={onVoice}
            size="icon"
            aria-label={voiceLabel}
            aria-pressed={voiceRecording}
            className={cn(
              "composer-send-button composer-voice-button h-9 w-9 rounded-full p-0 transition-all duration-base ease-smooth",
              "active:scale-[0.94]",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
              voiceRecording && "composer-voice-button--recording",
            )}
          >
            {voiceRecording ? (
              <span aria-hidden className="block h-2.5 w-2.5 shrink-0 rounded-[2px] bg-white" />
            ) : (
              <ComposerVoiceWaveform className="h-[17px] w-[17px]" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top"><p>{voiceLabel}</p></TooltipContent>
      </Tooltip>
    )
  }

  if (!isStopButtonVisible) {
    const label = canSend
      ? "Enviar (⏎)"
      : needsPrompt
        ? "Describe lo que quieres crear"
        : "Escribe un mensaje para enviar"
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            onClick={onSend}
            disabled={!canSend || busy}
            size="icon"
            aria-label={label}
            className={cn(
              "composer-send-button h-9 w-9 rounded-full p-0 transition-all duration-base ease-smooth",
              "active:scale-[0.94] active:translate-y-0",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
              "disabled:cursor-not-allowed disabled:active:scale-100 disabled:translate-y-0",
            )}
          >
            {busy ? (
              <ThinkingIndicator size="sm" className="h-[15px] w-[15px]" />
            ) : (
              <ComposerSendArrow className="h-[16px] w-[16px]" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  if (hasText && !shouldPrioritizeStopButton) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            onClick={onSend}
            size="icon"
            aria-label="Enviar a la cola · se procesa en orden"
            className={cn(
              "composer-send-button h-9 w-9 rounded-full p-0 transition-all duration-200",
              "active:scale-[0.96]",
            )}
          >
            <ComposerSendArrow className="h-[16px] w-[16px]" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top"><p>Enviar a la cola · se procesa en orden</p></TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Button
      onClick={onStop}
      size="icon"
      aria-label="Detener generación"
      title="Detener"
      disabled={pendingStop && isCurrentChatStreaming}
      className={cn(
        "composer-stop-button h-9 w-9 rounded-full p-0 transition-all duration-200",
        "bg-foreground text-white",
        "shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_6px_-2px_rgba(0,0,0,0.10)]",
        "hover:bg-foreground/90 active:scale-[0.96]",
        "disabled:opacity-70 disabled:cursor-not-allowed disabled:active:scale-100",
      )}
    >
      {pendingStop ? (
        <ThinkingIndicator size="sm" className="h-[15px] w-[15px] text-white" />
      ) : (
        <span
          aria-hidden
          className="composer-stop-icon block h-2.5 w-2.5 shrink-0 rounded-[2px] bg-white"
        />
      )}
    </Button>
  )
}
