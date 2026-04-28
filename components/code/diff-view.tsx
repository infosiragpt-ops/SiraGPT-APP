"use client"

/**
 * DiffView — line-based before/after preview used in two places:
 *
 *   - The chat "Apply" affordance, where the user reviews what would
 *     change before clicking Accept.
 *   - The editor inline preview when applying a chat block on top of
 *     an existing file.
 *
 * We keep this dumb on purpose: it takes already-computed diff lines
 * and renders them with monospace + light row tinting. Computing the
 * diff itself lives in `lib/code-workspace-utils.ts`, so tests can
 * cover that logic without touching React.
 */

import * as React from "react"

import { cn } from "@/lib/utils"
import type { DiffLine } from "@/lib/code-workspace-utils"

export function DiffView({ lines, className }: { lines: DiffLine[]; className?: string }) {
  if (!lines.length) {
    return (
      <div className={cn("p-4 text-sm text-muted-foreground", className)}>
        No hay cambios para mostrar.
      </div>
    )
  }
  return (
    <pre
      className={cn(
        "max-h-[60vh] overflow-auto rounded-md border border-border/60 bg-muted/30 p-2 text-xs leading-relaxed",
        className,
      )}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            "flex gap-3 whitespace-pre-wrap break-words font-mono",
            line.kind === "added" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            line.kind === "removed" && "bg-rose-500/10 text-rose-700 dark:text-rose-300",
            line.kind === "kept" && "text-muted-foreground",
          )}
        >
          <span className="w-10 shrink-0 text-right text-[10px] uppercase tracking-wide opacity-70">
            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
            {line.newNumber ?? line.oldNumber ?? ""}
          </span>
          <span className="min-w-0 flex-1">{line.text || "\u00A0"}</span>
        </div>
      ))}
    </pre>
  )
}
