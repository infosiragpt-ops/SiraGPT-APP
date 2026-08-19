"use client"

import { cn } from "@/lib/utils"

/** Monospace Codex mark — terminal-style "/_" for collapsed sidebar & toolbars. */
export function CodexMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 w-4 items-center justify-center font-mono text-[10px] font-bold leading-none tracking-tight text-current select-none",
        className,
      )}
      aria-hidden
    >
      <span>/</span>
      <span className="-ml-px opacity-80">_</span>
    </span>
  )
}
