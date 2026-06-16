"use client"

/**
 * ComposerInlineDisplays — small presentational sub-components that
 * used to live inline at the top of `chat-interface-enhanced.tsx`.
 *
 * Extracting them here is a pure-refactor: behaviour and styling are
 * preserved verbatim. The motivation is splitting the 8k+ LOC chat
 * shell into smaller compilable units so editors / type-checkers / tree
 * shakers can work with bounded pieces.
 *
 * Components included:
 *   - ImageAspectRatioMark — small visual chip showing 1:1 / 16:9 / …
 *   - SelectedTextDisplay  — "AI Rewrite" callout above the composer
 *
 * Every prop here is exactly what the original inline declarations
 * expected; do not widen or rename them without updating the call site
 * in `chat-interface-enhanced.tsx`.
 */

import * as React from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type ImageAspectRatio = "1:1" | "2:3" | "3:2" | "3:4" | "9:16" | "4:3" | "16:9"

export function ImageAspectRatioMark({
  ratio,
  selected = false,
  className,
}: {
  ratio: ImageAspectRatio
  selected?: boolean
  className?: string
}) {
  const [width, height] = ratio.split(":").map(Number)
  const landscape = width > height
  const portrait = height > width

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-[4px] border border-current/75 bg-background/70",
        landscape ? "h-3 w-5" : portrait ? "h-5 w-3" : "h-4 w-4",
        className
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", selected ? "bg-current" : "bg-current/60")} />
    </span>
  )
}

export const SelectedTextDisplay = ({ text, onClear }: { text: string | null; onClear: () => void }) => {
  if (!text) return null
  return (
    <div className="px-3 pt-3">
      <div className="relative rounded-lg border bg-muted/30 p-3">
        <div className="text-xs font-semibold mb-1 text-muted-foreground">AI Rewrite</div>
        <p className="text-sm pr-8 max-h-24 overflow-y-auto">{text}</p>
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-1 right-1 h-6 w-6 p-0 rounded-full"
          onClick={onClear}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
