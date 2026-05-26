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
 *   - LinkContextDisplay   — chip strip listing detected URLs in input
 *
 * Every prop here is exactly what the original inline declarations
 * expected; do not widen or rename them without updating the call site
 * in `chat-interface-enhanced.tsx`.
 */

import * as React from "react"
import { X, Globe, Link2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type ImageAspectRatio = "1:1" | "2:3" | "3:2" | "3:4" | "9:16" | "4:3" | "16:9"

export type DetectedLink = {
  url: string
  host: string
}

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

export function LinkContextDisplay<L extends DetectedLink>({
  links,
  removeLink,
  isWebSearchActive,
  setIsWebSearchActive,
}: {
  links: L[]
  removeLink: (link: L) => void
  isWebSearchActive: boolean
  setIsWebSearchActive: (value: boolean) => void
}) {
  if (links.length === 0) return null

  return (
    <div className="px-3 pt-3">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-sky-200/70 bg-sky-50/55 px-2.5 py-2 dark:border-sky-500/20 dark:bg-sky-950/20">
        {links.map((link) => (
          <div
            key={link.url}
            className="group/link-chip flex min-w-0 max-w-[220px] items-center gap-1.5 rounded-full border border-sky-200 bg-background/90 px-2 py-1 text-xs text-sky-800 shadow-sm dark:border-sky-500/25 dark:bg-background/70 dark:text-sky-200"
            title={link.url}
          >
            <Link2 className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate font-medium">{link.host}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-4 w-4 shrink-0 rounded-full p-0 text-sky-700/75 hover:bg-sky-100 hover:text-sky-900 dark:text-sky-200/75 dark:hover:bg-sky-900/40 dark:hover:text-sky-100"
              onClick={() => removeLink(link)}
              aria-label={`Quitar enlace ${link.host}`}
              title="Quitar enlace"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ))}
        {!isWebSearchActive && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setIsWebSearchActive(true)}
            className="h-7 rounded-full px-2 text-xs text-sky-800 hover:bg-sky-100 dark:text-sky-200 dark:hover:bg-sky-900/40"
          >
            <Globe className="mr-1.5 h-3.5 w-3.5" />
            Búsqueda web
          </Button>
        )}
      </div>
    </div>
  )
}
