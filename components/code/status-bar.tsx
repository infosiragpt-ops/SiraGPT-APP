"use client"

import * as React from "react"
import { GitBranch, MessageSquare, Monitor, TerminalSquare } from "lucide-react"

import { Button } from "@/components/ui/button"
import { getGitBinding } from "@/lib/code-git-mirror"
import { useCodeWorkspace } from "@/lib/code-workspace-context"
import { cn } from "@/lib/utils"

export type StatusBarProps = {
  terminalOpen: boolean
  onToggleTerminal: () => void
  chatOpen: boolean
  onToggleChat: () => void
  previewActive: boolean
  onShowPreview: () => void
}

export function StatusBar({
  terminalOpen,
  onToggleTerminal,
  chatOpen,
  onToggleChat,
  previewActive,
  onShowPreview,
}: StatusBarProps) {
  const { activeFolder } = useCodeWorkspace()
  const projectName = activeFolder?.name?.trim()
  const linkedToGithub = Boolean(activeFolder?.id && getGitBinding(activeFolder.id))

  return (
    <footer
      className={cn(
        "flex h-6 shrink-0 items-center justify-between gap-2 border-t border-border/40 bg-background/55 px-2 text-[10px] text-muted-foreground backdrop-blur-xl supports-[backdrop-filter]:bg-background/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex shrink-0 items-center gap-1.5" title="Workspace listo">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
          <span className="hidden sm:inline">Listo</span>
        </span>
        {projectName ? (
          <>
            <span className="hidden text-border/70 sm:inline" aria-hidden>
              ·
            </span>
            <span
              className="hidden max-w-[180px] truncate text-foreground/70 sm:inline"
              title={projectName}
            >
              {projectName}
            </span>
          </>
        ) : null}
        {linkedToGithub ? (
          <>
            <span className="hidden text-border/70 md:inline" aria-hidden>
              ·
            </span>
            <span
              className="hidden items-center gap-1 md:inline-flex"
              title="Repositorio de GitHub vinculado"
            >
              <GitBranch className="h-3 w-3" />
              GitHub
            </span>
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <StatusBarToggle
          active={previewActive}
          onClick={onShowPreview}
          icon={<Monitor className="h-3 w-3" />}
          label="Preview"
        />
        <StatusBarToggle
          active={terminalOpen}
          onClick={onToggleTerminal}
          icon={<TerminalSquare className="h-3 w-3" />}
          label="Shell"
          shortcut="⌘J"
        />
        <StatusBarToggle
          active={chatOpen}
          onClick={onToggleChat}
          icon={<MessageSquare className="h-3 w-3" />}
          label="Chat"
          shortcut="⌘L"
        />
      </div>
    </footer>
  )
}

function StatusBarToggle({
  active,
  onClick,
  icon,
  label,
  shortcut,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  shortcut?: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={active}
      className={cn(
        "h-5 gap-1 px-1.5 text-[10px] font-normal",
        active && "bg-muted/80 text-foreground",
      )}
      onClick={onClick}
    >
      {icon}
      {label}
      {shortcut ? (
        <kbd className="ml-0.5 rounded bg-muted px-1 py-px text-[9px]">{shortcut}</kbd>
      ) : null}
    </Button>
  )
}
