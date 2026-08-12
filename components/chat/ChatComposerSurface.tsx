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
import { ArrowUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { cn } from "@/lib/utils"

export function ChatComposerSurface({
  overlayVisible = false,
  overlay = null,
  slashMenu = null,
  contextTray,
  leading,
  textarea,
  toolbar,
  footer = null,
}: {
  overlayVisible?: boolean
  overlay?: React.ReactNode
  slashMenu?: React.ReactNode
  contextTray: React.ReactNode
  leading: React.ReactNode
  textarea: React.ReactNode
  toolbar: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className="relative">
      {overlay}
      {slashMenu}
      <div
        data-testid="chat-composer-surface"
        className={cn(
          "composer-surface group/composer relative",
          overlayVisible ? "overflow-visible" : "overflow-hidden",
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
}) {
  const hasText = input.trim().length > 0
  const needsPrompt = requiresPromptBeforePrimarySend && !hasText
  const canSend = requiresPromptBeforePrimarySend ? hasText : (hasText || hasAttachment)

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
              "h-9 w-9 rounded-full p-0 transition-all duration-base ease-smooth",
              "bg-foreground text-background",
              "shadow-[0_1px_2px_rgba(0,0,0,0.08),0_4px_10px_-2px_rgba(0,0,0,0.12)]",
              "hover:bg-foreground/92 hover:shadow-[0_2px_4px_rgba(0,0,0,0.12),0_8px_16px_-4px_rgba(0,0,0,0.22)] hover:-translate-y-[0.5px]",
              "active:scale-[0.94] active:translate-y-0",
              "disabled:bg-muted disabled:text-muted-foreground/60 disabled:shadow-none disabled:cursor-not-allowed disabled:active:scale-100 disabled:translate-y-0 disabled:hover:translate-y-0",
            )}
          >
            {busy ? (
              <ThinkingIndicator size="sm" className="h-[15px] w-[15px]" />
            ) : (
              <ArrowUp className="h-[16px] w-[16px]" strokeWidth={canSend ? 2.25 : 1.75} />
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
              "h-9 w-9 rounded-full p-0 transition-all duration-200",
              "bg-[hsl(var(--accent-violet))] text-white",
              "shadow-[0_1px_2px_rgba(0,0,0,0.10),0_4px_10px_-3px_rgba(0,0,0,0.22)]",
              "hover:opacity-90 active:scale-[0.96]",
            )}
          >
            <ArrowUp className="h-[16px] w-[16px]" strokeWidth={2.25} />
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
