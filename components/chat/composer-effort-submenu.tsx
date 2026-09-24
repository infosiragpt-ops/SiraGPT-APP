"use client"

import * as React from "react"
import { AlertTriangle, Check, ChevronDown, Gauge } from "lucide-react"
import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import {
  COMPOSER_EFFORT_HELP,
  COMPOSER_EFFORT_LEVELS,
  composerEffortLabel,
  normalizeComposerEffort,
} from "@/lib/chat/composer-effort"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

function EffortOptions({
  active,
  setSelectedEffort,
}: {
  active: string
  setSelectedEffort: (effort: string) => void
}) {
  return (
    <>
      <p className="model-effort-help">{COMPOSER_EFFORT_HELP}</p>
      <div role="group" aria-label="Nivel de esfuerzo">
        {COMPOSER_EFFORT_LEVELS.map((level) => {
          const isActive = level.value === active
          return (
            <DropdownMenuItem
              key={level.value}
              role="menuitemradio"
              aria-checked={isActive}
              data-effort-value={level.value}
              data-selected={isActive ? "true" : undefined}
              className={cn("model-effort-option no-default-focus-ring", isActive && "is-active")}
              onSelect={() => setSelectedEffort(level.value)}
            >
              <span className="model-effort-option-label">{level.label}</span>
              {level.isDefault ? <span className="model-effort-badge">Predeterminado</span> : null}
              {level.heavyUsage ? (
                <span className="model-effort-badge is-warning">
                  <AlertTriangle className="h-3 w-3" strokeWidth={2.2} aria-hidden />
                  Mayor uso
                </span>
              ) : null}
              <Check
                className={cn("model-effort-check", !isActive && "invisible")}
                strokeWidth={2.2}
                aria-hidden
              />
            </DropdownMenuItem>
          )
        })}
      </div>
    </>
  )
}

/**
 * "Esfuerzo" row at the foot of the model menu. Opens a submenu with the five
 * levels (Claude-style): short help text, Medio marked as the default, Máx
 * flagged for its higher usage and a check on the active level. On phones a
 * side submenu has no room, so the levels expand inline under the row.
 */
export function ComposerEffortSubmenu({
  selectedEffort,
  setSelectedEffort,
}: {
  selectedEffort: string
  setSelectedEffort: (effort: string) => void
}) {
  const active = normalizeComposerEffort(selectedEffort)
  const isMobile = useIsMobile()
  const [inlineOpen, setInlineOpen] = React.useState(false)
  const rowContent = (
    <>
      <Gauge className="model-picker-effort-trigger-icon" strokeWidth={1.9} aria-hidden />
      <span className="flex-1 text-left">Esfuerzo</span>
      <span className="model-picker-effort-trigger-value" data-testid="composer-effort-value">
        {composerEffortLabel(active)}
      </span>
    </>
  )

  if (isMobile) {
    return (
      <>
        <DropdownMenuItem
          data-testid="composer-effort-trigger"
          aria-label={`Esfuerzo: ${composerEffortLabel(active)}`}
          aria-expanded={inlineOpen}
          data-state={inlineOpen ? "open" : "closed"}
          className="model-picker-effort-trigger no-default-focus-ring"
          onSelect={(event) => {
            event.preventDefault()
            setInlineOpen((open) => !open)
          }}
        >
          {rowContent}
          <ChevronDown
            className={cn("model-picker-effort-trigger-chevron", inlineOpen && "rotate-180")}
            aria-hidden
          />
        </DropdownMenuItem>
        {inlineOpen ? (
          <div data-testid="composer-effort-menu" className="model-effort-inline">
            <EffortOptions active={active} setSelectedEffort={setSelectedEffort} />
          </div>
        ) : null}
      </>
    )
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        data-testid="composer-effort-trigger"
        aria-label={`Esfuerzo: ${composerEffortLabel(active)}`}
        className="model-picker-effort-trigger no-default-focus-ring"
      >
        {rowContent}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent
          sideOffset={6}
          alignOffset={-6}
          collisionPadding={12}
          data-testid="composer-effort-menu"
          className="model-effort-submenu w-[min(calc(100vw-1.5rem),17.5rem)] p-1.5"
        >
          <EffortOptions active={active} setSelectedEffort={setSelectedEffort} />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}
