"use client"

/**
 * Chat computer overlay — Grok-bot-style desktop beside the existing
 * chat chrome. Reuses AgentComputerShell + DepartmentComputerPane /
 * noVNC. Bound to the open conversation id so chat A does not show
 * chat B's desktop.
 */

import * as React from "react"
import { X } from "lucide-react"

import { AgentComputerShell } from "@/components/code/agent-computer-shell"
import { DepartmentComputerPane } from "@/components/code/department-computer-pane"
import { Button } from "@/components/ui/button"
import { isAgentComputerEnabled } from "@/lib/agent-computer-flag"

export type ChatAgentComputerPanelProps = {
  conversationId: string
  onClose: () => void
}

export default function ChatAgentComputerPanel({
  conversationId,
  onClose,
}: ChatAgentComputerPanelProps) {
  const chatId = String(conversationId || "").trim() || "pending"
  const enabled = isAgentComputerEnabled()

  return (
    <section
      className="flex h-full min-h-0 w-full flex-col overflow-hidden border-l border-border/40 bg-[#e8e8ea] dark:bg-[#101012]"
      data-testid="chat-agent-computer-panel"
      data-chat-computer-conversation={chatId}
      aria-label="Computadora"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-black/10 bg-white/80 px-3 dark:border-white/10 dark:bg-[#1b1b1d]">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[12px] font-semibold leading-tight text-zinc-800 dark:text-zinc-100">
            Computadora
          </h2>
          <p className="truncate text-[10px] text-zinc-500 dark:text-zinc-400" data-testid="chat-agent-computer-binding">
            Conversación {chatId}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
          aria-label="Cerrar computadora"
          title="Cerrar computadora"
          data-testid="chat-agent-computer-close"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <div className="relative min-h-0 min-w-0 flex-1">
        {enabled ? (
          <AgentComputerShell conversationId={chatId}>
            <DepartmentComputerPane
              departmentName="Computadora"
              departmentId={`chat:${chatId}`}
              computerRunId={`chat-${chatId}`}
              conversationId={chatId}
              embedded
              onClose={onClose}
            />
          </AgentComputerShell>
        ) : (
          <div
            className="flex h-full min-h-0 items-center justify-center px-6 text-center"
            data-testid="chat-agent-computer-flag-off"
            role="status"
          >
            <p className="max-w-sm text-sm text-zinc-600 dark:text-zinc-300">
              La computadora del agente no está activa en este entorno.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
