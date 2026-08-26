"use client"

/**
 * Chat computer overlay — one OS window beside the existing chat chrome.
 * Reuses AgentComputerShell + DepartmentComputerPane. Bound to the open
 * conversation id so chat A does not show chat B's desktop.
 */

import * as React from "react"

import { AgentComputerShell } from "@/components/code/agent-computer-shell"
import { DepartmentComputerPane } from "@/components/code/department-computer-pane"

export type ChatAgentComputerPanelProps = {
  conversationId: string
  onClose: () => void
}

type LiveStatus = "starting" | "live" | "error" | "idle"

export default function ChatAgentComputerPanel({
  conversationId,
  onClose,
}: ChatAgentComputerPanelProps) {
  const chatId = String(conversationId || "").trim()
  const [liveStatus, setLiveStatus] = React.useState<LiveStatus>("starting")

  return (
    <section
      className="flex h-full min-h-0 w-full flex-col overflow-hidden border-l border-border/40 bg-[#e8e8ea] dark:bg-[#101012]"
      data-testid="chat-agent-computer-panel"
      data-chat-computer-conversation={chatId || undefined}
      aria-label="Computadora"
    >
      <div className="relative min-h-0 min-w-0 flex-1">
        <AgentComputerShell
          conversationId={chatId}
          variant="overlay"
          onClose={onClose}
          liveStatus={liveStatus}
        >
          <DepartmentComputerPane
            departmentName="Computadora"
            departmentId={chatId ? `chat:${chatId}` : "chat"}
            computerRunId={chatId ? `chat-${chatId}` : "chat"}
            conversationId={chatId}
            embedded
            onClose={onClose}
            onStatusChange={setLiveStatus}
          />
        </AgentComputerShell>
      </div>
    </section>
  )
}
